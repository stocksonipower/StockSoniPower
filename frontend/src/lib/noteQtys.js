/* ---------------------------------------------------------------------------
   The five quantities of an execution note — shared verbatim by Stock Out
   (Issue Note -> Picking Note) and Transfer (Transfer Request -> Transfer Note),
   because the arithmetic is identical and the two modules must never be able to
   drift apart. This is the browser-side twin of `note_qty_totals` in
   backend/helpers/note_helpers.py; the two are kept in step deliberately so the
   form, the lists, the detail dialogs, the print previews, the printed sheets
   and the API can never show different numbers for the same note.

   Only two of the five are ever entered — Picked/Transferred and Rejected. The
   other three follow:

       Pending = max(0, Requested − Actual − Rejected)   never negative, never typed
       Extra   = max(0, Actual − Requested)              never negative, never typed

   Pending and Extra are the two DIRECTIONS OF ONE VARIANCE and can never both be
   non-zero for the same line, which is why every screen shows them as a single
   "Pending / Extra" field (see `varianceLabel`). There is deliberately no Short
   field anywhere: a shortfall IS the Pending quantity, and it is carried by a
   follow-up note rather than recorded as a separate number.

   Reject is legal only while Extra is 0: once more came off the shelf than was
   asked for, there is nothing outstanding left to refuse.
   --------------------------------------------------------------------------- */

/**
 * One line's five quantities.
 * `requested` of null/"" means an OPEN line (the office left the quantity to the
 * store incharge): there is no target to measure against, so Pending is unknown
 * rather than 0 and nothing can ever be Extra.
 */
export function noteQtys(requested, actual, rejected) {
  const a = parseFloat(actual) || 0;
  const r = parseFloat(rejected) || 0;
  if (requested == null || requested === "") {
    return { requested: null, actual: a, rejected: r, pending: null, extra: 0 };
  }
  const q = parseFloat(requested) || 0;
  return { requested: q, actual: a, rejected: r, pending: Math.max(0, q - a - r), extra: Math.max(0, a - q) };
}

/**
 * The single "Pending / Extra" cell, in the one wording used on every screen and
 * every printed document. The quantity carries its own sign and is never prefixed
 * with a word — the column header already says what the field is, and a bare
 * signed number reads the same in a table, a dialog and on paper:
 *     under   -> "−2"   (still outstanding — Pending)
 *     exact   -> "0"
 *     over    -> "+2"   (taken over the request — Extra)
 *     open    -> "—"    (no requested quantity to measure against)
 */
export function varianceLabel(pending, extra) {
  if ((extra || 0) > 0) return `+${extra}`;
  if (pending == null) return "—";
  if (pending > 0) return `−${pending}`;
  return "0";
}

/**
 * The same variance as one signed number — negative for Pending, positive for
 * Extra. Used where a column has to sort and filter numerically (list views,
 * Excel exports) rather than read as a sentence.
 */
export function varianceValue(pending, extra) {
  if ((extra || 0) > 0) return extra;
  if ((pending || 0) > 0) return -pending;
  return 0;
}

/** Tailwind colour for a variance cell: amber = outstanding, emerald = over, grey = settled. */
export function varianceClass(pending, extra) {
  if ((extra || 0) > 0) return "text-emerald-700";
  if ((pending || 0) > 0) return "text-amber-700";
  return "text-slate-400";
}

/**
 * Hover text explaining what the bare signed number in the cell actually means.
 * The words "Pending" and "Extra" live here and in the column header — never in
 * front of the quantity itself.
 */
export function varianceTitle(requested, actual, rejected, pending, extra) {
  if ((extra || 0) > 0) return `Extra — ${extra} taken over the ${requested} asked for`;
  if (pending == null) return "Open line — no quantity was asked for, so there is nothing to measure against";
  if (pending > 0) {
    return `Pending — ${pending} still outstanding (${requested} asked for − ${actual} done − ${rejected} rejected). `
      + "Carries into a new note when this one is recorded, unless it is rejected";
  }
  return "Fully settled — nothing pending, nothing extra";
}
