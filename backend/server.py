import os
import uuid
import logging
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict, Any

import bcrypt
import jwt
import pandas as pd
from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, UploadFile, File, Query, Response, Header
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ReturnDocument
from pydantic import BaseModel, Field, EmailStr, ConfigDict

from storage import init_storage, put_object, get_object, build_path

# Shared infrastructure (db, auth deps, helpers) — extracted for modularity (zero logic change)
from deps import (
    ROOT_DIR,
    db,
    client,
    JWT_SECRET, JWT_ALGORITHM, bearer_scheme,
    logger,
    APP_MODULES,
    hash_password, verify_password, create_access_token,
    get_current_user, require_admin, _module_dep,
    now_iso,
    NOTIFICATION_AUDIENCES, _notify,
    _resolve_assignee, _enforce_assignee,
)

# All Pydantic models live in models.py (extracted; zero logic change)
from models import *  # noqa: F401,F403

# Helpers needed by startup migration
from helpers.status_helpers import _recompute_rn_status, _compute_srn_status, _compute_ern_status


# -------------------- APP SETUP --------------------
app = FastAPI(title="Stock Management API")
api_router = APIRouter(prefix="/api")

# Auth, Users, Notifications routes extracted to /routes (zero logic changes)
from routes import auth as _auth_routes
from routes import users as _users_routes
from routes import notifications as _notifications_routes
api_router.include_router(_auth_routes.router)
api_router.include_router(_users_routes.router)
api_router.include_router(_notifications_routes.router)
from routes import dashboard as _dashboard_routes
from routes import item_details as _item_details_routes
api_router.include_router(_dashboard_routes.router)
api_router.include_router(_item_details_routes.router)
from routes import uploads as _uploads_routes
api_router.include_router(_uploads_routes.router)
from routes import locations as _locations_routes
api_router.include_router(_locations_routes.router)
from routes import stock_master as _stock_master_routes
api_router.include_router(_stock_master_routes.router)

# New modular routes
from routes import stock_in as _stock_in_routes
from routes import stock_out as _stock_out_routes
from routes import transfer as _transfer_routes
from routes import transactions as _transactions_routes
api_router.include_router(_stock_in_routes.router)
api_router.include_router(_stock_out_routes.router)
api_router.include_router(_transfer_routes.router)
api_router.include_router(_transactions_routes.router)


