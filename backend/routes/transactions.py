from fastapi import APIRouter, Depends, Query, Response
from typing import Optional

from deps import db, get_current_user, _display_name
from helpers.stock_helpers import _enrich_items

router = APIRouter()


async def _enrich_created_by_name(rows: list) -> None:
    """Add `created_by_name` — who recorded the transaction, by NAME.

    The ledger stores `created_by` as the actor's email because that is the stable
    identifier at write time (a user can be renamed afterwards, and the row must
    still point at the right person). It is not what anyone should READ, though —
    so the name is resolved here, once per page, from the users collection.

    Users deleted since the transaction was written keep a name derived from the
    stored address rather than falling back to the address itself (see
    `_display_name`), so the ledger never displays an email.
    """
    if not rows:
        return
    emails = sorted({(r.get("created_by") or "").strip() for r in rows if r.get("created_by")})
    by_email = {}
    if emails:
        async for u in db.users.find(
            {"email": {"$in": emails}}, {"_id": 0, "name": 1, "email": 1},
        ):
            by_email[u.get("email")] = _display_name(u)
    for r in rows:
        email = (r.get("created_by") or "").strip()
        r["created_by_name"] = by_email.get(email) or _display_name({"email": email})


@router.get("/transactions")
async def list_transactions(
    response: Response,
    limit: Optional[int] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(10000, ge=1, le=10000),
    type: Optional[str] = None,
    user=Depends(get_current_user),
):
    query = {}
    if type:
        query["type"] = type.upper()
    total = await db.transactions.count_documents(query)
    # Sort on (created_at, _id): several transactions can share the exact same
    # created_at (e.g. every OUT+IN pair from one Transfer Note completion is
    # stamped with a single `now`), and MongoDB does not guarantee any particular
    # order among ties. `_id` (ObjectId) encodes true insertion order and is always
    # present, so adding it as a tiebreaker makes ordering — and therefore
    # pagination — fully deterministic across repeated requests/refreshes.
    sort_spec = [("created_at", -1), ("_id", -1)]
    # Backward compat: if `limit` query param is provided, return first `limit` rows (no pagination headers consumer needed)
    if limit is not None and limit > 0:
        rows = await db.transactions.find(query, {"_id": 0}).sort(sort_spec).to_list(limit)
        await _enrich_items(rows)
        await _enrich_created_by_name(rows)
        response.headers["X-Total-Count"] = str(total)
        response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
        return rows
    skip = (page - 1) * page_size
    rows = await db.transactions.find(query, {"_id": 0}).sort(sort_spec).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_items(rows)
    await _enrich_created_by_name(rows)
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows
