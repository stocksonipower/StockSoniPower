// Shared print template for every Stock Out / Stock Transfer document (Issue Note,
// Picking Note, Transfer Request, Transfer Note). Mirrors the Receipt Note print
// layout/typography (StockInPage.jsx's printReceiptNote/printChildDoc) exactly —
// only the fields and table columns change per document type.

export function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * @param {object} opts
 * @param {string} opts.docTitle - e.g. "Issue Note"
 * @param {string} opts.docNo - e.g. "IN/26-27/003" (used only for the browser tab title)
 * @param {string} opts.statusLabel - display status (already mapped to the 3-status set where applicable)
 * @param {[string, any][]} opts.fieldsLeft - [label, value] pairs, left column
 * @param {[string, any][]} opts.fieldsRight - [label, value] pairs, right column
 * @param {{label: string, align?: "left"|"right"}[]} opts.columns - table columns
 * @param {string[][]} opts.rows - pre-formatted (already-escaped) cell HTML per row
 * @param {string} [opts.printedBy]
 * @param {string} [opts.sectionTitle] - defaults to "Items"
 */
export function buildStandardPrintHtml({ docTitle, docNo, statusLabel, fieldsLeft, fieldsRight, columns, rows, printedBy, sectionTitle = "Items" }) {
  const pField = ([label, value]) =>
    `<div><div class="field-label">${htmlEscape(label)}</div><div class="field-value">${htmlEscape(value == null || value === "" ? "—" : value)}</div></div>`;
  const theadCells = columns.map((c) => `<th${c.align ? ` style="text-align:${c.align}"` : ""}>${htmlEscape(c.label)}</th>`).join("");
  const bodyRows = rows.map((cells) =>
    `<tr>${cells.map((cellHtml, i) => `<td${columns[i]?.align ? ` style="text-align:${columns[i].align}"` : ""}>${cellHtml}</td>`).join("")}</tr>`
  ).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<title>${htmlEscape(docNo)} — ${htmlEscape(docTitle)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 32px; color: #020617; }
  h1 { font-size: 22px; font-weight: 900; margin: 0 0 4px; text-align: center; letter-spacing: 0.12em; text-transform: uppercase; color: #000000; }
  .status-pill { display: inline-block; padding: 3px 8px; border-radius: 3px; font-size: 10px; font-weight: 700; text-transform: uppercase; background: #f1f5f9; color: #334155; }
  .header-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 16px 0; padding: 14px; border: 1px solid #e2e8f0; border-radius: 4px; }
  .field-label { font-size: 9px; color: #475569; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 800; }
  .field-value { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; margin-top: 2px; color: #0f172a; }
  .section-title { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #1e293b; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 11px; }
  th { text-align: left; padding: 6px 8px; background: #f1f5f9; border-bottom: 2px solid #cbd5e1; font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 800; color: #0f172a; }
  td { padding: 6px 8px; border-bottom: 1px solid #e2e8f0; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; color: #0f172a; }
  .footer { margin-top: 24px; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 8px; }
  @media print { body { padding: 12mm; } }
</style></head>
<body>
  <h1>${htmlEscape(docTitle)}</h1>
  <div style="text-align:center;margin-bottom:12px;">
    <span class="status-pill">${htmlEscape(statusLabel || "—")}</span>
  </div>

  <div class="header-grid">
    <div>${fieldsLeft.map(pField).join("")}</div>
    <div>${fieldsRight.map(pField).join("")}</div>
  </div>

  <div class="section-title">${htmlEscape(sectionTitle)} (${rows.length})</div>
  <table>
    <thead><tr>${theadCells}</tr></thead>
    <tbody>${bodyRows || `<tr><td colspan="${columns.length}">No items.</td></tr>`}</tbody>
  </table>

  <div class="footer">
    Printed: ${htmlEscape(new Date().toLocaleString())}
    &nbsp;·&nbsp; Printed by: ${htmlEscape(printedBy || "—")}
  </div>
  <script>window.onload = () => { setTimeout(() => window.print(), 100); };</script>
</body></html>`;
}

/** Opens the print HTML in a new window; returns false (without throwing) if popups are blocked. */
export function openPrintWindow(html) {
  const w = window.open("", "_blank", "width=1000,height=750");
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  return true;
}
