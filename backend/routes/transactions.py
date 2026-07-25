from fastapi import APIRouter, Depends, Query, Response
from typing import Optional

from deps import db, get_current_user
from helpers.stock_helpers import _enrich_items

router = APIRouter()


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
        response.headers["X-Total-Count"] = str(total)
        response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
        return rows
    skip = (page - 1) * page_size
    rows = await db.transactions.find(query, {"_id": 0}).sort(sort_spec).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_items(rows)
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows
