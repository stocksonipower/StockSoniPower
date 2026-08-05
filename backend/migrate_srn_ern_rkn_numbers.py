"""One-off migration: renumber every note type (RN, SRN, ERN, RKN, IN, PN, STR,
STN) from the old PREFIX/FY/NNN scheme to PREFIX/DDMMYY/NN — the note's own
date plus a serial that runs continuously (never resets, gap-fills on delete).

SRN/ERN/RKN additionally mirror their parent RN's new number (e.g.
RN/050826/01 -> SRN/050826/01), with -B/-C/... suffixes when an RN has more
than one of them. RN, IN, STR, PN, STN each get their own independent
chronological renumbering (creation order); PN's issue_note_no and STN's
transfer_request_no are refreshed to match their parent's new number, but
their own numbering does not mirror the parent (no letter-suffix scheme for
those two).

Cascades to denormalized copies of these numbers (parent_rn_no, source_no,
receipt_note_no, issue_note_no, transfer_request_no, nested child_srn_no,
transactions.racking_note_no) are all resolved by document id, not by
string matching, so they can't mismatch.

Run with no flags first (dry run) — it only prints the plan, no writes.
Pass --apply to actually write the changes.

Usage:
    .venv/bin/python migrate_srn_ern_rkn_numbers.py            # dry run
    .venv/bin/python migrate_srn_ern_rkn_numbers.py --apply    # writes
"""
import os
import sys
import string
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv(Path(__file__).parent / ".env")
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ.get("DB_NAME", "stock_management")

APPLY = "--apply" in sys.argv

client = MongoClient(MONGO_URL)
db = client[DB_NAME]


def ddmmyy(iso_date):
    try:
        d = datetime.fromisoformat(iso_date)
    except Exception:
        d = datetime.now(timezone.utc)
    return d.strftime("%d%m%y")


def next_letter_suffix(used: set) -> str:
    letters = string.ascii_uppercase
    for ch in letters:
        if ch not in used:
            return ch
    for a in letters:
        for b in letters:
            cand = a + b
            if cand not in used:
                return cand
    n = 1
    while str(n) in used:
        n += 1
    return str(n)


def renumber_independent(collection_name, no_field, date_field, prefix):
    """Chronological, continuous renumber for a collection with no parent linkage."""
    docs = list(db[collection_name].find({}, {"_id": 0}).sort("created_at", 1))
    plan = []
    for i, d in enumerate(docs, start=1):
        date_key = ddmmyy(d.get(date_field, ""))
        new_no = f"{prefix}/{date_key}/{i:02d}"
        plan.append({"id": d["id"], "old_no": d.get(no_field), "new_no": new_no, "new_serial": i})
    return plan


def renumber_linked(collection_name, no_field, link_field, prefix, parent_map):
    """Group by link_field -> parent id. First doc in each group mirrors the
    parent's new base number; later docs in the same group append -B, -C, ...
    Internal `serial` is still a plain global chronological counter (kept only
    for the collection's own bookkeeping / index, decoupled from the display
    number)."""
    docs = list(db[collection_name].find({}, {"_id": 0}).sort("created_at", 1))
    serial_by_id = {d["id"]: i for i, d in enumerate(docs, start=1)}

    groups = defaultdict(list)
    for d in docs:
        groups[d.get(link_field)].append(d)

    plan = []
    orphans = []
    for parent_id, group in groups.items():
        parent = parent_map.get(parent_id)
        if not parent:
            orphans.extend(d.get(no_field) for d in group)
            continue
        base_no = f"{prefix}/{parent['date_key']}/{parent['serial']:02d}"
        used = {"A"}
        for i, d in enumerate(group):
            new_no = base_no if i == 0 else f"{base_no}-{next_letter_suffix(used)}"
            if i > 0:
                used.add(new_no.rsplit("-", 1)[-1])
            plan.append({"id": d["id"], "old_no": d.get(no_field), "new_no": new_no, "new_serial": serial_by_id[d["id"]]})
    return plan, orphans


def print_plan(name, plan, limit=15):
    changed = [p for p in plan if p["old_no"] != p["new_no"]]
    print(f"{name}: {len(changed)} of {len(plan)} renamed")
    for p in changed[:limit]:
        print(f"  {p['old_no']!r} -> {p['new_no']!r}")
    if len(changed) > limit:
        print(f"  ... and {len(changed) - limit} more")
    return changed