# -------------------- STARTUP --------------------
@app.on_event("startup")
async def startup():
    # Initialise object storage (best-effort — log only, do not fail boot)
    try:
        init_storage()
    except Exception as e:
        logger.error(f"Object storage init failed: {e}")
    await db.users.create_index("email", unique=True)
    await db.stock_master.create_index([("part_no", 1), ("make", 1)], unique=True)
    await db.stock_master.create_index("id", unique=True)
    await db.stock_master.create_index("make")
    await db.stock_master.create_index("model")
    await db.stock_master.create_index("description_1")
    await db.stock_master.create_index("description_2")
    await db.stock_master.create_index("item_category")
    await db.stock_master.create_index("unit")
    await db.stock_master.create_index("reorder_level")
    await db.stock_master.create_index("created_at")
    await db.godowns.create_index("id", unique=True)
    await db.racks.create_index("id", unique=True)
    await db.boxes.create_index("id", unique=True)
    await db.transactions.create_index("id", unique=True)
    await db.transactions.create_index([("part_no", 1), ("make", 1)])
    await db.receipt_notes.create_index("id", unique=True)
    await db.receipt_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.receipt_notes.create_index("created_at")
    await db.receipt_notes.create_index("status")
    await db.racking_notes.create_index("id", unique=True)
    await db.racking_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.racking_notes.create_index("created_at")
    await db.racking_notes.create_index("status")
    await db.racking_notes.create_index("receipt_note_id")
    await db.issue_notes.create_index("id", unique=True)
    await db.issue_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.issue_notes.create_index("created_at")
    await db.issue_notes.create_index("status")
    await db.picking_notes.create_index("id", unique=True)
    await db.picking_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.picking_notes.create_index("created_at")
    await db.picking_notes.create_index("status")
    await db.picking_notes.create_index("issue_note_id")
    await db.transfer_requests.create_index("id", unique=True)
    await db.transfer_requests.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.transfer_requests.create_index("created_at")
    await db.transfer_requests.create_index("status")
    await db.transfer_notes.create_index("id", unique=True)
    await db.transfer_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.transfer_notes.create_index("created_at")
    await db.transfer_notes.create_index("status")
    await db.transfer_notes.create_index("transfer_request_id")
   # ---- Receipt-note status migration ----
    # Default missing status to RACKING_NOTE_DRAFT (the new equivalent of legacy FINAL/RACKING_PENDING).
    await db.receipt_notes.update_many({"status": {"$exists": False}}, {"$set": {"status": "RACKING_NOTE_DRAFT"}})
    # Legacy values -> new names
    await db.receipt_notes.update_many({"status": "RACKED"}, {"$set": {"status": "FULLY_RACKED"}})
    await db.receipt_notes.update_many({"status": "RACKING_PENDING"}, {"$set": {"status": "RACKING_NOTE_DRAFT"}})
    await db.receipt_notes.update_many({"status": "FINAL"}, {"$set": {"status": "RACKING_NOTE_DRAFT"}})

    # ---- Receipt-note item-shape migration (Phase 1) ----
    # Older items had a single `quantity`. New items split it into invoice_qty + received_qty.
    # Migration policy: invoice_qty = received_qty = legacy quantity (no implied shortfall).
    async for rn in db.receipt_notes.find({}, {"_id": 0, "id": 1, "items": 1}):
        items = rn.get("items") or []
        if not items:
            continue
        changed = False
        new_items = []
        for it in items:
            new_it = dict(it)
            if "invoice_qty" not in new_it or new_it.get("invoice_qty") is None:
                q = float(new_it.get("quantity") or 0)
                new_it["invoice_qty"] = q
                changed = True
            if "received_qty" not in new_it:
                # Legacy rows had no draft concept — treat as fully received.
                new_it["received_qty"] = float(new_it.get("quantity") or 0)
                changed = True
            # Ensure legacy `quantity` mirrors received_qty so racking still works.
            if new_it.get("quantity") in (None, 0) and new_it.get("received_qty") is not None:
                new_it["quantity"] = float(new_it["received_qty"])
                changed = True
            new_items.append(new_it)
        if changed:
            await db.receipt_notes.update_one({"id": rn["id"]}, {"$set": {"items": new_items}})

    # Recompute every RN's status off saved racking notes (idempotent — skips DRAFT)
    async for rn in db.receipt_notes.find({}, {"_id": 0, "id": 1}):
        try:
            await _recompute_rn_status(rn["id"])
        except Exception:
            pass

    # ---- SRN / ERN collection indexes (Phase 1 + Phase 2) ----
    await db.short_received_notes.create_index("id", unique=True)
    await db.short_received_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.short_received_notes.create_index("created_at")
    await db.short_received_notes.create_index("status")
    await db.short_received_notes.create_index("parent_rn_id")
    await db.short_received_notes.create_index("parent_srn_id")
    await db.extra_received_notes.create_index("id", unique=True)
    await db.extra_received_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.extra_received_notes.create_index("created_at")
    await db.extra_received_notes.create_index("status")
    await db.extra_received_notes.create_index("parent_rn_id")
    await db.extra_received_notes.create_index("parent_ern_id")

    # ---- Stock Master column settings (admin-editable order/widths) ----
    await db.column_settings.create_index("page", unique=True)

    # ---- Phase 2: counters self-heal ----
    # `_alloc_serial` reads/writes `db.counters` keyed by "{series}:{fy}". On first deploy after
    # the switch from `_next_serial`, scan each FY-numbered collection for max(serial) per fy
    # and seed the counter to that value (so subsequent allocations don't collide with existing
    # serials). Idempotent and safe to run on every startup.
    # Note: db.counters uses _id as the key — MongoDB auto-creates a unique index on _id.
    SERIES_TO_COLL = {
        "rn":  db.receipt_notes,
        "rkn": db.racking_notes,
        "srn": db.short_received_notes,
        "ern": db.extra_received_notes,
        "in":  db.issue_notes,
        "pn":  db.picking_notes,
        "str": db.transfer_requests,
        "stn": db.transfer_notes,
    }
    for series, coll in SERIES_TO_COLL.items():
        async for row in coll.aggregate([
            {"$group": {"_id": "$fy", "max_serial": {"$max": "$serial"}}},
        ]):
            fy = row["_id"]
            if not fy:
                continue
            max_serial = int(row.get("max_serial") or 0)
            counter_id = f"{series}:{fy}"
            existing = await db.counters.find_one({"_id": counter_id})
            if existing is None:
                await db.counters.insert_one({"_id": counter_id, "value": max_serial})
            elif int(existing.get("value", 0)) < max_serial:
                await db.counters.update_one({"_id": counter_id}, {"$set": {"value": max_serial}})

    # ---- Phase 2: RN stock_in_type backfill ----
    # Older receipt notes have no stock_in_type field. Default existing rows to "INVOICE"
    # (the prior behaviour was always invoice-based).
    await db.receipt_notes.update_many({"stock_in_type": {"$exists": False}}, {"$set": {"stock_in_type": "INVOICE"}})

    # ---- Phase 2: RN item.description_1 backfill (denormalize from stock_master) ----
    # New items carry description_1 inline (read-only display). Backfill from stock_master
    # for any item that doesn't already have it.
    async for rn in db.receipt_notes.find(
        {"items.description_1": {"$exists": False}},
        {"_id": 0, "id": 1, "items": 1},
    ):
        items = rn.get("items") or []
        new_items = []
        changed = False
        for it in items:
            if it.get("description_1") is None or "description_1" not in it:
                sm = await db.stock_master.find_one(
                    {"part_no": it.get("part_no"), "make": it.get("make")},
                    {"_id": 0, "description_1": 1},
                )
                it = dict(it)
                it["description_1"] = (sm or {}).get("description_1", "") or ""
                changed = True
            new_items.append(it)
        if changed:
            await db.receipt_notes.update_one({"id": rn["id"]}, {"$set": {"items": new_items}})

    # ---- Phase 2: racking_notes polymorphic source backfill ----
    # Existing racking_notes rows have only receipt_note_id. Set source_type="RN" + source_id=receipt_note_id
    # so the new polymorphic endpoints work uniformly.
    async for rkn in db.racking_notes.find({"source_type": {"$exists": False}}, {"_id": 0, "id": 1, "receipt_note_id": 1, "receipt_note_no": 1, "receipt_note_date": 1}):
        await db.racking_notes.update_one(
            {"id": rkn["id"]},
            {"$set": {
                "source_type": "RN",
                "source_id": rkn.get("receipt_note_id", ""),
                "source_no": rkn.get("receipt_note_no", ""),
                "source_date": rkn.get("receipt_note_date", ""),
            }},
        )
    await db.racking_notes.create_index([("source_type", 1), ("source_id", 1)])

    # ---- Drop legacy racking_status indexes (now derived) ----
    for coll in (db.short_received_notes, db.extra_received_notes):
        try:
            await coll.drop_index("racking_status_1")
        except Exception:
            pass

    # ---- SRN/ERN status migration to active 12-status set ----
    # Backfill parent_stock_in_type for legacy SRN/ERN documents (new docs get it on insert)
    for coll_name in ("short_received_notes", "extra_received_notes"):
        coll = getattr(db, coll_name)
        cursor = coll.find({"parent_stock_in_type": {"$exists": False}}, {"_id": 0, "id": 1, "parent_rn_id": 1})
        async for doc in cursor:
            rn = await db.receipt_notes.find_one({"id": doc.get("parent_rn_id")}, {"_id": 0, "stock_in_type": 1})
            sit = (rn or {}).get("stock_in_type", "") or ""
            await coll.update_one({"id": doc["id"]}, {"$set": {"parent_stock_in_type": sit}})
    # New active values:
    #   SRN: PENDING / PARTIALLY_RECEIVED / COMPLETE
    #   ERN: PENDING / PARTIALLY_ACCEPTED / COMPLETE
    # Drop legacy racking_status entirely (now derived at runtime).
    await db.short_received_notes.update_many({"status": "DRAFT"}, {"$set": {"status": "PENDING"}})
    await db.short_received_notes.update_many({"status": "FINAL"}, {"$set": {"status": "PENDING"}})
    await db.short_received_notes.update_many({"status": "FULLY_RECEIVED"}, {"$set": {"status": "COMPLETE"}})
    await db.short_received_notes.update_many({}, {"$unset": {"racking_status": "", "racked_at": ""}})
    await db.extra_received_notes.update_many({"status": "DRAFT"}, {"$set": {"status": "PENDING"}})
    await db.extra_received_notes.update_many({"status": "FINAL"}, {"$set": {"status": "PENDING"}})
    await db.extra_received_notes.update_many({"status": "PARTIALLY_REJECTED"}, {"$set": {"status": "PARTIALLY_ACCEPTED"}})
    await db.extra_received_notes.update_many({}, {"$unset": {"racking_status": "", "racked_at": ""}})

    # Recompute SRN/ERN derived statuses on startup so any data loaded with old shapes is consistent.
    async for srn in db.short_received_notes.find({}, {"_id": 0}):
        try:
            new_status = _compute_srn_status(srn)
            if srn.get("status") != new_status:
                await db.short_received_notes.update_one({"id": srn["id"]}, {"$set": {"status": new_status}})
        except Exception:
            pass
    async for ern in db.extra_received_notes.find({}, {"_id": 0}):
        try:
            new_status = _compute_ern_status(ern)
            if ern.get("status") != new_status:
                await db.extra_received_notes.update_one({"id": ern["id"]}, {"$set": {"status": new_status}})
        except Exception:
            pass
    # Migrate Stock Master schema: oem→remarks_oem, remarks→remarks_others
    cursor = db.stock_master.find({"$or": [{"oem": {"$exists": True}}, {"remarks": {"$exists": True}}]})
    migrated = 0
    async for doc in cursor:
        upd, unset = {}, {}
        if "oem" in doc:
            if not doc.get("remarks_oem"):
                upd["remarks_oem"] = doc.get("oem", "") or ""
            unset["oem"] = ""
        if "remarks" in doc:
            if not doc.get("remarks_others"):
                upd["remarks_others"] = doc.get("remarks", "") or ""
            unset["remarks"] = ""
        if upd or unset:
            op = {}
            if upd: op["$set"] = upd
            if unset: op["$unset"] = unset
            await db.stock_master.update_one({"_id": doc["_id"]}, op)
            migrated += 1
    if migrated:
        logger.info(f"Migrated {migrated} stock_master docs to new schema")

    # Seed admin
    admin_email = os.environ.get("ADMIN_EMAIL", "admin@stockmgmt.com").lower()
    admin_password = os.environ.get("ADMIN_PASSWORD", "admin123")
    existing = await db.users.find_one({"email": admin_email})
    if not existing:
        await db.users.insert_one({
            "id": str(uuid.uuid4()),
            "email": admin_email,
            "name": "Admin",
            "password_hash": hash_password(admin_password),
            "role": "admin",
            "is_active": True,
            "module_access": {m: True for m in APP_MODULES},
            "force_password_reset": False,
            "failed_login_attempts": 0,
            "created_at": now_iso(),
        })
        logger.info(f"Seeded admin user: {admin_email}")
    elif not verify_password(admin_password, existing["password_hash"]):
        await db.users.update_one({"email": admin_email}, {"$set": {"password_hash": hash_password(admin_password)}})
    # Backfill new fields on every user doc
    await db.users.update_many({"is_active": {"$exists": False}}, {"$set": {"is_active": True}})
    await db.users.update_many({"role": "user"}, {"$set": {"role": "staff"}})
    await db.users.update_many({"module_access": {"$exists": False}}, {"$set": {"module_access": {m: True for m in APP_MODULES}}})
    # Backfill any newly-added module key onto existing user docs (default-allow)
    for _m in APP_MODULES:
        await db.users.update_many(
            {f"module_access.{_m}": {"$exists": False}},
            {"$set": {f"module_access.{_m}": True}},
        )
    await db.users.update_many({"force_password_reset": {"$exists": False}}, {"$set": {"force_password_reset": False}})
    await db.users.update_many({"failed_login_attempts": {"$exists": False}}, {"$set": {"failed_login_attempts": 0}})
    await db.users.create_index("id", unique=True)
    await db.users.create_index("email", unique=True)


