/**
 * How an assigned user is named on screen and on paper — one implementation, so
 * the list rows, detail dialogs, print previews, printed sheets, tooltips and the
 * assignee picker itself can never disagree.
 *
 * The rule is simply: show the person's NAME, never their email address. An
 * address is an account identifier, not a name, and printing one on a document
 * that leaves the building is both ugly and needless information leakage.
 *
 * Two cases have to be handled beyond "just read `name`":
 *   - a user who never set a name — older records stored the email address IN the
 *     name field (see `_display_name` in backend/deps.py, which now avoids that),
 *     so a value containing "@" is treated as an address, not a name;
 *   - no assignee at all — callers get their own placeholder ("—", "Unassigned").
 */

/** "john.doe@corp.com" -> "John Doe". The best name available when none was set. */
function humanizeEmail(email) {
  const local = String(email || "").split("@")[0];
  const words = local
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(" ") || String(email || "");
}

/**
 * Display name for an assignee.
 * @param {string} name   stored assigned_to_name (may be blank, or an address on old records)
 * @param {string} email  stored assigned_to_email — used only to derive a name, never shown
 * @param {string} fallback what to render when there is no assignee at all
 */
export function assigneeLabel(name, email, fallback = "—") {
  const n = String(name || "").trim();
  if (n && !n.includes("@")) return n;
  const source = String(email || "").trim() || n;
  if (!source) return fallback;
  return humanizeEmail(source);
}

/** Same rule, applied to a user record from /users/assignable. */
export function userLabel(u) {
  return assigneeLabel(u?.name, u?.email, "");
}

/**
 * Display name for an actor recorded as a bare identifier — `created_by`,
 * `closed_by`, and the other audit fields that store an email because that is
 * the stable reference at write time (a user can be renamed later and the row
 * must still point at the right person).
 *
 * Prefer a name resolved server-side (`created_by_name` on transactions); this
 * derives one from the address when no such field is present, so no screen or
 * printed document ever shows the address itself.
 *
 * @param {string} resolvedName a server-resolved name, when the endpoint supplies one
 * @param {string} stored       the stored identifier (usually an email)
 */
export function actorLabel(resolvedName, stored, fallback = "—") {
  return assigneeLabel(resolvedName, stored, fallback);
}
