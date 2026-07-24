from datetime import datetime, timezone, timedelta
from typing import Optional
from pymongo import ReturnDocument
from fastapi import HTTPException
from deps import db


def current_fy_label(d: datetime) -> str:
    """Indian financial year label, e.g. 2026-04-15 -> '26-27'."""
    if d.month >= 4:
        start, end = d.year, d.year + 1
    else:
        start, end = d.year - 1, d.year
    return f"{start % 100:02d}-{end % 100:02d}"


def _no_future_date(value: str, field_label: str):
    """Raise 400 if the ISO date string is after today. Empty/None passes.

    The server clock is UTC, but users enter dates in their local timezone (e.g. IST
    is UTC+5:30 — a user typing today's local date right after midnight is "tomorrow"
    in UTC). To accept any valid local-today entry without admitting truly future
    dates, we allow up to +1 day past UTC today (covers all timezones up to UTC+24).
    """
    if not value:
        return
    try:
        d = datetime.fromisoformat(value).date()
    except Exception:
        raise HTTPException(status_code=400, detail=f"{field_label}: invalid date format")
    max_allowed = datetime.now(timezone.utc).date() + timedelta(days=1)
    if d > max_allowed:
        raise HTTPException(status_code=400, detail=f"{field_label} cannot be in the future")


async def _alloc_serial(series: str, fy: str) -> int:
    """Atomically allocate the next serial number for a given series + FY.

    Uses a `counters` collection where each (series, fy) pair has a single
    document. `find_one_and_update` with $inc and upsert=True is atomic at the
    document level — concurrent callers get distinct, monotonically increasing
    serials with no retry loop and no race window.

    `series` is one of: rn, rkn, srn, ern, in, pn, str, stn
    """
    key = f"{series}:{fy}"
    res = await db.counters.find_one_and_update(
        {"_id": key},
        {"$inc": {"value": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    return int(res["value"])


def _key(p, m):
    return f"{(p or '').strip()}||{(m or '').strip()}"


def _next_letter_suffix(used: set) -> str:
    """Return the next alphabetical suffix not in `used` (A..Z, AA..AZ, BA.. ZZ)."""
    import string
    letters = string.ascii_uppercase
    for ch in letters:
        if ch not in used:
            return ch
    for a in letters:
        for b in letters:
            cand = a + b
            if cand not in used:
                return cand
    raise HTTPException(status_code=409, detail="Cannot allocate child suffix — too many children")


def _qty_diff(it: dict) -> float:
    """received_qty - invoice_qty. Positive = extra, negative = short, 0 = exact."""
    inv = float(it.get("invoice_qty") or 0)
    rec = float(it.get("received_qty") or 0)
    return rec - inv


def _rn_items_have_all_received(items: list) -> bool:
    """True iff every row has a numeric, > 0 received_qty."""
    if not items:
        return False
    for it in items:
        rq = it.get("received_qty")
        if rq is None or rq == "":
            return False
        try:
            if float(rq) <= 0:
                return False
        except Exception:
            return False
    return True