def main():
    print(f"DB: {DB_NAME}  (dry run: {not APPLY})\n")

    # ---- independent collections (own chronological serial) ----
    rn_plan = renumber_independent("receipt_notes", "rn_no", "rn_date", "RN")
    in_plan = renumber_independent("issue_notes", "in_no", "in_date", "IN")
    str_plan = renumber_independent("transfer_requests", "str_no", "str_date", "STR")
    pn_plan = renumber_independent("picking_notes", "pn_no", "pn_date", "PN")
    stn_plan = renumber_independent("transfer_notes", "stn_no", "stn_date", "STN")

    rn_map = {p["id"]: {"date_key": p["new_no"].split("/")[1], "serial": p["new_serial"], "new_no": p["new_no"]} for p in rn_plan}
    in_by_id = {p["id"]: p["new_no"] for p in in_plan}
    str_by_id = {p["id"]: p["new_no"] for p in str_plan}

    # ---- linked-to-RN collections (mirror parent RN's new number) ----
    srn_plan, srn_orphans = renumber_linked("short_received_notes", "srn_no", "parent_rn_id", "SRN", rn_map)
    ern_plan, ern_orphans = renumber_linked("extra_received_notes", "ern_no", "parent_rn_id", "ERN", rn_map)
    rkn_plan, rkn_orphans = renumber_linked("racking_notes", "rkn_no", "receipt_note_id", "RKN", rn_map)

    srn_by_id = {p["id"]: p["new_no"] for p in srn_plan}
    ern_by_id = {p["id"]: p["new_no"] for p in ern_plan}
    rkn_by_id = {p["id"]: p["new_no"] for p in rkn_plan}

    changed_rn = print_plan("RN", rn_plan)
    changed_srn = print_plan("SRN", srn_plan)
    changed_ern = print_plan("ERN", ern_plan)
    changed_rkn = print_plan("RKN", rkn_plan)
    changed_in = print_plan("IN", in_plan)
    changed_pn = print_plan("PN", pn_plan)
    changed_str = print_plan("STR", str_plan)
    changed_stn = print_plan("STN", stn_plan)

    for name, orphans in (("SRN", srn_orphans), ("ERN", ern_orphans), ("RKN", rkn_orphans)):
        if orphans:
            print(f"WARNING: {len(orphans)} {name} docs have no resolvable parent RN (left untouched): {orphans[:10]}")

    print(f"\nCascades (id-resolved, not printed individually):")
    print(f"  short_received_notes.parent_rn_no / parent_srn_no")
    print(f"  extra_received_notes.parent_rn_no / parent_ern_no")
    print(f"  racking_notes.receipt_note_no / source_no")
    print(f"  picking_notes.issue_note_no")
    print(f"  transfer_notes.transfer_request_no")
    print(f"  transactions.racking_note_no")
    print(f"  short_received_notes.items[].children[].child_srn_no (own doc's new srn_no)")

    if not APPLY:
        print("\nDry run only — no writes made. Re-run with --apply to write these changes.")
        return

    # ---- apply base renumbers ----
    for coll, no_field, plan in (
        ("receipt_notes", "rn_no", rn_plan),
        ("issue_notes", "in_no", in_plan),
        ("transfer_requests", "str_no", str_plan),
        ("short_received_notes", "srn_no", srn_plan),
        ("extra_received_notes", "ern_no", ern_plan),
        ("racking_notes", "rkn_no", rkn_plan),
        ("picking_notes", "pn_no", pn_plan),
        ("transfer_notes", "stn_no", stn_plan),
    ):
        for p in plan:
            db[coll].update_one({"id": p["id"]}, {"$set": {no_field: p["new_no"], "serial": p["new_serial"]}})

    # ---- cascades ----
    for srn in db.short_received_notes.find({}, {"_id": 0, "id": 1, "parent_rn_id": 1, "parent_srn_id": 1, "items": 1}):
        updates = {}
        rn = rn_map.get(srn.get("parent_rn_id"))
        if rn:
            updates["parent_rn_no"] = rn["new_no"]
        if srn.get("parent_srn_id") in srn_by_id:
            updates["parent_srn_no"] = srn_by_id[srn["parent_srn_id"]]
        new_srn_no = srn_by_id.get(srn["id"])
        items = srn.get("items") or []
        items_changed = False
        if new_srn_no:
            for it in items:
                for c in it.get("children", []) or []:
                    old_child = c.get("child_srn_no", "")
                    suf = old_child.rsplit("-", 1)[-1] if "-" in old_child else None
                    new_child = f"{new_srn_no}-{suf}" if suf else new_srn_no
                    if new_child != old_child:
                        c["child_srn_no"] = new_child
                        items_changed = True
        if items_changed:
            updates["items"] = items
        if updates:
            db.short_received_notes.update_one({"id": srn["id"]}, {"$set": updates})

    for ern in db.extra_received_notes.find({}, {"_id": 0, "id": 1, "parent_rn_id": 1, "parent_ern_id": 1}):
        updates = {}
        rn = rn_map.get(ern.get("parent_rn_id"))
        if rn:
            updates["parent_rn_no"] = rn["new_no"]
        if ern.get("parent_ern_id") in ern_by_id:
            updates["parent_ern_no"] = ern_by_id[ern["parent_ern_id"]]
        if updates:
            db.extra_received_notes.update_one({"id": ern["id"]}, {"$set": updates})

    for rkn in db.racking_notes.find({}, {"_id": 0, "id": 1, "receipt_note_id": 1, "source_type": 1, "source_id": 1}):
        updates = {}
        rn = rn_map.get(rkn.get("receipt_note_id"))
        if rn:
            updates["receipt_note_no"] = rn["new_no"]
        st = (rkn.get("source_type") or "").upper()
        sid = rkn.get("source_id")
        if st == "RN" and sid in rn_map:
            updates["source_no"] = rn_map[sid]["new_no"]
        elif st == "SRN" and sid in srn_by_id:
            updates["source_no"] = srn_by_id[sid]
        elif st == "ERN" and sid in ern_by_id:
            updates["source_no"] = ern_by_id[sid]
        if updates:
            db.racking_notes.update_one({"id": rkn["id"]}, {"$set": updates})

    for pn in db.picking_notes.find({}, {"_id": 0, "id": 1, "issue_note_id": 1}):
        no = in_by_id.get(pn.get("issue_note_id"))
        if no:
            db.picking_notes.update_one({"id": pn["id"]}, {"$set": {"issue_note_no": no}})

    for stn in db.transfer_notes.find({}, {"_id": 0, "id": 1, "transfer_request_id": 1}):
        no = str_by_id.get(stn.get("transfer_request_id"))
        if no:
            db.transfer_notes.update_one({"id": stn["id"]}, {"$set": {"transfer_request_no": no}})

    for rkn_id, new_no in rkn_by_id.items():
        db.transactions.update_many({"racking_note_id": rkn_id}, {"$set": {"racking_note_no": new_no}})

    print("Done.")


if __name__ == "__main__":
    main()
