import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { api, formatApiError } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "../components/ui/select";
import PartNoLink from "../components/PartNoLink";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "../components/ui/dialog";
import { toast } from "sonner";
import {
  Trash, ArrowLeft, FloppyDisk, CaretLeft, CaretRight, Pencil, CheckCircle, MapPin, ArrowsSplit,
  DownloadSimple, ArrowsClockwise, Printer,
} from "@phosphor-icons/react";
import { useAuth } from "../lib/auth";
import { AssigneeBadge } from "../components/AssigneeSelect";
import ExcelColumnFilter from "../components/ExcelColumnFilter";
import useExcelTableFilter from "../components/useExcelTableFilter";
import { ReceiptNoteDetailDialog, stockInTypeMeta, stockInTypeLabel } from "./StockInPage";
import { exportToExcel } from "../lib/exportExcel";

const PAGE_SIZE = 100;

function fmtDate(iso) {
  if (!iso) return "—";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

const SRC_TYPE_STYLES = {
  RN:  { badge: "bg-blue-100 text-blue-800 border-blue-200",       label: "RN"  },
  SRN: { badge: "bg-amber-100 text-amber-800 border-amber-200",    label: "SRN" },
  ERN: { badge: "bg-purple-100 text-purple-800 border-purple-200", label: "ERN" },
};

function SourceTypeBadge({ type }) {
  const s = SRC_TYPE_STYLES[type] || SRC_TYPE_STYLES.RN;
  return (
    <span className={`inline-block text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-sm border ${s.badge}`}>
      {s.label}
    </span>
  );
}

function escapeHtml(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function printRackingNote(rkn, locByKey, me) {
  if (!rkn) return;
  const srcType = rkn.source_type || "RN";
  const srcLabel = SRC_TYPE_STYLES[srcType]?.label || srcType;
  const statusLabel = rkn.status === "RECORDED" ? "Fully Racked" : "Draft";

  const pField = (label, value) =>
    `<div style="margin-bottom:8px"><div class="field-label">${escapeHtml(label)}</div><div class="field-value">${escapeHtml(String(value ?? "—"))}</div></div>`;

  const itemsHtml = (rkn.items || []).map((it, idx) => {
    const locs = (locByKey || {})[`${it.part_no}||${it.make}`] || [];
    const locsText = locs.length === 0 ? "—" :
      locs.map((l) => `${escapeHtml(l.godown_name)} / ${escapeHtml(l.rack_no || "—")} / ${escapeHtml(l.box_no || "—")} (${l.current_qty})`).join("<br>");
    return `<tr>
      <td>${idx + 1}</td>
      <td class="mono">${escapeHtml(it.model || "—")}</td>
      <td class="mono">${escapeHtml(it.part_no || "—")}</td>
      <td>${escapeHtml(it.description_1 || "—")}</td>
      <td>${escapeHtml(it.make || "—")}</td>
      <td>${escapeHtml(it.item_category || "—")}</td>
      <td style="text-align:right" class="mono">${it.quantity}</td>
      <td class="mono">${escapeHtml(it.godown_name || "—")}</td>
      <td class="mono">${escapeHtml(it.rack_no || "—")}</td>
      <td class="mono">${escapeHtml(it.box_no || "—")}</td>
      <td class="mono" style="line-height:1.8">${locsText}</td>
    </tr>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<title>${escapeHtml(rkn.rkn_no)} — Racking Note</title>
<style>
  * { box-sizing: border-box; }
  @page { size: A4 landscape; margin: 15mm; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 0; color: #0f172a; }
  h1 { font-size: 20px; font-weight: 900; margin: 0 0 4px; text-align: center; letter-spacing: 0.12em; text-transform: uppercase; }
  .header-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 14px 0; padding: 12px 14px; border: 1px solid #e2e8f0; border-radius: 4px; }
  .field-label { font-size: 9px; color: #64748b; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; margin-bottom: 2px; }
  .field-value { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
  .section-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #475569; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; margin: 14px 0 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th { text-align: left; padding: 5px 6px; background: #f1f5f9; border-bottom: 2px solid #cbd5e1; font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  td { padding: 5px 6px; border-bottom: 1px solid #e2e8f0; font-size: 10px; vertical-align: top; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .footer { margin-top: 20px; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 8px; }
  @media print { body { padding: 0; } tr { page-break-inside: avoid; } }
</style></head>
<body>
  <h1>Racking Note</h1>
  <div class="header-grid">
    <div>
      ${pField("Racking Source", `[${srcLabel}] ${rkn.source_no || rkn.receipt_note_no || "—"}`)}
      ${pField("Racking Note Date", fmtDate(rkn.rkn_date))}
      ${pField("Racking Note No", rkn.rkn_no)}
    </div>
    <div>
      ${pField("Assigned To", rkn.parent_assigned_to_name || rkn.parent_assigned_to_email || "—")}
      ${pField("Status", statusLabel)}
      ${pField("Created By", rkn.created_by || "—")}
      ${rkn.narration ? `<div style="margin-bottom:8px"><div class="field-label">Narration</div><div class="field-value" style="white-space:pre-wrap">${escapeHtml(rkn.narration)}</div></div>` : ""}
    </div>
  </div>
  <div class="section-title">Items (${(rkn.items || []).length})</div>
  <table>
    <thead><tr>
      <th>SL</th><th>Model</th><th>Part No</th><th>Description</th><th>Make</th>
      <th>Category</th><th style="text-align:right">Qty</th>
      <th>Godown</th><th>Rack</th><th>Box</th><th>Existing Locations</th>
    </tr></thead>
    <tbody>${itemsHtml}</tbody>
  </table>
  <div class="footer">
    Printed: ${escapeHtml(new Date().toLocaleString())}
    &nbsp;·&nbsp; Printed by: ${escapeHtml(me?.email || rkn.created_by || "—")}
  </div>
  <script>window.onload = () => { setTimeout(() => window.print(), 100); };</script>
</body></html>`;

  const w = window.open("", "_blank", "width=1200,height=800");
  if (!w) { toast.error("Popup blocked — allow popups for this site to print"); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}


/* ==============================================================
   STOCK IN  ·  Racking Note tab
   ============================================================== */
export default function RackingNoteTab() {
  const [view, setView] = useState("list"); // list | edit
  const [editing, setEditing] = useState(null);
  const [openRkn, setOpenRkn] = useState(null);
  const [openRn, setOpenRn] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const goEdit = (rkn) => { setEditing(rkn); setView("edit"); };
  const goList = () => { setEditing(null); setView("list"); setReloadKey((k) => k + 1); };

  const handleOpenRn = async (rnId) => {
    if (!rnId) return;
    try {
      const { data } = await api.get(`/receipt-notes/${rnId}`);
      setOpenRn(data);
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not load Receipt Note");
    }
  };

  return (
    <>
      {view === "list" && (
        <RackingNoteList
          reloadKey={reloadKey}
          onEdit={goEdit}
          onOpen={(r) => setOpenRkn(r)}
          onOpenRn={handleOpenRn}
        />
      )}
      {view === "edit" && (
        <RackingNoteForm editing={editing} onCancel={goList} onSaved={goList} onOpenRn={handleOpenRn} />
      )}
      <RackingNoteDetailDialog rkn={openRkn} onClose={() => setOpenRkn(null)} onOpenRn={handleOpenRn} />
      <ReceiptNoteDetailDialog rn={openRn} onClose={() => setOpenRn(null)} />
    </>
  );
}

/* ---------- LIST VIEW ---------- */
function RackingNoteList({ reloadKey, onEdit, onOpen, onOpenRn }) {
  const { user: me, isAdmin } = useAuth();
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/racking-notes", { params: { page, page_size: PAGE_SIZE, search: search || undefined } });
      setRows(res.data);
      const t = parseInt(res.headers["x-total-count"], 10);
      setTotal(isNaN(t) ? res.data.length : t);
    } finally { setLoading(false); }
  }, [page, search]);
  useEffect(() => { load(); }, [load, reloadKey, search]);

  // Ctrl+F focusses the search input
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleDelete = async (rkn) => {
    if (!window.confirm(`Delete ${rkn.rkn_no}?`)) return;
    try {
      await api.delete(`/racking-notes/${rkn.id}`);
      toast.success(`${rkn.rkn_no} deleted`);
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not delete");
    }
  };

  const columns = useMemo(() => [
    { key: "stock_in_type", label: "STOCK IN TYPE", value: (r) => stockInTypeLabel(r.parent_stock_in_type) },
    { key: "rn_date", label: "RECEIPT NOTE DATE", value: (r) => fmtDate(r.receipt_note_date) },
    { key: "rn_no", label: "RECEIPT NOTE NO", value: (r) => r.receipt_note_no || "" },
    { key: "rkn_date", label: "RACKING NOTE DATE", value: (r) => fmtDate(r.rkn_date) },
    { key: "rkn_no", label: "RACKING NOTE NO", value: (r) => r.rkn_no || "" },
    { key: "material_received_date", label: "MATERIAL RECEIVED DATE", value: (r) => fmtDate(r.goods_received_date) },
    { key: "status", label: "STATUS", value: (r) => r.status === "RECORDED" ? "Fully Racked" : "Draft" },
  ], []);
  const {
    filteredRows, uniqueValues, colFilters, setColFilter, sort, setColumnSort,
  } = useExcelTableFilter(rows, columns);

  const handleExport = () => {
    if (filteredRows.length === 0) { toast.error("No rows to export"); return; }
    const exportCols = [
      { label: "Sl No", value: (r) => filteredRows.indexOf(r) + 1 },
      ...columns,
    ];
    exportToExcel(filteredRows, exportCols, `Racking_Notes_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <div className="mt-4" data-testid="rkn-list-view">
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div />
        <div className="flex items-center gap-2">
          <Input
            ref={searchInputRef}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search"
            className="rounded-sm font-mono h-9 w-80"
            data-testid="rkn-search-input"
          />
          <Button onClick={handleExport} variant="outline" className="rounded-sm border-slate-300" data-testid="rkn-export-button">
            <DownloadSimple size={14} weight="bold" className="mr-2" /> Export
          </Button>
          <Button onClick={load} variant="outline" className="rounded-sm border-slate-300" disabled={loading} data-testid="rkn-refresh-button">
            <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto overflow-visible">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-14">SL NO</th>
              {columns.map((c) => (
                <th key={c.key} className={c.isQty ? "text-right" : ""}>
                  <ExcelColumnFilter
                    label={c.label}
                    values={uniqueValues[c.key] || []}
                    selected={colFilters[c.key]}
                    onChange={(s) => setColFilter(c.key, s)}
                    sortDir={sort?.key === c.key ? sort.dir : null}
                    onSort={(dir) => setColumnSort(c.key, dir)}
                    isQty={c.isQty}
                    isNumeric={c.isNumeric}
                  />
                </th>
              ))}
              <th className="text-left">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r, idx) => {
              const recorded = r.status === "RECORDED";
              const assigneeId = r.parent_assigned_to_user_id;
              const assigneeName = r.parent_assigned_to_name;
              const assigneeEmail = r.parent_assigned_to_email;
              const isLockedToOther = !!assigneeId && assigneeId !== me?.id && !isAdmin;
              const lock = recorded || isLockedToOther;
              const editTitle = recorded ? "Cannot edit — already recorded"
                : (isLockedToOther ? `Locked — assigned to ${assigneeName || assigneeEmail}` : "Edit");
              const deleteTitle = recorded ? "Cannot delete — already recorded"
                : (isLockedToOther ? `Locked — assigned to ${assigneeName || assigneeEmail}` : "Delete");
              return (
                <tr key={r.id} data-testid={`rkn-row-${r.rkn_no}`}>
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td>
                    {(() => { const sit = stockInTypeMeta(r.parent_stock_in_type); return (
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${sit.cls}`}
                            data-testid={`rkn-stock-in-type-${r.rkn_no}`}>
                        {sit.label}
                      </span>
                    ); })()}
                  </td>
                  <td className="font-mono text-slate-700">{fmtDate(r.receipt_note_date)}</td>
                  <td>
                    {r.receipt_note_no ? (
                      <button
                        onClick={() => onOpenRn?.(r.receipt_note_id)}
                        className="font-mono font-semibold text-blue-700 hover:underline"
                        data-testid={`rkn-open-rn-${r.receipt_note_no}`}
                      >
                        {r.receipt_note_no}
                      </button>
                    ) : <span className="font-mono text-slate-400">—</span>}
                  </td>
                  <td className="font-mono text-slate-700">{fmtDate(r.rkn_date)}</td>
                  <td>
                    <button
                      onClick={() => onOpen(r)}
                      className="font-mono font-semibold text-blue-700 hover:underline"
                      data-testid={`rkn-open-${r.rkn_no}`}
                    >
                      {r.rkn_no}
                    </button>
                  </td>
                  <td className="font-mono text-slate-700">{fmtDate(r.goods_received_date)}</td>
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${recorded ? "bg-green-100 text-green-800" : "bg-amber-50 text-amber-700"}`}
                      data-testid={`rkn-status-${r.rkn_no}`}>
                      {recorded ? "Fully Racked" : "Draft"}
                    </span>
                  </td>
                  <td className="text-left whitespace-nowrap">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => onEdit(r)}
                        disabled={lock}
                        title={editTitle}
                        className={`p-1.5 rounded-sm ${lock ? "text-slate-300 cursor-not-allowed" : "hover:bg-slate-100"}`}
                        data-testid={`rkn-edit-${r.rkn_no}`}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(r)}
                        disabled={lock}
                        title={deleteTitle}
                        className={`p-1.5 rounded-sm ${lock ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                        data-testid={`rkn-delete-${r.rkn_no}`}
                      >
                        <Trash size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && (
              <tr><td colSpan={9} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? "No racking notes." : "No rows match the current filters.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between mt-3 text-xs text-slate-600">
        <div>
          {total === 0 ? "No racking notes" : (
            <>
              Showing <span className="font-semibold text-slate-900">{filteredRows.length}</span>
              {" - "}<span className="font-semibold text-slate-900">{total}</span> total
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading} variant="outline" size="sm" className="rounded-sm h-7">
            <CaretLeft size={12} weight="bold" className="mr-1" /> Prev
          </Button>
          <span className="font-mono">Page {page} of {totalPages}</span>
          <Button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages || loading} variant="outline" size="sm" className="rounded-sm h-7">
            Next <CaretRight size={12} weight="bold" className="ml-1" />
          </Button>
          <span className="text-slate-400 ml-2">{PAGE_SIZE.toLocaleString()} / page</span>
        </div>
      </div>
    </div>
  );
}

