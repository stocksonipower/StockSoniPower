import * as XLSX from "xlsx";

/**
 * Export an array of rows to an Excel file.
 * @param {Array} rows - data rows
 * @param {Array} columns - [{ label: "Header", value: (row) => "..." }, ...]
 * @param {string} filename - "Users.xlsx"
 */
export function exportToExcel(rows, columns, filename) {
  const data = rows.map((r) => {
    const out = {};
    columns.forEach((c) => { out[c.label] = c.value(r); });
    return out;
  });
  const ws = XLSX.utils.json_to_sheet(data, { header: columns.map((c) => c.label) });
  // Auto-size columns based on the longest cell in each column
  const colWidths = columns.map((c) => {
    const maxLen = Math.max(
      c.label.length,
      ...data.map((d) => String(d[c.label] ?? "").length),
    );
    return { wch: Math.min(60, Math.max(10, maxLen + 2)) };
  });
  ws["!cols"] = colWidths;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  XLSX.writeFile(wb, filename);
}
