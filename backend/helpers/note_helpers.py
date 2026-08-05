from datetime import datetime, timezone, timedelta
from typing import Optional
from fastapi import HTTPException
from deps import db


def current_fy_label(d: datetime) -> str:
    """Indian financial year label, e.g. 2026-04-15 -> '26-27'.

    No longer used to build note numbers (see `note_date_key`) — kept only
    because every note doc still stores an `fy` field for backward
    compatibility with the existing (fy, serial) unique indexes.
    """
    if d.month >= 4:
        start, end = d.year, d.year + 1
    else:
        start, end = d.year - 1, d.year
    return f"{start % 100:02d}-{end % 100:02d}"


def note_date_key(d: datetime) -> str:
    """DDMMYY date component embedded in note numbers, e.g. 2026-08-05 -> '050826'."""
    return d.strftime("%d%m%y")


def note_date_key_from_iso(iso_date: str) -> str:
    """Same as `note_date_key` but from an already-stored ISO 'YYYY-MM-DD' string,
    falling back to today (UTC) if the value is missing or unparseable."""
    try:
        d = datetime.fromisoformat(iso_date)
    except Exception:
        d = datetime.now(timezone.utc)
    return note_date_key(d)


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


async def _next_serial(collection: str, session=None) -> int:
    """Next serial for a collection, derived from documents that currently
    exist rather than a persistent ever-incrementing counter: max(serial)
    among surviving docs, +1 — or 1 when none remain. A deleted note's
    number becomes available again. The series runs continuously across all
    time — it no longer resets by financial year — since the note's own
    date, not its series, is what's embedded in the display number now.

    Callers must retry on DuplicateKeyError (a concurrent create can claim
    the same number first) — every call site below already loops for that.
    """
    last = await db[collection].find(
        {}, {"serial": 1, "_id": 0}, session=session
    ).sort("serial", -1).limit(1).to_list(1)
    return (last[0]["serial"] if last else 0) + 1


async def _linked_note_no(collection: str, no_field: str, link_field: str, link_value: str,
                           prefix: str, rn_date_key: str, rn_serial: int, session=None) -> str:
    """Number a document that belongs to a specific RN, mirroring the RN's own
    number instead of a series of its own: the first SRN/ERN/RKN raised
    against RN/050826/01 is numbered SRN(or ERN/RKN)/050826/01. A given RN can
    legitimately produce more than one of these over its lifecycle (a residual
    SRN chain, a second racking pass), so later ones append -B, -C, ... to stay
    unique while still reading as belonging to that RN.
    """
    base_no = f"{prefix}/{rn_date_key}/{rn_serial:02d}"
    existing = await db[collection].find(
        {link_field: link_value}, {no_field: 1, "_id": 0}, session=session
    ).to_list(1000)
    if not existing:
        return base_no
    used = {"A"}  # the bare number already occupies the implicit first slot
    for e in existing:
        tail = (e.get(no_field) or "").rsplit("/", 1)[-1]
        if "-" in tail:
            used.add(tail.split("-", 1)[1])
    return f"{base_no}-{_next_letter_suffix(used)}"


def _key(p, m):
    return f"{(p or '').strip()}||{(m or '').strip()}"


def _ern_rackable_qty(item: dict) -> float:
    """Rackable quantity for one ERN row.

    The Store Manager may approve only part of an overage, in which case
    `approved_qty` is the figure that becomes warehouse work and the rejected
    remainder never enters stock. Rows decided before per-item splitting existed
    (and rows on a not-yet-decided note) carry no `approved_qty`, so they fall back
    to the full `extra_qty` — the whole-note meaning this always had.

    Callers must still gate on the note's status; this only answers "how much".
    """
    approved = item.get("approved_qty")
    if approved is not None:
        return float(approved or 0)
    return float(item.get("extra_qty") or 0)


def _ern_rackable_by_key(ern: dict) -> dict:
    """Per-(part, make) rackable quantity across an ERN, honouring partial approval."""
    out: dict = {}
    for it in ern.get("items") or []:
        k = _key(it.get("part_no"), it.get("make"))
        out[k] = out.get(k, 0.0) + _ern_rackable_qty(it)
    return out


def _srn_rackable_qty(item: dict) -> float:
    """Rackable quantity for one SRN row: sum of child deliveries' received_qty,
    or the legacy bulk `fulfilled_qty` when the row has no children."""
    children = item.get("children") or []
    if children:
        return sum(float(c.get("received_qty") or 0) for c in children)
    return float(item.get("fulfilled_qty") or 0)


def _srn_rackable_by_key(srn: dict) -> dict:
    """Per-(part, make) rackable quantity across an SRN."""
    out: dict = {}
    for it in srn.get("items") or []:
        k = _key(it.get("part_no"), it.get("make"))
        out[k] = out.get(k, 0.0) + _srn_rackable_qty(it)
    return out


def _next_letter_suffix(used: set) -> str:
    """Return the next unused suffix for a child SRN/ERN row: A..Z, then AA..ZZ,
    then an unbounded numeric fallback (27, 28, ...). Lot count is never capped —
    once the letter space (702 slices) is exhausted, numbering just keeps going."""
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
    n = 1
    while str(n) in used:
        n += 1
    return str(n)


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