@app.on_event("shutdown")
async def shutdown():
    client.close()

# -------------------- SECURITY & MIDDLEWARE --------------------

# The Rulebook: Maps URL prefixes to module permissions
PATH_TO_MODULE = [
    ("/api/stock-master", "stock_master"),
    ("/api/godowns", "locations"),
    ("/api/racks", "locations"),
    ("/api/boxes", "locations"),
    ("/api/stock-in", "stock_in"),
    ("/api/receipt-notes", "stock_in"),
    ("/api/racking-notes", "stock_in"),
    ("/api/stock-out", "stock_out"),
    ("/api/issue-notes", "stock_out"),
    ("/api/picking-notes", "stock_out"),
    ("/api/transfer-requests", "stock_transfer"),
    ("/api/transfer-notes", "stock_transfer"),
    ("/api/stock-balance", "stock_summary"),
    ("/api/low-stock", "low_stock"),
    ("/api/item-details", "item_details"),
    ("/api/transactions", "transactions"),
    ("/api/short-received-notes", "stock_in"),
    ("/api/extra-received-notes", "stock_in"),
]

@app.middleware("http")
async def module_access_middleware(request, call_next):
    path = request.url.path
    matched = next((m for prefix, m in PATH_TO_MODULE if path.startswith(prefix)), None)
    if matched:
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            try:
                payload = jwt.decode(auth.split(" ", 1)[1], JWT_SECRET, algorithms=[JWT_ALGORITHM])
                u = await db.users.find_one({"id": payload.get("sub")}, {"_id": 0, "role": 1, "module_access": 1, "is_active": 1})
                if u and u.get("is_active") is not False and u.get("role") != "admin":
                    access = u.get("module_access") or {}
                    if access.get(matched, True) is False:
                        from starlette.responses import JSONResponse as _JSON
                        return _JSON(status_code=403, content={"detail": f"Access denied: '{matched}' module is disabled for your account"})
            except Exception:
                pass
    return await call_next(request)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

# CRITICAL: This MUST be the very last line of the file
app.include_router(api_router)