/* ---------- DETAIL DIALOG (read-only) ---------- */
function RackingNoteDetailDialog({ rkn, onClose, onOpenRn }) {
  const { user: me } = useAuth();
  const [locByKey, setLocByKey] = useState({});

  useEffect(() => {
    if (!rkn) { setLocByKey({}); return; }
    const srcType = rkn.source_type || "RN";
    const srcId = rkn.source_id || rkn.receipt_note_id;
    if (!srcId) return;
    api.get("/racking-notes/prepare-source", {
      params: { source_type: srcType, source_id: srcId, exclude_rkn_id: rkn.id },
    }).then((r) => {
      const map = {};
      (r.data.items || []).forEach((it) => {
        map[`${it.part_no}||${it.make}`] = it.existing_locations || [];
      });
      setLocByKey(map);
    }).catch(() => setLocByKey({}));
  }, [rkn?.id]);

  return (
    <Dialog open={!!rkn} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-7xl rounded-sm" data-testid="rkn-detail-dialog">
        {rkn && (
          <>
            <DialogHeader>
              <div className="flex items-center justify-between">
                <DialogTitle className="text-2xl font-black font-mono">{rkn.rkn_no}</DialogTitle>
                <Button variant="outline" size="sm" className="rounded-sm" onClick={() => printRackingNote(rkn, locByKey, me)} data-testid="rkn-detail-print">
                  <Printer size={14} weight="bold" className="mr-1.5" /> Print
                </Button>
              </div>
            </DialogHeader>

            <div className="grid grid-cols-3 gap-4 text-sm border-b border-slate-200 pb-4 mb-4">
              <div>
                <div className="label-sm">RACKING SOURCE</div>
                <div className="font-mono mt-1 text-slate-900 flex items-center gap-2" data-testid="rkn-detail-source">
                  <SourceTypeBadge type={rkn.source_type || "RN"} />
                  <button
                    onClick={() => onOpenRn?.(rkn.receipt_note_id)}
                    className="font-mono font-semibold text-blue-700 hover:underline"
                  >
                    {rkn.source_no || rkn.receipt_note_no || "—"}
                  </button>
                </div>
              </div>
              <Detail k="RACKING NOTE DATE" v={fmtDate(rkn.rkn_date)} />
              <Detail k="RACKING NOTE NO" v={rkn.rkn_no} />
              <div>
                <div className="label-sm">ASSIGNED TO</div>
                <div className="mt-1"><AssigneeBadge name={rkn.parent_assigned_to_name} email={rkn.parent_assigned_to_email} /></div>
              </div>
              <div>
                <div className="label-sm">STATUS</div>
                <div className="mt-1">
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${rkn.status === "RECORDED" ? "bg-green-100 text-green-800" : "bg-amber-50 text-amber-700"}`}>
                    {rkn.status === "RECORDED" ? "Fully Racked" : "Draft"}
                  </span>
                </div>
              </div>
              <Detail k="CREATED BY" v={rkn.created_by || "—"} />
            </div>

            <div className="overflow-x-auto">
              <table className="data-table w-full text-xs">
                <thead>
                  <tr>
                    <th>SL</th>
                    <th>MODEL</th>
                    <th>PART NO</th>
                    <th>DESCRIPTION</th>
                    <th>MAKE</th>
                    <th>ITEM CATEGORY</th>
                    <th className="text-right">QTY</th>
                    <th>GODOWN</th>
                    <th>RACK</th>
                    <th>BOX</th>
                    <th>EXISTING LOCATIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {(rkn.items || []).map((it, idx) => {
                    const locs = locByKey[`${it.part_no}||${it.make}`] || [];
                    return (
                      <tr key={idx}>
                        <td className="font-mono text-slate-500">{idx + 1}</td>
                        <td className="font-mono text-slate-600">{it.model || "—"}</td>
                        <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                        <td className="text-slate-700 max-w-[220px] truncate" title={it.description_1}>{it.description_1 || "—"}</td>
                        <td className="text-slate-700">{it.make || "—"}</td>
                        <td className="text-slate-600">{it.item_category || "—"}</td>
                        <td className="text-right font-mono font-bold">{it.quantity}</td>
                        <td className="font-mono">{it.godown_name || "—"}</td>
                        <td className="font-mono">{it.rack_no || "—"}</td>
                        <td className="font-mono">{it.box_no || "—"}</td>
                        <td>
                          {locs.length === 0 ? (
                            <span className="text-slate-400 text-[11px]">—</span>
                          ) : (
                            <div className="flex flex-col gap-1">
                              {locs.map((loc, k) => (
                                <span key={k} className="text-[10px] font-mono px-2 py-0.5 rounded-sm border bg-slate-50 border-slate-200 text-slate-700">
                                  {loc.godown_name} / {loc.rack_no || "—"} / {loc.box_no || "—"} ({loc.current_qty})
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Detail({ k, v }) {
  return (
    <div>
      <div className="label-sm">{k}</div>
      <div className="font-mono mt-1 text-slate-900">{v}</div>
    </div>
  );
}

/* ---------- EDIT FORM ---------- */
function RackingNoteForm({ editing, onCancel, onSaved, onOpenRn }) {
  const [items, setItems] = useState([]);
  const [narration, setNarration] = useState("");
  const [saving, setSaving] = useState(false);

  // Cascading dropdown caches
  const [godowns, setGodowns] = useState([]);
  const [racksByGodown, setRacksByGodown] = useState({});
  const [boxesByRack, setBoxesByRack] = useState({});

  useEffect(() => { api.get("/godowns").then((r) => setGodowns(r.data)); }, []);

  // Load items + pending/existing-location data for this RKN
  useEffect(() => {
    if (!editing) return;
    setNarration(editing.narration || "");
    const srcType = editing.source_type || "RN";
    const srcId = editing.source_id || editing.receipt_note_id;
    api.get("/racking-notes/prepare-source", {
      params: { source_type: srcType, source_id: srcId, exclude_rkn_id: editing.id },
    }).then((r) => {
      const pendingMap = {};
      (r.data.items || []).forEach((p) => { pendingMap[`${p.part_no}||${p.make}`] = p; });
      setItems((editing.items || []).map((it) => {
        const p = pendingMap[`${it.part_no}||${it.make}`] || {};
        return {
          ...it,
          existing_locations: p.existing_locations || [],
          pending_qty: p.pending_qty ?? 0,
          rackable_qty: p.rackable_qty ?? p.received_qty ?? 0,
          received_qty: p.received_qty ?? p.rackable_qty ?? 0,
          _boxNone: false,
        };
      }));
    }).catch(() => {
      setItems((editing.items || []).map((it) => ({
        ...it, existing_locations: [], pending_qty: 0, received_qty: 0, rackable_qty: 0, _boxNone: false,
      })));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  // Fetch racks for a given godown lazily
  const ensureRacks = useCallback(async (godownId) => {
    if (!godownId || racksByGodown[godownId]) return;
    const { data } = await api.get("/racks", { params: { godown_id: godownId } });
    setRacksByGodown((p) => ({ ...p, [godownId]: data }));
  }, [racksByGodown]);

  const ensureBoxes = useCallback(async (rackId) => {
    if (!rackId || boxesByRack[rackId]) return;
    const { data } = await api.get("/boxes", { params: { rack_id: rackId } });
    setBoxesByRack((p) => ({ ...p, [rackId]: data }));
  }, [boxesByRack]);

  // When prefilled items have godown/rack ids, eagerly load their lookups
  useEffect(() => {
    items.forEach((it) => {
      if (it.godown_id) ensureRacks(it.godown_id);
      if (it.rack_id) ensureBoxes(it.rack_id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  const updateItem = (i, patch) => setItems((prev) => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  const onGodownChange = async (i, godownId) => {
    const g = godowns.find((x) => x.id === godownId);
    updateItem(i, { godown_id: godownId, godown_name: g?.godown_name || "", rack_id: "", rack_no: "", box_id: "", box_no: "", box_category: "", _boxNone: false });
    await ensureRacks(godownId);
  };
  const onRackChange = async (i, rackId) => {
    const racks = racksByGodown[items[i].godown_id] || [];
    const rk = racks.find((x) => x.id === rackId);
    updateItem(i, { rack_id: rackId, rack_no: rk?.rack_no || "", box_id: "", box_no: "", box_category: "", _boxNone: false });
    await ensureBoxes(rackId);
  };
  const onBoxChange = (i, boxId) => {
    if (boxId === "__none__") {
      updateItem(i, { box_id: "", box_no: "", box_category: "", _boxNone: true });
      return;
    }
    const boxes = boxesByRack[items[i].rack_id] || [];
    const bx = boxes.find((x) => x.id === boxId);
    updateItem(i, { box_id: boxId, box_no: bx?.box_no || "", box_category: bx?.box_category || "", _boxNone: false });
  };

  // Apply an existing-location chip click
  const applyExistingLocation = async (i, loc) => {
    await ensureRacks(loc.godown_id);
    await ensureBoxes(loc.rack_id);
    updateItem(i, {
      godown_id: loc.godown_id, godown_name: loc.godown_name,
      rack_id: loc.rack_id, rack_no: loc.rack_no,
      box_id: loc.box_id || "", box_no: loc.box_no || "",
      box_category: loc.box_category || "",
      _boxNone: !loc.box_id,
    });
  };

  // Split a row: duplicate the part_no/make/master fields with empty location and qty 0
  const splitRow = (i) => {
    setItems((prev) => {
      const src = prev[i];
      const copy = {
        ...src,
        quantity: 0,
        godown_id: "", godown_name: "",
        rack_id: "", rack_no: "",
        box_id: "", box_no: "", box_category: "",
        _boxNone: false,
      };
      const out = [...prev];
      out.splice(i + 1, 0, copy);
      return out;
    });
  };

  // Remove a row entirely
  const removeRow = (i) => {
    setItems((prev) => prev.filter((_, idx) => idx !== i));
  };

  // Sum of qty per (part_no, make) — used for "Allocated X of Y" hints
  const allocatedByKey = useMemo(() => {
    const map = {};
    items.forEach((r) => {
      const k = `${r.part_no}||${r.make}`;
      map[k] = (map[k] || 0) + (parseFloat(r.quantity) || 0);
    });
    return map;
  }, [items]);

  // Sum of pending_qty per (part_no, make) — same part may appear in multiple RN rows
  const totalPendingByKey = useMemo(() => {
    const map = {};
    items.forEach((r) => {
      const k = `${r.part_no}||${r.make}`;
      if (r.pending_qty !== undefined) map[k] = (map[k] || 0) + r.pending_qty;
    });
    return map;
  }, [items]);

  const buildPayload = () => {
    const srcType = editing?.source_type || "RN";
    const srcId = editing?.source_id || editing?.receipt_note_id;
    return {
      source_type: srcType,
      source_id: srcId,
      receipt_note_id: srcType === "RN" ? srcId : (editing?.receipt_note_id || undefined),
      narration: narration.trim(),
      items: items.map((it) => ({
        part_no: it.part_no, make: it.make, quantity: parseFloat(it.quantity),
        model: it.model || "", old_part_no: it.old_part_no || "", make_part_no: it.make_part_no || "",
        description_1: it.description_1 || "", description_2: it.description_2 || "",
        remarks_oem: it.remarks_oem || "", remarks_others: it.remarks_others || "",
        item_category: it.item_category || "",
        godown_id: it.godown_id, godown_name: it.godown_name,
        rack_id: it.rack_id, rack_no: it.rack_no,
        box_id: it.box_id || "", box_no: it.box_no || "", box_category: it.box_category || "",
      })),
    };
  };

  const validate = () => {
    if (items.length === 0) { toast.error("No items to rack"); return false; }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.godown_id || !it.rack_id) {
        toast.error(`Row ${i + 1}: pick Godown / Rack`); return false;
      }
      const q = parseFloat(it.quantity);
      if (isNaN(q) || q <= 0) { toast.error(`Row ${i + 1}: quantity must be > 0`); return false; }
    }
    // Cumulative-vs-pending check (client-side; backend re-validates)
    const pendingMap = {};
    items.forEach((r) => {
      const k = `${r.part_no}||${r.make}`;
      if (r.pending_qty !== undefined) pendingMap[k] = (pendingMap[k] || 0) + r.pending_qty;
    });
    for (const [k, allocated] of Object.entries(allocatedByKey)) {
      const pending = pendingMap[k];
      if (pending !== undefined && allocated > pending + 1e-6) {
        const [p, m] = k.split("||");
        toast.error(`${p} / ${m}: allocated ${allocated} exceeds pending ${pending}`);
        return false;
      }
    }
    return true;
  };

  const saveAsDraft = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const { data } = await api.put(`/racking-notes/${editing.id}`, buildPayload());
      toast.success(`Racking Note ${data.rkn_no} updated`);
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save");
    } finally { setSaving(false); }
  };

  const saveFinal = async () => {
    if (editing?.status === "RECORDED") {
      toast.error("This racking note has already been recorded");
      return;
    }
    if (!validate()) return;
    setSaving(true);
    try {
      const { data } = await api.put(`/racking-notes/${editing.id}`, buildPayload());
      const res = await api.post(`/racking-notes/${data.id}/record`);
      const recData = res.data || {};
      const autoRkn = res.headers?.["x-auto-rkn-no"] || recData.auto_rkn_no;
      if (autoRkn) {
        toast.success(`Recorded · ${recData.transactions_created} stock-in transaction(s) · ${autoRkn} auto-created for remaining qty`);
      } else {
        toast.success(`Recorded · ${recData.transactions_created} stock-in transaction(s) created`);
      }
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not record");
    } finally { setSaving(false); }
  };

  const srcType = editing?.source_type || "RN";
  const srcNo = editing?.source_no || editing?.receipt_note_no || "—";
  const recorded = editing?.status === "RECORDED";

  return (
    <div className="mt-4 space-y-6" data-testid="rkn-create-view">
      <div className="flex items-center justify-between">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="rkn-back-button">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
      </div>

      {/* HEADER */}
      <div className="bg-white border border-slate-200 rounded-sm p-6 space-y-4">
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <div className="label-sm">RACKING SOURCE</div>
            <div className="font-mono mt-1 text-slate-900 flex items-center gap-2" data-testid="rkn-source-display">
              <SourceTypeBadge type={srcType} />
              <button
                onClick={() => onOpenRn?.(editing?.receipt_note_id)}
                className="font-mono font-semibold text-blue-700 hover:underline"
                data-testid="rkn-source-link"
              >
                {srcNo}
              </button>
            </div>
          </div>
          <div>
            <div className="label-sm">RACKING NOTE DATE</div>
            <div className="font-mono mt-1 text-slate-900" data-testid="rkn-date-input">{fmtDate(editing?.rkn_date)}</div>
          </div>
          <div>
            <div className="label-sm">RACKING NOTE NO</div>
            <div className="font-mono mt-1 font-semibold text-blue-900" data-testid="rkn-no-input">{editing?.rkn_no || "—"}</div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <div className="label-sm">ASSIGNED TO</div>
            <div className="mt-1"><AssigneeBadge name={editing?.parent_assigned_to_name} email={editing?.parent_assigned_to_email} /></div>
          </div>
          <div>
            <div className="label-sm">STATUS</div>
            <div className="mt-1">
              <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${recorded ? "bg-green-100 text-green-800" : "bg-amber-50 text-amber-700"}`}>
                {recorded ? "Fully Racked" : "Draft"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ITEMS */}
      {items.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto">
          <table className="data-table w-full text-xs">
            <thead>
              <tr>
                <th className="w-10">SL</th>
                <th>MODEL</th>
                <th>PART NO</th>
                <th>DESCRIPTION</th>
                <th>MAKE</th>
                <th>ITEM CATEGORY</th>
                <th className="text-right">QTY</th>
                <th className="min-w-[140px]">GODOWN *</th>
                <th className="min-w-[120px]">RACK *</th>
                <th className="min-w-[120px]">BOX</th>
                <th>EXISTING LOCATIONS</th>
                <th className="w-20"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => {
                const racks = racksByGodown[it.godown_id] || [];
                const boxes = boxesByRack[it.rack_id] || [];
                const key = `${it.part_no}||${it.make}`;
                const allocated = allocatedByKey[key] || 0;
                const pending = it.pending_qty;
                const received = it.rackable_qty ?? it.received_qty;
                const totalPending = totalPendingByKey[key];
                const overAllocated = totalPending !== undefined && allocated > totalPending + 1e-6;
                return (
                  <tr key={idx} data-testid={`rkn-item-row-${idx}`} className={overAllocated ? "bg-red-50" : ""}>
                    <td className="font-mono text-slate-500">{idx + 1}</td>
                    <td className="font-mono text-slate-600">{it.model || "—"}</td>
                    <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                    <td className="text-slate-700 max-w-[200px] truncate" title={it.description_1}>{it.description_1 || "—"}</td>
                    <td className="text-slate-700">{it.make || "—"}</td>
                    <td className="text-slate-600">{it.item_category || "—"}</td>
                    <td className="text-right">
                      <Input type="number" min="0.001" step="any" value={it.quantity}
                        onChange={(e) => updateItem(idx, { quantity: e.target.value })}
                        className={`rounded-sm font-mono h-8 text-right w-20 ${overAllocated ? "border-red-400" : ""}`}
                        data-testid={`rkn-qty-${idx}`} />
                      {pending !== undefined && (
                        <div className={`text-[10px] mt-0.5 ${overAllocated ? "text-red-600 font-bold" : "text-slate-500"}`} data-testid={`rkn-pending-hint-${idx}`}>
                          {overAllocated ? `Over ${allocated}/${totalPending}` : `Pending ${pending} of ${received}`}
                        </div>
                      )}
                    </td>
                    <td>
                      <Select value={it.godown_id || undefined} onValueChange={(v) => onGodownChange(idx, v)}>
                        <SelectTrigger className="rounded-sm h-8" data-testid={`rkn-godown-${idx}`}><SelectValue placeholder="Godown" /></SelectTrigger>
                        <SelectContent>
                          {godowns.map((g) => <SelectItem key={g.id} value={g.id}>{g.godown_name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                    <td>
                      <Select value={it.rack_id || undefined} onValueChange={(v) => onRackChange(idx, v)} disabled={!it.godown_id}>
                        <SelectTrigger className="rounded-sm h-8" data-testid={`rkn-rack-${idx}`}><SelectValue placeholder="Rack" /></SelectTrigger>
                        <SelectContent>
                          {racks.map((r) => <SelectItem key={r.id} value={r.id}>{r.rack_no}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                    <td>
                      <Select
                        value={it._boxNone ? "__none__" : (it.box_id || undefined)}
                        onValueChange={(v) => onBoxChange(idx, v)}
                        disabled={!it.rack_id}
                      >
                        <SelectTrigger className="rounded-sm h-8" data-testid={`rkn-box-${idx}`}>
                          <SelectValue placeholder={!it.rack_id ? "Box" : (boxes.length === 0 ? "No boxes — skip" : "Box (optional)")} />
                        </SelectTrigger>
                        <SelectContent>
                          {boxes.length > 0 && <SelectItem value="__none__">— (No Box)</SelectItem>}
                          {boxes.map((b) => <SelectItem key={b.id} value={b.id}>{b.box_no}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                    <td>
                      {(it.existing_locations || []).length === 0 ? (
                        <span className="text-[11px] text-slate-400 italic">New part — pick any location</span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {(it.existing_locations || []).map((loc, k) => {
                            const isCurrent = loc.godown_id === it.godown_id &&
                              loc.rack_id === it.rack_id &&
                              (loc.box_id || "") === (it.box_id || "");
                            return (
                              <button key={k} onClick={() => applyExistingLocation(idx, loc)}
                                className={`text-[10px] font-mono px-2 py-0.5 rounded-sm border text-left ${isCurrent ? "bg-blue-50 border-blue-300 text-blue-800" : "bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100"}`}
                                title={`${loc.godown_name}/${loc.rack_no || "—"}/${loc.box_no || "—"} — ${loc.current_qty} in stock`}
                                data-testid={`rkn-existing-loc-${idx}-${k}`}>
                                <MapPin size={10} weight="bold" className="inline mr-0.5" />
                                {loc.godown_name} / {loc.rack_no || "—"} / {loc.box_no || "—"} ({loc.current_qty})
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => splitRow(idx)}
                          className="p-1 hover:bg-blue-50 text-blue-700 rounded-sm"
                          title="Split into another row (same part, different location)"
                          data-testid={`rkn-split-${idx}`}
                        >
                          <ArrowsSplit size={14} weight="bold" />
                        </button>
                        <button
                          onClick={() => removeRow(idx)}
                          disabled={items.length === 1}
                          className={`p-1 rounded-sm ${items.length === 1 ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                          title="Remove row"
                          data-testid={`rkn-remove-${idx}`}
                        >
                          <Trash size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* NARRATION + SAVE BAR */}
      {items.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-sm">
          <div className="flex items-start justify-between gap-4 p-4">
            <div className="flex-1 max-w-sm">
              <label className="label-sm block mb-1.5">Narration</label>
              <textarea
                value={narration}
                onChange={(e) => setNarration(e.target.value)}
                placeholder="Optional narration…"
                rows={2}
                className="w-full rounded-sm border border-slate-300 bg-white px-3 py-1.5 text-sm font-mono resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
                data-testid="rkn-narration"
              />
            </div>
            <div className="flex items-center gap-2 pt-7">
              <Button
                onClick={saveAsDraft}
                disabled={saving || recorded}
                variant="outline"
                className="rounded-sm border-slate-300 px-4"
                data-testid="rkn-save-draft-button"
              >
                <FloppyDisk size={14} weight="bold" className="mr-2" />
                {saving ? "Saving…" : "Save as Draft"}
              </Button>
              <Button
                onClick={saveFinal}
                disabled={saving || recorded}
                className="rounded-sm bg-blue-700 hover:bg-blue-800 px-4"
                data-testid="rkn-save-final-button"
              >
                <CheckCircle size={14} weight="bold" className="mr-2" />
                {saving ? "Saving…" : "Save Final"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
