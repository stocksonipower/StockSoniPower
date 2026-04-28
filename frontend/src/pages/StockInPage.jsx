import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { api, formatApiError } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "../components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "../components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import {
  Plus, Trash, ArrowLeft, FloppyDisk, FileText, CaretLeft, CaretRight, Pencil, Stack,
  DownloadSimple, ArrowsClockwise, UploadSimple, Printer, CheckCircle, Warning, Eye,
  Receipt, Package as PackageIcon,
} from "@phosphor-icons/react";
import RackingNoteTab from "./RackingNoteTab";
import AssigneeSelect, { AssigneeBadge } from "../components/AssigneeSelect";
import PartNoLink from "../components/PartNoLink";
import { useAuth } from "../lib/auth";
import ExcelColumnFilter from "../components/ExcelColumnFilter";
import useExcelTableFilter from "../components/useExcelTableFilter";
import { exportToExcel } from "../lib/exportExcel";

/* ==============================================================
   STOCK IN  ·  Receipt Note tab (Phase 1: Draft/Final + SRN/ERN)
   ============================================================== */

/** Format an ISO date "YYYY-MM-DD" -> "DD-MM-YYYY". Returns "—" for falsy. */
function fmtDate(iso) {
  if (!iso) return "—";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Today as "YYYY-MM-DD" for date-input max attribute. */
function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Numeric helper — empty/blank -> null, else float. */
function toNum(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

/** Compute received_qty - invoice_qty. Returns 0 if either side is empty. */
function qtyDiff(it) {
  const inv = toNum(it.invoice_qty);
  const rec = toNum(it.received_qty);
  if (inv == null || rec == null) return 0;
  return rec - inv;
}

/** Status pill metadata used in list view AND detail dialog. */
function stockInTypeMeta(type) {
  const t = (type || "INVOICE").toUpperCase();
  if (t === "GENERAL") return { label: "General", cls: "bg-indigo-50 text-indigo-800 border border-indigo-200" };
  return { label: "Invoice", cls: "bg-blue-50 text-blue-800 border border-blue-200" };
}
function stockInTypeLabel(type) { return stockInTypeMeta(type).label; }


function statusMeta(status) {
  switch (status) {
    case "DRAFT":
      return { label: "Draft", cls: "bg-slate-100 text-slate-700" };
    case "FINAL":
    case "RACKING_PENDING":
      return { label: "Racking Pending", cls: "bg-amber-50 text-amber-700" };
    case "RACKING_NOTE_DRAFT":
      return { label: "Racking Note Draft", cls: "bg-orange-50 text-orange-800 border border-orange-200" };
    case "PARTIALLY_RACKED":
      return { label: "Partially Racked", cls: "bg-blue-50 text-blue-800" };
    case "FULLY_RACKED":
      return { label: "Fully Racked", cls: "bg-green-100 text-green-800" };
    // SRN Phase 2 statuses
    case "PENDING":
      return { label: "Pending", cls: "bg-amber-50 text-amber-700" };
    case "PARTIALLY_RECEIVED":
      return { label: "Partially Received", cls: "bg-blue-50 text-blue-800" };
    case "FULLY_RECEIVED":  // legacy — backend now emits COMPLETE
    case "COMPLETE":
      return { label: "Complete", cls: "bg-green-100 text-green-800" };
    // ERN Phase 2 statuses
    case "PARTIALLY_ACCEPTED":
      return { label: "Partially Accepted", cls: "bg-blue-50 text-blue-800" };
    case "PARTIALLY_REJECTED":
      return { label: "Partially Rejected", cls: "bg-purple-50 text-purple-800" };
    default:
      return { label: status || "—", cls: "bg-slate-100 text-slate-700" };
  }
}

export default function StockInPage() {
  const [tab, setTab] = useState("receipt-note");
  return (
    <div className="p-8 max-w-[1600px] mx-auto" data-testid="stock-in-page">
      <div className="mb-6">
        <div className="label-sm mb-2">Inward</div>
        <h1 className="text-4xl font-black tracking-tight text-slate-900">Stock In</h1>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="rounded-sm">
          <TabsTrigger value="receipt-note" className="rounded-sm" data-testid="tab-receipt-note">
            <FileText size={14} weight="bold" className="mr-2" /> Receipt Note
          </TabsTrigger>
          <TabsTrigger value="short-received-note" className="rounded-sm" data-testid="tab-short-received-note">
            <Warning size={14} weight="bold" className="mr-2" /> Short Received Note
          </TabsTrigger>
          <TabsTrigger value="extra-received-note" className="rounded-sm" data-testid="tab-extra-received-note">
            <Plus size={14} weight="bold" className="mr-2" /> Extra Received Note
          </TabsTrigger>
          <TabsTrigger value="racking-note" className="rounded-sm" data-testid="tab-racking-note">
            <Stack size={14} weight="bold" className="mr-2" /> Racking Note
          </TabsTrigger>
        </TabsList>

        <TabsContent value="receipt-note">
          <ReceiptNoteTab />
        </TabsContent>
        <TabsContent value="short-received-note">
          <ShortReceivedNoteTab />
        </TabsContent>
        <TabsContent value="extra-received-note">
          <ExtraReceivedNoteTab />
        </TabsContent>
        <TabsContent value="racking-note">
          <RackingNoteTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* --------------------------------------------------------------
   Receipt Note Tab — switches between LIST and CREATE views
   -------------------------------------------------------------- */
function ReceiptNoteTab() {
  const [view, setView] = useState("list"); // "list" | "create" | "edit"
  const [editingRn, setEditingRn] = useState(null);
  const [openRn, setOpenRn] = useState(null); // detail dialog
  const [reloadKey, setReloadKey] = useState(0);

  const goCreate = () => { setEditingRn(null); setView("create"); };
  const goEdit = (rn) => { setEditingRn(rn); setView("edit"); };
  const goList = () => { setEditingRn(null); setView("list"); setReloadKey((k) => k + 1); };

  return (
    <>
      {view === "list" && (
        <ReceiptNoteList
          reloadKey={reloadKey}
          onCreate={goCreate}
          onOpen={(rn) => setOpenRn(rn)}
          onEdit={goEdit}
        />
      )}
      {(view === "create" || view === "edit") && (
        <ReceiptNoteCreate
          editing={editingRn}
          onCancel={goList}
          onSaved={goList}
        />
      )}

      <ReceiptNoteDetailDialog rn={openRn} onClose={() => setOpenRn(null)} />
    </>
  );
}

/* --------------------------------------------------------------
   List view — Receipt Notes
   -------------------------------------------------------------- */
const PAGE_SIZE = 5000;

function ReceiptNoteList({ reloadKey, onCreate, onOpen, onEdit }) {
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
            const res = await api.get("/receipt-notes", { params: { page, page_size: PAGE_SIZE, search: search || undefined } });
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


  const handleDelete = async (rn) => {
    if (!window.confirm(`Delete Receipt Note ${rn.rn_no}?\n\nThis cannot be undone.`)) return;
    try {
      await api.delete(`/receipt-notes/${rn.id}`);
      toast.success(`${rn.rn_no} deleted`);
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not delete");
    }
  };

  // Total qty in the list = sum of received_qty (or invoice_qty if not yet received).
  const totalQtyOf = (r) =>
    (r.items || []).reduce((s, it) => s + (toNum(it.received_qty) ?? toNum(it.invoice_qty) ?? 0), 0);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const columns = useMemo(() => [
    { key: "stock_in_type", label: "STOCK IN TYPE", value: (r) => stockInTypeLabel(r.stock_in_type) },
    { key: "rn_date", label: "RECEIPT NOTE DATE", value: (r) => fmtDate(r.rn_date) },
    { key: "rn_no", label: "RECEIPT NOTE NO", value: (r) => r.rn_no || "" },
    { key: "goods_received_date", label: "MATERIAL RECEIVED DATE", value: (r) => fmtDate(r.goods_received_date) },
    { key: "invoice_date", label: "INVOICE DATE", value: (r) => fmtDate(r.invoice_date) },
    { key: "invoice_no", label: "INVOICE NO", value: (r) => r.invoice_no || "" },
    { key: "items_count", label: "ITEMS", value: (r) => (r.items || []).length, isQty: true, isNumeric: true },
    { key: "total_qty", label: "TOTAL QUANTITY", value: totalQtyOf, isQty: true, isNumeric: true },
    { key: "status", label: "STATUS", value: (r) => statusMeta(r.status).label },
    { key: "assigned_to", label: "ASSIGNED TO", value: (r) => r.assigned_to_name || r.assigned_to_email || "" },
  ], []);

  // colFilters: { [colKey]: Set<string of allowed values> } | sort: { key, dir } | null
  const {
    filteredRows, uniqueValues, colFilters, setColFilter, sort, setColumnSort,
  } = useExcelTableFilter(rows, columns);

  const handleExport = () => {
    if (filteredRows.length === 0) { toast.error("No rows to export"); return; }
    const exportCols = [
      { label: "Sl No", value: (r) => filteredRows.indexOf(r) + 1 },
      ...columns,
    ];
    exportToExcel(filteredRows, exportCols, `Receipt_Notes_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <div className="mt-4" data-testid="rn-list-view">
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div className="text-sm text-slate-600">
          {total === 0 ? "No receipt notes yet." : <>Showing <span className="font-semibold text-slate-900">{filteredRows.length}</span> of <span className="font-semibold text-slate-900">{total}</span> receipt notes</>}
        </div>
        <div className="flex items-center gap-2">
<Input
            ref={searchInputRef}     
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search RN no, invoice, dates, part no..."
            className="rounded-sm font-mono h-9 w-80"
            data-testid="rn-search-input"
          />
          <Button onClick={handleExport} variant="outline" className="rounded-sm border-slate-300" data-testid="rn-export-button">
            <DownloadSimple size={14} weight="bold" className="mr-2" /> Export
          </Button>
          <Button onClick={load} variant="outline" className="rounded-sm border-slate-300" disabled={loading} data-testid="rn-refresh-button">
            <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button onClick={onCreate} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="create-rn-button">
            <Plus size={16} weight="bold" className="mr-2" /> Create New Receipt Note
          </Button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm overflow-auto" style={{ maxHeight: "70vh" }}>
        <table className="data-table w-full">
          <thead className="sticky top-0 z-10 bg-slate-50">
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
              <th className="text-right">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r, idx) => {
              const totalQty = totalQtyOf(r);
              const isDraft = r.status === "DRAFT";
              // New policy: lock edit/delete ONLY when a Racking Note exists against this RN.
              // Falls back to the status-based heuristic for older API responses that lack the flag.
              const hasRacking = r.has_racking_note === true
                || (r.has_racking_note === undefined && (r.status === "FULLY_RACKED" || r.status === "PARTIALLY_RACKED"));
              // DRAFT bypasses assignee restriction (anyone with stock_in access can edit drafts).
              const isAssignedToOther = !isDraft && !!r.assigned_to_user_id && r.assigned_to_user_id !== me?.id && !isAdmin;
              const lockEdit = hasRacking || isAssignedToOther;
              const editTitle = hasRacking
                ? "Cannot edit — racking notes exist for this receipt"
                : (isAssignedToOther ? `Locked — assigned to ${r.assigned_to_name || r.assigned_to_email}` : "Edit");
              const deleteTitle = hasRacking
                ? "Cannot delete — racking notes exist for this receipt"
                : (isAssignedToOther ? `Locked — assigned to ${r.assigned_to_name || r.assigned_to_email}` : "Delete");
              const sm = statusMeta(r.status);
              return (
                <tr key={r.id} data-testid={`rn-row-${r.rn_no}`}>
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td>
  {(() => { const sit = stockInTypeMeta(r.stock_in_type); return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${sit.cls}`}
      data-testid={`rn-stock-in-type-${r.rn_no}`}>
      {sit.label}
    </span>
  ); })()}
</td>
<td className="font-mono text-slate-700">{fmtDate(r.rn_date)}</td>
<td>
  <button
    onClick={() => onOpen(r)}
    className="font-mono font-semibold text-blue-700 hover:underline"
    data-testid={`rn-open-${r.rn_no}`}
  >
    {r.rn_no}
  </button>
</td>
<td className="font-mono text-slate-700">{fmtDate(r.goods_received_date)}</td>
<td className="font-mono text-slate-700">{fmtDate(r.invoice_date)}</td>
<td className="font-mono text-slate-700">{r.invoice_no || "—"}</td>
                  <td className="text-right font-mono text-slate-600">{(r.items || []).length}</td>
                  <td className="text-right font-mono font-bold text-slate-900">{totalQty}</td>
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${sm.cls}`}
                      data-testid={`rn-status-${r.rn_no}`}>
                      {sm.label}
                    </span>
                  </td>
                  <td>
                    <AssigneeBadge name={r.assigned_to_name} email={r.assigned_to_email} testid={`rn-assignee-${r.rn_no}`} />
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <button
                      onClick={() => onEdit(r)}
                      disabled={lockEdit}
                      title={editTitle}
                      className={`p-1.5 rounded-sm mr-1 ${lockEdit ? "text-slate-300 cursor-not-allowed" : "hover:bg-slate-100"}`}
                      data-testid={`rn-edit-${r.rn_no}`}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => handleDelete(r)}
                      disabled={lockEdit}
                      title={deleteTitle}
                      className={`p-1.5 rounded-sm ${lockEdit ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                      data-testid={`rn-delete-${r.rn_no}`}
                    >
                      <Trash size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && (
              <tr><td colSpan={12} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? "No receipt notes. Click 'Create New Receipt Note' to begin." : "No rows match the current filters.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between mt-3 text-xs text-slate-600">
        <span>{total > 0 && <>Page {page} of {totalPages}</>}</span>
        <div className="flex items-center gap-2">
          <Button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading} variant="outline" size="sm" className="rounded-sm h-7">
            <CaretLeft size={12} weight="bold" className="mr-1" /> Prev
          </Button>
          <Button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages || loading} variant="outline" size="sm" className="rounded-sm h-7">
            Next <CaretRight size={12} weight="bold" className="ml-1" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------
   Detail dialog (read-only) — shows new schema and a Print button
   -------------------------------------------------------------- */
export function ReceiptNoteDetailDialog({ rn, onClose }) {
  const handlePrint = () => printReceiptNote(rn);
  return (
    <Dialog open={!!rn} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl rounded-sm" data-testid="rn-detail-dialog">
        {rn && (
          <>
            <DialogHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <DialogTitle className="text-2xl font-black font-mono">{rn.rn_no}</DialogTitle>
                  {(() => { const sit = stockInTypeMeta(rn.stock_in_type); return (
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-sm ${sit.cls}`}
                      data-testid="rn-detail-stock-in-type">
                      {sit.label} Stock In
                    </span>
                  ); })()}
                </div>
                <div className="flex items-center gap-2 mr-6">
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-sm ${statusMeta(rn.status).cls}`}>
                    {statusMeta(rn.status).label}
                  </span>
                  <Button onClick={handlePrint} variant="outline" size="sm" className="rounded-sm" data-testid="rn-detail-print">
                    <Printer size={14} weight="bold" className="mr-1.5" /> Print
                  </Button>
                </div>
              </div>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-4 text-sm border-b border-slate-200 pb-4 mb-4">
              <Detail k="Receipt Note Date" v={fmtDate(rn.rn_date)} />
              <Detail k="Financial Year" v={rn.fy ? `FY ${rn.fy}` : "—"} />
              <Detail k="Invoice Date" v={fmtDate(rn.invoice_date)} />
              <Detail k="Invoice No" v={rn.invoice_no || "—"} />
              <Detail k="Goods Received Date" v={fmtDate(rn.goods_received_date)} />
              <Detail k="Created By" v={rn.created_by || "—"} />
              <Detail k="Created At" v={rn.created_at ? new Date(rn.created_at).toLocaleString() : "—"} />
              <Detail k="Finalized At" v={rn.finalized_at ? new Date(rn.finalized_at).toLocaleString() : "—"} />
              <div className="col-span-2">
                <div className="label-sm">Assigned To</div>
                <div className="mt-1"><AssigneeBadge name={rn.assigned_to_name} email={rn.assigned_to_email} /></div>
              </div>
            </div>
            <div>
              <div className="label-sm mb-2">Items ({(rn.items || []).length})</div>
              <table className="data-table w-full">
                <thead>
                  <tr>
                    <th className="w-14">SL NO</th>
                    <th>PART NO</th>
                    <th>DESCRIPTION 1</th>
                    <th className="text-right">INVOICE QTY</th>
                    <th className="text-right">RECEIVED QTY</th>
                    <th className="text-right">QTY DIFF</th>
                    <th>MAKE</th>
                  </tr>
                </thead>
                <tbody>
                  {(rn.items || []).map((it, idx) => {
                    const diff = qtyDiff(it);
                    const diffCls = diff < 0 ? "text-red-700" : diff > 0 ? "text-amber-700" : "text-slate-500";
                    return (
                      <tr key={idx}>
                        <td className="font-mono text-slate-500">{idx + 1}</td>
                        <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                        <td className="text-slate-700">{it.description_1 || "—"}</td>
                        <td className="text-right font-mono">{toNum(it.invoice_qty) ?? "—"}</td>
                        <td className="text-right font-mono">{toNum(it.received_qty) ?? "—"}</td>
                        <td className={`text-right font-mono font-bold ${diffCls}`}>
                          {toNum(it.received_qty) == null ? "—" : (diff > 0 ? `+${diff}` : diff)}
                        </td>
                        <td>{it.make}</td>
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

/* --------------------------------------------------------------
   Print view — opens a new window with a print-friendly layout
   -------------------------------------------------------------- */
function printReceiptNote(rn) {
  if (!rn) return;
  const sm = statusMeta(rn.status);
  const sit = stockInTypeMeta(rn.stock_in_type);
  const items = (rn.items || []).map((it, idx) => {
    const inv = toNum(it.invoice_qty) ?? "—";
    const rec = toNum(it.received_qty);
    const diff = qtyDiff(it);
    const diffStr = rec == null ? "—" : (diff > 0 ? `+${diff}` : diff);
    return `<tr>
      <td>${idx + 1}</td>
      <td><strong>${escapeHtml(it.part_no || "")}</strong></td>
      <td>${escapeHtml(it.description_1 || "—")}</td>
      <td style="text-align:right">${inv}</td>
      <td style="text-align:right">${rec ?? "—"}</td>
      <td style="text-align:right">${diffStr}</td>
      <td>${escapeHtml(it.make || "")}</td>
    </tr>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<title>${escapeHtml(rn.rn_no)} — Receipt Note</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 32px; color: #0f172a; }
  h1 { font-size: 28px; font-weight: 900; margin: 0 0 6px; letter-spacing: -0.02em; }
  .muted { color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
  .pill { display: inline-block; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; background: #f1f5f9; color: #334155; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin: 24px 0; padding: 16px; border: 1px solid #e2e8f0; border-radius: 4px; }
  .field-label { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; }
  .field-value { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 14px; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
  th { text-align: left; padding: 8px; background: #f1f5f9; border-bottom: 2px solid #cbd5e1; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  td { padding: 8px; border-bottom: 1px solid #e2e8f0; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .footer { margin-top: 32px; font-size: 11px; color: #94a3b8; }
  @media print { body { padding: 12mm; } }
</style></head>
<body>
  <div style="display:flex;justify-content:space-between;align-items:flex-start;">
    <div>
      <div class="muted">Receipt Note · <span style="color:#334155;font-weight:700;">${escapeHtml(sit.label)} Stock In</span></div>
      <h1>${escapeHtml(rn.rn_no)}</h1>
    </div>
    <span class="pill">${escapeHtml(sm.label)}</span>
  </div>
  <div class="grid">
    <div><div class="field-label">Receipt Note Date</div><div class="field-value">${escapeHtml(fmtDate(rn.rn_date))}</div></div>
    <div><div class="field-label">Stock In Type</div><div class="field-value">${escapeHtml(sit.label)}</div></div>
    <div><div class="field-label">Financial Year</div><div class="field-value">FY ${escapeHtml(rn.fy || "—")}</div></div>
    <div><div class="field-label">Invoice Date</div><div class="field-value">${escapeHtml(fmtDate(rn.invoice_date))}</div></div>
    <div><div class="field-label">Invoice No</div><div class="field-value">${escapeHtml(rn.invoice_no || "—")}</div></div>
    <div><div class="field-label">Goods Received Date</div><div class="field-value">${escapeHtml(fmtDate(rn.goods_received_date))}</div></div>
    <div><div class="field-label">Created By</div><div class="field-value">${escapeHtml(rn.created_by || "—")}</div></div>
    <div><div class="field-label">Assigned To</div><div class="field-value">${escapeHtml(rn.assigned_to_name || rn.assigned_to_email || "—")}</div></div>
    <div><div class="field-label">Created At</div><div class="field-value">${escapeHtml(rn.created_at ? new Date(rn.created_at).toLocaleString() : "—")}</div></div>
  </div>
  <div class="muted" style="margin-top:24px;">Items (${(rn.items || []).length})</div>
  <table>
    <thead><tr>
      <th>Sl No</th><th>Part No</th><th>Description 1</th>
      <th style="text-align:right">Invoice Qty</th>
      <th style="text-align:right">Received Qty</th>
      <th style="text-align:right">Qty Diff</th>
      <th>Make</th>
    </tr></thead>
    <tbody>${items}</tbody>
  </table>
  <div class="footer">Printed ${escapeHtml(new Date().toLocaleString())}</div>
  <script>window.onload = () => { setTimeout(() => window.print(), 100); };</script>
</body></html>`;

  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) { toast.error("Popup blocked — allow popups for this site to print"); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* --------------------------------------------------------------
   Create / Edit view — the form (split qty + Draft/Final + Excel)
   -------------------------------------------------------------- */
const emptyItem = () => ({
  part_no: "",
  make: "",
  invoice_qty: "",
  received_qty: "",
  description_1: "",
  makes: [],
  partLooked: false,
});

function ReceiptNoteCreate({ editing, onCancel, onSaved }) {
  const isEdit = !!editing;
  const isDraftEdit = isEdit && editing.status === "DRAFT";
  const isFinalEdit = isEdit && !isDraftEdit;

  const [rnNo, setRnNo] = useState("");
  const [rnDate, setRnDate] = useState("");
  const [stockInType, setStockInType] = useState("INVOICE"); // "INVOICE" | "GENERAL"
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [goodsReceivedDate, setGoodsReceivedDate] = useState("");
  const [items, setItems] = useState([emptyItem()]);
  const [addCount, setAddCount] = useState("");
  const [savingDraft, setSavingDraft] = useState(false);
  const [savingFinal, setSavingFinal] = useState(false);
  const [assignedToUserId, setAssignedToUserId] = useState("");

  const [masterDialog, setMasterDialog] = useState(null);
  const fileInputRef = useRef(null);
  const draftBtnRef = useRef(null);
  const finalBtnRef = useRef(null);

  const isGeneral = stockInType === "GENERAL";

  // On mount: populate from editing or fetch next preview
  useEffect(() => {
    if (isEdit) {
      setRnNo(editing.rn_no || "");
      setRnDate(editing.rn_date || "");
      setStockInType((editing.stock_in_type || "INVOICE").toUpperCase());
      setInvoiceNo(editing.invoice_no || "");
      setInvoiceDate(editing.invoice_date || "");
      setGoodsReceivedDate(editing.goods_received_date || "");
      setAssignedToUserId(editing.assigned_to_user_id || "");
      const initial = (editing.items || []).map((it) => ({
        part_no: it.part_no || "",
        make: it.make || "",
        invoice_qty: (it.invoice_qty ?? it.quantity ?? ""),
        received_qty: (it.received_qty ?? (isFinalEdit ? (it.quantity ?? "") : "")),
        description_1: it.description_1 || "",
        makes: it.make ? [it.make] : [],
        partLooked: !!it.part_no,
      }));
      setItems(initial.length ? initial : [emptyItem()]);
      // Refresh make lists
      initial.forEach((row, idx) => {
        if (!row.part_no) return;
        api.get("/stock-master/lookup/makes", { params: { part_no: row.part_no } })
          .then(({ data }) => {
            const list = data.makes || [];
            const merged = row.make && !list.includes(row.make) ? [...list, row.make] : list;
            setItems((prev) => prev.map((r, i) => i === idx ? { ...r, makes: merged } : r));
          }).catch(() => {});
      });
    } else {
      api.get("/receipt-notes/next-no").then((r) => {
        setRnNo(r.data.next_rn_no);
        setRnDate(r.data.rn_date);
      }).catch(() => toast.error("Could not preview receipt-note number"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, isEdit]);

  // When switching to GENERAL, clear invoice fields and any saved invoice qty values
  useEffect(() => {
    if (isGeneral) {
      setInvoiceNo("");
      setInvoiceDate("");
    }
    // Don't auto-clear on switch to INVOICE — user may want to re-enter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stockInType]);

  const addItem = () => {
    const n = Math.max(1, Math.min(500, parseInt(addCount, 10) || 1));
    setItems((p) => [...p, ...Array.from({ length: n }, emptyItem)]);
    setAddCount("");
  };
  const removeItem = (i) => setItems((p) => (p.length === 1 ? p : p.filter((_, idx) => idx !== i)));
  const updateItem = (i, patch) => setItems((p) => p.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  // Lookup makes when Part No is entered
  const lookupMakes = async (i, partNo) => {
    const v = (partNo || "").trim();
    if (!v) {
      updateItem(i, { makes: [], make: "", partLooked: false, description_1: "" });
      return;
    }
    try {
      const { data } = await api.get("/stock-master/lookup/makes", { params: { part_no: v } });
      const list = data.makes || [];
      // If exactly one make is auto-selected, also fetch description_1 for that pair
      const autoMake = list.length === 1 ? list[0] : "";
      updateItem(i, { makes: list, partLooked: true, make: autoMake });
      if (autoMake) {
        try {
          const { data: m } = await api.get("/stock-master/lookup/item", { params: { part_no: v, make: autoMake } });
          updateItem(i, { description_1: m.description_1 || "" });
        } catch { /* ignore */ }
      } else {
        updateItem(i, { description_1: "" });
      }
    } catch {
      updateItem(i, { makes: [], partLooked: true, make: "", description_1: "" });
    }
  };

  // Fetch description_1 when make is picked
  const fetchDescription = async (i, partNo, make) => {
    if (!partNo || !make) return;
    try {
      const { data } = await api.get("/stock-master/lookup/item", { params: { part_no: partNo, make } });
      updateItem(i, { description_1: data.description_1 || "" });
    } catch { /* ignore */ }
  };

  const handleMakeChange = (i, value) => {
    if (value === "__create__") {
      const row = items[i];
      if (!row.part_no.trim()) {
        toast.error("Enter Part No first");
        return;
      }
      setMasterDialog({ rowIdx: i, part_no: row.part_no.trim() });
    } else {
      // Picking a make that already exists in the master list clears the masterMissing flag.
      updateItem(i, { make: value, masterMissing: false });
      const row = items[i];
      fetchDescription(i, row.part_no.trim(), value);
    }
  };

  const handleMasterCreated = (newItem) => {
    if (masterDialog == null) return;
    const i = masterDialog.rowIdx;
    setItems((prev) => prev.map((r, idx) => idx === i
      ? { ...r, makes: [...new Set([...(r.makes || []), newItem.make])], make: newItem.make, partLooked: true, description_1: newItem.description_1 || "", masterMissing: false }
      : r));
    setMasterDialog(null);
    toast.success(`Master created: ${newItem.part_no} / ${newItem.make}`);
  };

  /* ---- Excel template download ---- */
  const handleDownloadTemplate = () => {
    // Template columns match handleExcelImport's header parser (case-/separator-insensitive).
    // Include 2 hint rows showing a generic example + an empty row the user can fill in.
    const ws = XLSX.utils.aoa_to_sheet([
      ["Part No", "Invoice Qty", "Received Qty", "Make"],
      ["EXAMPLE-001", 10, 10, "ACME"],
      ["", "", "", ""],
    ]);
    ws["!cols"] = [{ wch: 18 }, { wch: 12 }, { wch: 14 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Receipt Note Template");
    XLSX.writeFile(wb, "Receipt_Note_Template.xlsx");
    toast.success("Template downloaded");
  };

  /* ---- Excel import ---- */
  const handleExcelImport = async (file) => {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
      if (!rows.length) { toast.error("Excel file has no rows"); return; }
      const norm = (s) => String(s || "").toLowerCase().replace(/[\s_-]+/g, "");
      const pickCol = (row, names) => {
        const map = {};
        Object.keys(row).forEach((k) => { map[norm(k)] = k; });
        for (const n of names) {
          const k = map[norm(n)];
          if (k != null) return row[k];
        }
        return "";
      };
      const newRows = [];
      for (const row of rows) {
        const part_no = String(pickCol(row, ["part no", "partno", "part_no", "part number"]) || "").trim();
        const invQ = pickCol(row, ["invoice qty", "invoice_qty", "inv qty", "invqty", "invoice quantity"]);
        const make = String(pickCol(row, ["make"]) || "").trim();
        const recQ = pickCol(row, ["received qty", "received_qty", "rec qty", "recqty", "received quantity"]);
        if (!part_no && (invQ === "" || invQ == null) && (recQ === "" || recQ == null)) continue;
        if (!part_no) { toast.error("Skipped row — Part No missing"); continue; }
        // In GENERAL mode, invoice_qty is ignored (will be forced to received_qty server-side).
        let inv = parseFloat(invQ);
        if (isGeneral) {
          inv = ""; // not used
        } else {
          if (isNaN(inv) || inv <= 0) { toast.error(`Row for ${part_no} skipped — Invoice Qty must be > 0`); continue; }
        }
        const rec = recQ === "" || recQ == null ? "" : (isNaN(parseFloat(recQ)) ? "" : parseFloat(recQ));
        newRows.push({
          part_no, make,
          invoice_qty: inv,
          received_qty: rec,
          description_1: "",
          makes: make ? [make] : [],
          partLooked: false,
        });
      }
      if (!newRows.length) { toast.error("No valid rows found in file"); return; }
      setItems((prev) => {
        const onlyEmpty = prev.length === 1 && !prev[0].part_no && !prev[0].invoice_qty && !prev[0].received_qty;
        return onlyEmpty ? newRows : [...prev, ...newRows];
      });
      newRows.forEach((row) => {
        setTimeout(() => {
          api.get("/stock-master/lookup/makes", { params: { part_no: row.part_no } })
            .then(({ data }) => {
              const list = data.makes || [];
              setItems((prev) => prev.map((r) => {
                if (r.part_no !== row.part_no) return r;
                const merged = r.make && !list.includes(r.make) ? [...list, r.make] : list;
                const auto = r.make || (list.length === 1 ? list[0] : "");
                // masterMissing: row has a make from Excel that's NOT in the master's make list,
                // OR part_no has no masters at all. The user must create a master via "+ Create New Make".
                const makeToCheck = auto || r.make;
                const masterMissing = makeToCheck ? !list.includes(makeToCheck) : list.length === 0;
                return { ...r, makes: merged, partLooked: true, make: auto, masterMissing };
              }));
              // Fetch description for any auto-resolved make
              setTimeout(() => {
                setItems((cur) => {
                  cur.forEach((r, idx) => {
                    if (r.part_no === row.part_no && r.make && !r.description_1 && !r.masterMissing) {
                      api.get("/stock-master/lookup/item", { params: { part_no: r.part_no, make: r.make } })
                        .then(({ data: m }) => {
                          setItems((p) => p.map((rr, i) => i === idx ? { ...rr, description_1: m.description_1 || "" } : rr));
                        }).catch(() => {});
                    }
                  });
                  return cur;
                });
              }, 0);
            }).catch(() => {
              // Lookup itself failed — flag the row as master-missing so user is prompted.
              setItems((prev) => prev.map((r) => r.part_no === row.part_no ? { ...r, partLooked: true, masterMissing: true } : r));
            });
        }, 0);
      });
      toast.success(`Imported ${newRows.length} row${newRows.length > 1 ? "s" : ""} from Excel`);
    } catch (err) {
      toast.error("Could not read Excel file");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  /* ---- Validation ---- */
  const validateBaseRows = () => {
    if (items.length === 0) { toast.error("Add at least one item"); return false; }
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      if (!it.part_no.trim()) { toast.error(`Row ${idx + 1}: Part No is required`); return false; }
      if (!it.make.trim()) { toast.error(`Row ${idx + 1}: Make is required`); return false; }
      if (!isGeneral) {
        const inv = toNum(it.invoice_qty);
        if (inv == null || inv <= 0) { toast.error(`Row ${idx + 1}: Invoice Qty must be > 0`); return false; }
      }
      const rec = toNum(it.received_qty);
      if (rec != null && rec < 0) { toast.error(`Row ${idx + 1}: Received Qty cannot be negative`); return false; }
    }
    return true;
  };

  const validateDates = () => {
    if (invoiceDate && invoiceDate > todayISO()) { toast.error("Invoice Date cannot be in the future"); return false; }
    if (goodsReceivedDate && goodsReceivedDate > todayISO()) { toast.error("Goods Received Date cannot be in the future"); return false; }
    return true;
  };

  // Received Qty may be 0 (treated as "nothing received yet"). We only require
  // it to be a non-negative number (null/empty is treated as 0 server-side).
  const allReceivedValid = useMemo(
    () => items.length > 0 && items.every((it) => {
      if (it.received_qty === "" || it.received_qty === null || it.received_qty === undefined) return true;
      const r = toNum(it.received_qty);
      return r !== null && r >= 0;
    }),
    [items]
  );

  const allMakesFilled = useMemo(
    () => items.length > 0 && items.every((it) => it.part_no.trim() && it.make.trim()),
    [items]
  );

  // Final Save is enabled when: every row has part_no/make and received_qty is a non-negative number
  // (or empty, treated as 0). Dates + invoice_no are all optional.
  const canFinalize = useMemo(() => {
    if (!allMakesFilled || !allReceivedValid) return false;
    if (!isGeneral) {
      if (!items.every((it) => (toNum(it.invoice_qty) || 0) > 0)) return false;
    }
    if (invoiceDate && invoiceDate > todayISO()) return false;
    if (goodsReceivedDate && goodsReceivedDate > todayISO()) return false;
    return true;
  }, [items, allMakesFilled, allReceivedValid, invoiceDate, goodsReceivedDate, isGeneral]);

  const buildPayload = () => ({
    stock_in_type: stockInType,
    invoice_no: isGeneral ? "" : invoiceNo.trim(),
    invoice_date: isGeneral ? "" : (invoiceDate || ""),
    goods_received_date: goodsReceivedDate || "",
    assigned_to_user_id: assignedToUserId || null,
    items: items.map((it) => ({
      part_no: it.part_no.trim(),
      make: it.make.trim(),
      // In GENERAL mode the server forces invoice_qty = received_qty. Send 0 here; the server overrides.
      invoice_qty: isGeneral ? (toNum(it.received_qty) || 0) : toNum(it.invoice_qty),
      received_qty: toNum(it.received_qty),
    })),
  });

  const saveDraft = async () => {
    if (!validateBaseRows()) return;
    if (!validateDates()) return;
    setSavingDraft(true);
    try {
      const payload = buildPayload();
      const { data } = isEdit
        ? await api.put(`/receipt-notes/${editing.id}`, payload)
        : await api.post("/receipt-notes", payload);
      toast.success(`Draft saved · ${data.rn_no}`);
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save draft");
    } finally { setSavingDraft(false); }
  };

  const saveFinal = async () => {
    if (!validateBaseRows()) return;
    if (!validateDates()) return;
    // Received Qty may be 0 (treated as "nothing received yet"). No explicit > 0 check.
    setSavingFinal(true);
    try {
      const payload = buildPayload();
      let rnId, rnNoDisplay;
      if (isEdit) {
        const { data } = await api.put(`/receipt-notes/${editing.id}`, payload);
        rnId = data.id; rnNoDisplay = data.rn_no;
      } else {
        const { data } = await api.post("/receipt-notes", payload);
        rnId = data.id; rnNoDisplay = data.rn_no;
      }
      const fresh = await api.get(`/receipt-notes/${rnId}`);
      if (fresh.data.status === "DRAFT") {
        await api.post(`/receipt-notes/${rnId}/finalize`);
      }
      toast.success(`Receipt Note ${rnNoDisplay} finalized`);
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not finalize receipt note");
    } finally { setSavingFinal(false); }
  };

  // Last-row Tab → focus first save button. Save Final takes priority if available.
  const handleLastRowKey = (e, isLastRow) => {
    if (!isLastRow) return;
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const target = canFinalize ? finalBtnRef.current : draftBtnRef.current;
      if (target) target.focus();
    }
  };

  return (
    <div className="mt-4 space-y-6" data-testid="rn-create-view">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="rn-back-button">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
        <div className="flex items-center gap-2">
          {isEdit && (
            <Button onClick={() => printReceiptNote(editing)} variant="outline" className="rounded-sm" data-testid="rn-print-button">
              <Printer size={14} weight="bold" className="mr-2" /> Print
            </Button>
          )}
        </div>
      </div>

      {/* HEADER */}
      <div className="bg-white border border-slate-200 rounded-sm p-6 space-y-4">
        {/* Stock-in type radio — both radios are tabbable; Enter selects. */}
        <div className="flex items-center gap-6 flex-wrap">
          <Label className="label-sm">Stock In Type</Label>
          <label className="flex items-center gap-2 cursor-pointer" data-testid="rn-stock-in-type-invoice">
            <input
              type="radio"
              name="stock-in-type"
              value="INVOICE"
              checked={stockInType === "INVOICE"}
              onChange={() => setStockInType("INVOICE")}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setStockInType("INVOICE"); } }}
              disabled={isFinalEdit}
              tabIndex={isFinalEdit ? -1 : 0}
              className="accent-blue-700"
            />
            <span className="text-sm font-semibold text-slate-700">
              <Receipt size={14} weight="bold" className="inline mr-1" /> Invoice Stock In
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer" data-testid="rn-stock-in-type-general">
            <input
              type="radio"
              name="stock-in-type"
              value="GENERAL"
              checked={stockInType === "GENERAL"}
              onChange={() => setStockInType("GENERAL")}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setStockInType("GENERAL"); } }}
              disabled={isFinalEdit}
              tabIndex={isFinalEdit ? -1 : 0}
              className="accent-blue-700"
            />
            <span className="text-sm font-semibold text-slate-700">
              <PackageIcon size={14} weight="bold" className="inline mr-1" /> General Stock In
            </span>
          </label>
          {isGeneral && (
            <span className="text-xs text-slate-500 italic">
              Invoice fields blocked · Invoice Qty auto-equals Received Qty · No SRN/ERN auto-creation
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <Label className="label-sm">Receipt Note Date</Label>
            <Input value={fmtDate(rnDate)} disabled className="mt-2 rounded-sm font-mono bg-slate-50" data-testid="rn-date-input" />
            <div className="text-[11px] text-slate-500 mt-1">Auto · today's date</div>
          </div>
          <div>
            <Label className="label-sm">Receipt Note No</Label>
            <Input value={rnNo} disabled className="mt-2 rounded-sm font-mono font-semibold bg-blue-50 text-blue-900" data-testid="rn-no-input" />
            <div className="text-[11px] text-slate-500 mt-1">Auto · resets each FY</div>
          </div>
          <div>
            <Label className="label-sm">Material Received Date</Label>
            <Input
              type="date"
              value={goodsReceivedDate}
              max={todayISO()}
              onChange={(e) => setGoodsReceivedDate(e.target.value)}
              className="mt-2 rounded-sm font-mono"
              data-testid="rn-grd-input"
            />
            <div className="text-[11px] text-slate-500 mt-1">Optional · no future date</div>
          </div>
          <div>
            <Label className="label-sm">Invoice Date</Label>
            <Input
              type="date"
              value={invoiceDate}
              max={todayISO()}
              disabled={isGeneral}
              onChange={(e) => setInvoiceDate(e.target.value)}
              className={`mt-2 rounded-sm font-mono ${isGeneral ? "bg-slate-100 text-slate-400" : ""}`}
              data-testid="rn-invoice-date-input"
            />
            <div className="text-[11px] text-slate-500 mt-1">{isGeneral ? "Blocked · General mode" : "Optional · no future date"}</div>
          </div>
          <div>
            <Label className="label-sm">Invoice No</Label>
            <Input
              value={invoiceNo}
              disabled={isGeneral}
              onChange={(e) => setInvoiceNo(e.target.value)}
              placeholder={isGeneral ? "—" : "e.g. INV-1024"}
              className={`mt-2 rounded-sm font-mono ${isGeneral ? "bg-slate-100 text-slate-400" : ""}`}
              data-testid="rn-invoice-no-input"
            />
            <div className="text-[11px] text-slate-500 mt-1">{isGeneral ? "Blocked · General mode" : "Optional"}</div>
          </div>
          <div className="col-span-2 lg:col-span-3">
            <AssigneeSelect
              value={assignedToUserId}
              onChange={setAssignedToUserId}
              module="stock_in"
              testid="rn-assignee"
            />
          </div>
        </div>
      </div>

      {/* ITEMS */}
      <div className="bg-white border border-slate-200 rounded-sm">
        <div className="flex items-center justify-between p-4 border-b border-slate-200 flex-wrap gap-2">
          <div>
            <div className="label-sm">Items Received</div>
            <div className="text-xs text-slate-500 mt-0.5">{items.length} row{items.length !== 1 ? "s" : ""}</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => handleExcelImport(e.target.files?.[0])}
              className="hidden"
              data-testid="rn-excel-input"
            />
            <Button
              onClick={() => fileInputRef.current?.click()}
              variant="outline"
              className="rounded-sm"
              data-testid="rn-excel-import-button"
              title={isGeneral ? "Columns: Part No, Make, Received Qty" : "Columns: Part No, Invoice Qty, Make, Received Qty"}
            >
              <UploadSimple size={14} weight="bold" className="mr-1" /> Import Excel
            </Button>
            <Button
              onClick={handleDownloadTemplate}
              variant="outline"
              className="rounded-sm"
              data-testid="rn-excel-template-button"
              title="Download an empty Excel template (Part No, Invoice Qty, Received Qty, Make)"
            >
              <DownloadSimple size={14} weight="bold" className="mr-1" /> Download Template
            </Button>
            <Input
              type="number"
              min="1"
              max="500"
              value={addCount}
              onChange={(e) => setAddCount(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addItem(); } }}
              placeholder="Qty"
              className="rounded-sm font-mono h-9 w-24 text-center"
              data-testid="rn-add-row-count"
              title="Number of rows to add at once (default 1)"
            />
            <Button onClick={addItem} variant="outline" className="rounded-sm" data-testid="rn-add-row-button">
              <Plus size={14} weight="bold" className="mr-1" /> Add Row{addCount && parseInt(addCount, 10) > 1 ? "s" : ""}
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="w-14">SL NO</th>
                <th className="w-44">PART NO</th>
                <th>DESCRIPTION 1</th>
                <th className="w-28 text-right">{isGeneral ? "INV QTY" : "INVOICE QTY"}</th>
                <th className="w-28 text-right">RECEIVED QTY</th>
                <th className="w-24 text-right">QTY DIFF</th>
                <th className="w-56">MAKE</th>
                <th className="w-14"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => {
                // In GENERAL mode, qty diff is always 0 (invoice forced equal to received).
                const diff = isGeneral ? 0 : qtyDiff(it);
                const recFilled = toNum(it.received_qty) != null;
                const diffNonZero = !isGeneral && recFilled && diff !== 0;
                const recCls = `rounded-sm font-mono h-8 text-right ${diffNonZero ? "border-red-500 ring-1 ring-red-200" : ""}`;
                const diffCls = !recFilled
                  ? "text-slate-400"
                  : (diff < 0 ? "text-red-700 font-bold" : (diff > 0 ? "text-amber-700 font-bold" : "text-slate-500"));
                const isLastRow = idx === items.length - 1;

                // In GENERAL mode the displayed invoice qty mirrors received_qty (read-only).
                const displayedInvoice = isGeneral ? (it.received_qty || "") : it.invoice_qty;

                // Import flagged this row as master-missing: (part_no, make) combo not found in stock_master.
                const missingMaster = !!it.masterMissing;
                const rowCls = missingMaster ? "ring-2 ring-red-400 ring-inset bg-red-50/40" : "";

                return (
                  <tr
                    key={idx}
                    data-testid={`rn-item-row-${idx}`}
                    className={rowCls}
                    title={missingMaster ? "Master not found for this Part No / Make. Use the Make dropdown → + Create New Make to create it." : undefined}
                  >
                    <td className="font-mono text-slate-500">{idx + 1}</td>
                    <td>
                      <Input
                        value={it.part_no}
                        onChange={(e) => updateItem(idx, { part_no: e.target.value, partLooked: false, makes: [], make: "", description_1: "" })}
                        onBlur={(e) => lookupMakes(idx, e.target.value)}
                        placeholder="Enter part no"
                        className="rounded-sm font-mono h-8"
                        data-testid={`rn-part-no-${idx}`}
                      />
                    </td>
                    <td>
                      <div
                        className="text-xs text-slate-700 px-2 py-1 bg-slate-50 rounded-sm border border-slate-200 truncate"
                        title={it.description_1 || "—"}
                        data-testid={`rn-desc1-${idx}`}
                      >
                        {it.description_1 || <span className="text-slate-400 italic">(auto from master)</span>}
                      </div>
                    </td>
                    <td className="w-28">
                      <Input
                        type="number"
                        min="0.001"
                        step="any"
                        value={displayedInvoice}
                        disabled={isGeneral}
                        onChange={(e) => updateItem(idx, { invoice_qty: e.target.value })}
                        placeholder="0"
                        className={`rounded-sm font-mono h-8 text-right ${isGeneral ? "bg-slate-100 text-slate-400" : ""}`}
                        data-testid={`rn-invoice-qty-${idx}`}
                        title={isGeneral ? "Auto-mirrors Received Qty in General mode" : undefined}
                      />
                    </td>
                    <td className="w-28">
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        value={it.received_qty}
                        onChange={(e) => updateItem(idx, { received_qty: e.target.value })}
                        placeholder="0"
                        className={recCls}
                        data-testid={`rn-received-qty-${idx}`}
                        title={diffNonZero ? (diff < 0 ? `Short by ${Math.abs(diff)} — SRN will be auto-created on Final Save` : `Extra of ${diff} — ERN will be auto-created on Final Save`) : undefined}
                      />
                    </td>
                    <td className={`w-24 text-right font-mono ${diffCls}`} data-testid={`rn-qty-diff-${idx}`}>
                      {!recFilled ? "—" : (diff > 0 ? `+${diff}` : diff)}
                    </td>
                    <td className="w-56">
                      <MakeDropdown
                        value={it.make}
                        makes={it.makes}
                        partLooked={it.partLooked}
                        onChange={(v) => handleMakeChange(idx, v)}
                        onKeyDown={(e) => handleLastRowKey(e, isLastRow)}
                        testid={`rn-make-${idx}`}
                      />
                    </td>
                                        <td>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => {
                            const newRow = emptyItem();
                            setItems((prev) => {
                              const next = [...prev];
                              next.splice(idx + 1, 0, newRow);
                              return next;
                            });
                          }}
                          className="p-1.5 rounded-sm hover:bg-blue-50 text-blue-700"
                          title="Add row below"
                          data-testid={`rn-add-row-${idx}`}
                        >
                          <Plus size={14} />
                        </button>
                        <button
                          onClick={() => removeItem(idx)}
                          disabled={items.length === 1}
                          className={`p-1.5 rounded-sm ${items.length === 1 ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                          data-testid={`rn-remove-row-${idx}`}
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

        {!isGeneral && items.some((it) => qtyDiff(it) !== 0 && toNum(it.received_qty) != null) && (
          <div className="px-4 py-3 border-t border-slate-200 bg-amber-50 text-amber-900 text-sm flex items-start gap-2" data-testid="rn-diff-banner">
            <Warning size={16} weight="bold" className="mt-0.5 flex-shrink-0" />
            <div>
              Quantity differences detected. On <strong>Save Final</strong> the system will automatically create
              {items.some((it) => qtyDiff(it) < 0) && <> a <strong>Short Received Note (SRN)</strong> for shortfall rows</>}
              {items.some((it) => qtyDiff(it) < 0) && items.some((it) => qtyDiff(it) > 0) && " and"}
              {items.some((it) => qtyDiff(it) > 0) && <> an <strong>Extra Received Note (ERN)</strong> for overage rows</>}
              {". Check the matching tabs to finalize them when ready."}
            </div>
          </div>
        )}

        {/* SAVE BUTTONS — placed below items, right-aligned. Tab from last-row Make lands here. */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-slate-200 bg-slate-50">
          {!isFinalEdit && (
            <Button
              ref={draftBtnRef}
              onClick={saveDraft}
              disabled={savingDraft || savingFinal}
              variant="outline"
              className="rounded-sm border-blue-700 text-blue-700 hover:bg-blue-50"
              data-testid="rn-save-draft-button"
            >
              <FloppyDisk size={14} weight="bold" className="mr-2" />
              {savingDraft ? "Saving…" : "Save as Draft"}
            </Button>
          )}
          <Button
            ref={finalBtnRef}
            onClick={saveFinal}
            disabled={savingDraft || savingFinal || (!canFinalize && !isFinalEdit)}
            className="rounded-sm bg-blue-700 hover:bg-blue-800 disabled:bg-slate-300 disabled:cursor-not-allowed"
            data-testid="rn-save-final-button"
            title={!canFinalize && !isFinalEdit ? "Fill Part No and Make on every row to enable Final Save (Received Qty may be 0)" : (isFinalEdit ? "Update finalized receipt" : "Final Save — promotes to Racking")}
          >
            <CheckCircle size={14} weight="bold" className="mr-2" />
            {savingFinal ? "Saving…" : (isFinalEdit ? "Update Receipt Note" : "Save Final")}
          </Button>
        </div>
      </div>

      <CreateMasterDialog
        open={!!masterDialog}
        partNo={masterDialog?.part_no || ""}
        onClose={() => setMasterDialog(null)}
        onCreated={handleMasterCreated}
      />
    </div>
  );
}


/* --------------------------------------------------------------
   Make dropdown with the 3 conditional behaviours
   -------------------------------------------------------------- */
function MakeDropdown({ value, makes, partLooked, onChange, onKeyDown, testid }) {
  if (!partLooked) {
    return (
      <Select disabled value="" onValueChange={() => {}}>
        <SelectTrigger className="rounded-sm h-8 text-xs" data-testid={testid} onKeyDown={onKeyDown}>
          <SelectValue placeholder="Enter Part No first" />
        </SelectTrigger>
      </Select>
    );
  }
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className="rounded-sm h-8" data-testid={testid} onKeyDown={onKeyDown}>
        <SelectValue placeholder={makes.length === 0 ? "Not in master — pick option" : "Select make"} />
      </SelectTrigger>
      <SelectContent>
        {makes.map((m) => (
          <SelectItem key={m} value={m} data-testid={`${testid}-option-${m}`}>{m}</SelectItem>
        ))}
        <SelectItem value="__create__" data-testid={`${testid}-option-create`}>
          <span className="text-blue-700 font-semibold">+ Create New Master</span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

/* --------------------------------------------------------------
   Inline "Create New Master" dialog (Part No pre-filled)
   -------------------------------------------------------------- */
const emptyMaster = (partNo) => ({
  model: "", part_no: partNo, old_part_no: "", make_part_no: "",
  description_1: "", description_2: "",
  remarks_oem: "", remarks_others: "",
  make: "", item_category: "", reorder_level: 0, image: "",
});

function CreateMasterDialog({ open, partNo, onClose, onCreated }) {
  const [form, setForm] = useState(emptyMaster(partNo));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setForm(emptyMaster(partNo));
  }, [open, partNo]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.part_no.trim() || !form.make.trim()) {
      toast.error("Part No and Make are required");
      return;
    }
    setSaving(true);
    try {
      const payload = { ...form, reorder_level: Math.max(0, parseInt(form.reorder_level, 10) || 0) };
      const { data } = await api.post("/stock-master", payload);
      onCreated(data);
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not create master");
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl rounded-sm" data-testid="create-master-dialog">
        <DialogHeader>
          <DialogTitle className="text-xl font-black">Create New Stock Master</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Model" v={form.model} on={(v) => set("model", v)} testid="cm-model" />
          <Field label="Part No *" v={form.part_no} on={(v) => set("part_no", v)} testid="cm-part-no" />
          <Field label="Make *" v={form.make} on={(v) => set("make", v)} testid="cm-make" />
          <Field label="Item Category" v={form.item_category} on={(v) => set("item_category", v)} testid="cm-category" />
          <Field label="Old Part No." v={form.old_part_no} on={(v) => set("old_part_no", v)} testid="cm-old-part-no" />
          <Field label="Make Part No." v={form.make_part_no} on={(v) => set("make_part_no", v)} testid="cm-make-part-no" />
          <Field label="Description 1" v={form.description_1} on={(v) => set("description_1", v)} testid="cm-desc-1" />
          <Field label="Description 2" v={form.description_2} on={(v) => set("description_2", v)} testid="cm-desc-2" />
          <div>
            <Label className="label-sm">Remarks OEM</Label>
            <Textarea value={form.remarks_oem} onChange={(e) => set("remarks_oem", e.target.value)} rows={2} className="mt-2 rounded-sm" data-testid="cm-remarks-oem" />
          </div>
          <div>
            <Label className="label-sm">Remarks Others</Label>
            <Textarea value={form.remarks_others} onChange={(e) => set("remarks_others", e.target.value)} rows={2} className="mt-2 rounded-sm" data-testid="cm-remarks-others" />
          </div>
          <div>
            <Label className="label-sm">Reorder Level</Label>
            <Input type="number" min="0" value={form.reorder_level ?? ""}
              onChange={(e) => set("reorder_level", e.target.value === "" ? "" : Math.max(0, parseInt(e.target.value, 10) || 0))}
              className="mt-2 rounded-sm font-mono" data-testid="cm-reorder-level"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="rounded-sm" disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="cm-save-button">
            {saving ? "Saving…" : "Create & Use"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, v, on, testid }) {
  return (
    <div>
      <Label className="label-sm">{label}</Label>
      <Input value={v || ""} onChange={(e) => on(e.target.value)} className="mt-2 rounded-sm" data-testid={testid} />
    </div>
  );
}
/* ==============================================================
   PHASE 2 · Short Received Notes & Extra Received Notes
   Full list views with detail/edit/finalize/delete dialogs.
   ============================================================== */

/** SRN list and forms */
function ShortReceivedNoteTab() {
  const [view, setView] = useState("list");           // "list" | "edit"
  const [editing, setEditing] = useState(null);
  const [openDetail, setOpenDetail] = useState(null);
  const [openRn, setOpenRn] = useState(null);          // parent RN detail dialog
  const [reloadKey, setReloadKey] = useState(0);

  const goEdit = (srn) => { setEditing(srn); setView("edit"); };
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
        <ChildList
          kind="srn"
          reloadKey={reloadKey}
          onOpen={(r) => setOpenDetail(r)}
          onOpenRn={handleOpenRn}
          onEdit={goEdit}
          onChanged={() => setReloadKey((k) => k + 1)}
        />
      )}
      {view === "edit" && (
        <SrnFinalizeForm srn={editing} onCancel={goList} onSaved={goList} />
      )}
      <ChildDetailDialog kind="srn" doc={openDetail} onClose={() => setOpenDetail(null)} />
      <ReceiptNoteDetailDialog rn={openRn} onClose={() => setOpenRn(null)} />
    </>
  );
}

function ExtraReceivedNoteTab() {
  const [view, setView] = useState("list");
  const [editing, setEditing] = useState(null);
  const [openDetail, setOpenDetail] = useState(null);
  const [openRn, setOpenRn] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const goEdit = (ern) => { setEditing(ern); setView("edit"); };
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
        <ChildList
          kind="ern"
          reloadKey={reloadKey}
          onOpen={(r) => setOpenDetail(r)}
          onOpenRn={handleOpenRn}
          onEdit={goEdit}
          onChanged={() => setReloadKey((k) => k + 1)}
        />
      )}
      {view === "edit" && (
        <ErnFinalizeForm ern={editing} onCancel={goList} onSaved={goList} />
      )}
      <ChildDetailDialog kind="ern" doc={openDetail} onClose={() => setOpenDetail(null)} />
      <ReceiptNoteDetailDialog rn={openRn} onClose={() => setOpenRn(null)} />
    </>
  );
}

/** Shared list view for SRN + ERN. */
function ChildList({ kind, reloadKey, onOpen, onOpenRn, onEdit, onChanged }) {
  const isSrn = kind === "srn";
  const path = isSrn ? "/short-received-notes" : "/extra-received-notes";
  const idField = isSrn ? "srn_no" : "ern_no";
  const dateField = isSrn ? "srn_date" : "ern_date";
  const labelTitle = isSrn ? "Short Received Notes" : "Extra Received Notes";
  const noun = isSrn ? "SRN" : "ERN";

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(path);
      setRows(res.data || []);
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || `Could not load ${noun}s`);
    } finally { setLoading(false); }
  }, [path, noun]);
  useEffect(() => { load(); }, [load, reloadKey]);

  const handleDelete = async (r) => {
    if (!window.confirm(`Delete ${r[idField]}? This cannot be undone.`)) return;
    try {
      await api.delete(`${path}/${r.id}`);
      toast.success(`${r[idField]} deleted`);
      onChanged();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not delete");
    }
  };

  // Item-aggregation helpers for the list display
  const sumQty = (r) => {
    if (isSrn) {
      return (r.items || []).reduce((acc, it) => acc + (parseFloat(it.short_qty) || 0), 0);
    }
    return (r.items || []).reduce((acc, it) => acc + (parseFloat(it.extra_qty) || 0), 0);
  };

  const columns = useMemo(() => {
    const cols = [
      { key: "doc_date", label: `${noun} DATE`, value: (r) => fmtDate(r[dateField]) },
      { key: "doc_no", label: `${noun} NO`, value: (r) => r[idField] || "" },
      { key: "rn_date", label: "RN DATE", value: (r) => fmtDate(r.parent_rn_date) },
      { key: "rn_no", label: "RN NO", value: (r) => r.parent_rn_no || "" },
      { key: "items_count", label: "ITEMS", value: (r) => (r.items || []).length, isQty: true, isNumeric: true },
      { key: "qty_total", label: isSrn ? "TOTAL SHORT QTY" : "TOTAL EXTRA QTY", value: sumQty, isQty: true, isNumeric: true },
    ];
    if (isSrn) {
      cols.push({ key: "fulfillment_date", label: "FULFILMENT DATE", value: (r) => r.fulfillment_date ? fmtDate(r.fulfillment_date) : "" });
    }
    cols.push(
      { key: "assigned_to", label: "ASSIGNED TO", value: (r) => r.assigned_to_name || r.assigned_to_email || "" },
      { key: "status", label: "STATUS", value: (r) => statusMeta(r.status).label },
    );
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSrn, noun, dateField, idField]);

  const {
    filteredRows, uniqueValues, colFilters, setColFilter, sort, setColumnSort,
  } = useExcelTableFilter(rows, columns);

  return (
    <div className="mt-4" data-testid={`${kind}-list-view`}>
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div>
          <div className="label-sm">{labelTitle}</div>
          <div className="text-xs text-slate-500 mt-0.5">
            {isSrn
              ? "Auto-created from a Receipt Note's shortfall. Enter Fulfilled Qty when material arrives, then Save Final. Partial fulfilment auto-creates a child SRN for the residual."
              : "Auto-created from a Receipt Note's overage. Enter Accepted Qty (and optionally Rejected Qty) per row, then Save Final. Residual extra creates a child ERN."}
          </div>
        </div>
        <Button onClick={load} variant="outline" disabled={loading} className="rounded-sm border-slate-300" data-testid={`${kind}-refresh`}>
          <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>
      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto">
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
              <th className="w-28">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r, idx) => {
              const meta = statusMeta(r.status);
              const canEdit = isSrn
                ? !["COMPLETE", "FULLY_RECEIVED"].includes(r.status)
                : r.status !== "COMPLETE";
              return (
                <tr key={r.id} data-testid={`${kind}-row-${r[idField]}`}>
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td className="font-mono text-slate-700">{fmtDate(r[dateField])}</td>
                  <td>
                    <button
                      onClick={() => onOpen(r)}
                      className="font-mono font-semibold text-blue-700 hover:underline"
                      data-testid={`${kind}-open-${r[idField]}`}
                    >
                      {r[idField]}
                    </button>
                  </td>
                  <td className="font-mono text-slate-700">{fmtDate(r.parent_rn_date)}</td>
                  <td>
                    {r.parent_rn_no ? (
                      <button
                        onClick={() => onOpenRn?.(r.parent_rn_id)}
                        className="font-mono font-semibold text-blue-700 hover:underline"
                        data-testid={`${kind}-open-rn-${r.parent_rn_no}`}
                      >
                        {r.parent_rn_no}
                      </button>
                    ) : <span className="font-mono text-slate-400">—</span>}
                  </td>
                  <td className="text-right font-mono">{(r.items || []).length}</td>
                  <td className="text-right font-mono font-semibold">{sumQty(r).toFixed(2)}</td>
                  {isSrn && <td className="font-mono text-slate-700">{r.fulfillment_date ? fmtDate(r.fulfillment_date) : "—"}</td>}
                  <td className="text-slate-700">
                    {r.assigned_to_name ? <AssigneeBadge name={r.assigned_to_name} email={r.assigned_to_email} /> : <span className="text-slate-400">—</span>}
                  </td>
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${meta.cls}`}>
                      {meta.label}
                    </span>
                  </td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => onEdit(r)}
                        disabled={!canEdit}
                        className={`p-1.5 rounded-sm ${canEdit ? "hover:bg-blue-50 text-blue-700" : "text-slate-300 cursor-not-allowed"}`}
                        title={canEdit ? "Edit / Finalize" : (isSrn ? "Already fully received" : "Already complete")}
                        data-testid={`${kind}-edit-${r[idField]}`}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(r)}
                        className="p-1.5 rounded-sm hover:bg-red-50 text-red-700"
                        title="Delete"
                        data-testid={`${kind}-delete-${r[idField]}`}
                      >
                        <Trash size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && (
              <tr><td colSpan={isSrn ? 11 : 10} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? `No ${noun}s yet. They appear automatically when a Receipt Note is finalized with ${isSrn ? "a shortfall" : "an overage"}.` : "No rows match the current filters.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Read-only detail dialog for SRN/ERN — shows all rows with quantities. */
function ChildDetailDialog({ kind, doc, onClose }) {
  if (!doc) return null;
  const isSrn = kind === "srn";
  const idField = isSrn ? "srn_no" : "ern_no";
  const dateField = isSrn ? "srn_date" : "ern_date";
  const meta = statusMeta(doc.status);

  return (
    <Dialog open={!!doc} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl rounded-sm" data-testid={`${kind}-detail-dialog`}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span className="font-mono">{doc[idField]}</span>
            <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${meta.cls}`}>{meta.label}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
          <Detail k={`${isSrn ? "SRN" : "ERN"} Date`} v={fmtDate(doc[dateField])} />
          <Detail k="Parent RN" v={`${doc.parent_rn_no || "—"} (${fmtDate(doc.parent_rn_date) || "—"})`} />
          <Detail k="Invoice No" v={doc.invoice_no || "—"} />
          <Detail k="Invoice Date" v={fmtDate(doc.invoice_date)} />
          {isSrn && <Detail k="Fulfilment Date" v={fmtDate(doc.fulfillment_date)} />}
          <Detail k="Assigned To" v={doc.assigned_to_name || doc.assigned_to_email || "—"} />
          <Detail k="Created By" v={doc.created_by || "—"} />
          {doc.parent_srn_no && <Detail k="Parent SRN" v={doc.parent_srn_no} />}
          {doc.parent_ern_no && <Detail k="Parent ERN" v={doc.parent_ern_no} />}
        </div>
        {doc.chain_remarks && (
          <div className="text-xs text-slate-600 italic mt-2">{doc.chain_remarks}</div>
        )}
        <div className="overflow-x-auto mt-4">
          <table className="data-table w-full text-xs">
            <thead>
              <tr>
                <th className="w-10">#</th>
                <th>PART NO</th>
                <th>DESCRIPTION 1</th>
                <th>MAKE</th>
                <th className="text-right">INV QTY</th>
                <th className="text-right">RCVD QTY</th>
                {isSrn ? (
                  <>
                    <th className="text-right">SHORT QTY</th>
                    <th className="text-right">FULFILLED QTY</th>
                    <th className="text-right">PENDING QTY</th>
                  </>
                ) : (
                  <>
                    <th className="text-right">EXTRA QTY</th>
                    <th className="text-right">ACCEPTED QTY</th>
                    <th className="text-right">REJECTED QTY</th>
                    <th className="text-right">UNDECIDED</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {(doc.items || []).map((it, idx) => {
                if (isSrn) {
                  const shortQ = parseFloat(it.short_qty) || 0;
                  const ful = it.fulfilled_qty == null ? null : (parseFloat(it.fulfilled_qty) || 0);
                  const pending = ful == null ? shortQ : (shortQ - ful);
                  return (
                    <tr key={idx}>
                      <td className="font-mono text-slate-500">{idx + 1}</td>
                      <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                      <td className="text-slate-700">{it.description_1 || "—"}</td>
                      <td>{it.make}</td>
                      <td className="text-right font-mono">{(parseFloat(it.invoice_qty) || 0).toFixed(2)}</td>
                      <td className="text-right font-mono">{(parseFloat(it.received_qty) || 0).toFixed(2)}</td>
                      <td className="text-right font-mono font-bold text-red-700">{shortQ.toFixed(2)}</td>
                      <td className="text-right font-mono">{ful == null ? "—" : ful.toFixed(2)}</td>
                      <td className={`text-right font-mono font-bold ${pending > 0 ? "text-amber-700" : "text-green-700"}`}>{pending.toFixed(2)}</td>
                    </tr>
                  );
                }
                const extraQ = parseFloat(it.extra_qty) || 0;
                const acc = it.accepted_qty == null ? null : (parseFloat(it.accepted_qty) || 0);
                const rej = it.rejected_qty == null ? null : (parseFloat(it.rejected_qty) || 0);
                const undecided = extraQ - (acc || 0) - (rej || 0);
                return (
                  <tr key={idx}>
                    <td className="font-mono text-slate-500">{idx + 1}</td>
                    <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                    <td className="text-slate-700">{it.description_1 || "—"}</td>
                    <td>{it.make}</td>
                    <td className="text-right font-mono">{(parseFloat(it.invoice_qty) || 0).toFixed(2)}</td>
                    <td className="text-right font-mono">{(parseFloat(it.received_qty) || 0).toFixed(2)}</td>
                    <td className="text-right font-mono font-bold text-amber-700">{extraQ.toFixed(2)}</td>
                    <td className="text-right font-mono">{acc == null ? "—" : acc.toFixed(2)}</td>
                    <td className="text-right font-mono">{rej == null ? "—" : rej.toFixed(2)}</td>
                    <td className={`text-right font-mono font-bold ${undecided > 0 ? "text-amber-700" : "text-green-700"}`}>{undecided.toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** SRN finalize/edit form — user enters fulfilled_qty per row + fulfillment_date. */
function SrnFinalizeForm({ srn, onCancel, onSaved }) {
  const [items, setItems] = useState(() => (srn.items || []).map((it) => ({
    part_no: it.part_no,
    make: it.make,
    description_1: it.description_1 || "",
    invoice_qty: parseFloat(it.invoice_qty) || 0,
    received_qty: parseFloat(it.received_qty) || 0,
    short_qty: parseFloat(it.short_qty) || 0,
    fulfilled_qty: it.fulfilled_qty == null ? "" : it.fulfilled_qty,
  })));
  const [fulfillmentDate, setFulfillmentDate] = useState(srn.fulfillment_date || todayISO());
  const [savingDraft, setSavingDraft] = useState(false);
  const [savingFinal, setSavingFinal] = useState(false);
  const finalBtnRef = useRef(null);

  const updateItem = (i, patch) => setItems((p) => p.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  const buildPayload = () => ({
    fulfillment_date: fulfillmentDate || "",
    items: items.map((it) => ({
      part_no: it.part_no,
      make: it.make,
      fulfilled_qty: it.fulfilled_qty === "" ? null : (parseFloat(it.fulfilled_qty) || 0),
    })),
  });

  const validate = () => {
    if (fulfillmentDate && fulfillmentDate > todayISO()) {
      toast.error("Fulfilment Date cannot be in the future"); return false;
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const f = it.fulfilled_qty === "" ? null : parseFloat(it.fulfilled_qty);
      if (f != null) {
        if (isNaN(f) || f < 0) { toast.error(`Row ${i + 1}: Fulfilled Qty must be ≥ 0`); return false; }
        if (f > it.short_qty + 1e-6) { toast.error(`Row ${i + 1}: Fulfilled Qty (${f}) cannot exceed Short Qty (${it.short_qty})`); return false; }
      }
    }
    return true;
  };

  const saveDraft = async () => {
    if (!validate()) return;
    setSavingDraft(true);
    try {
      await api.put(`/short-received-notes/${srn.id}`, buildPayload());
      toast.success(`${srn.srn_no} saved`);
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save");
    } finally { setSavingDraft(false); }
  };

  const saveFinal = async () => {
    if (!validate()) return;
    // Require every row to have fulfilled_qty filled (>= 0; 0 is allowed → child SRN takes over)
    for (let i = 0; i < items.length; i++) {
      const f = items[i].fulfilled_qty;
      if (f === "" || f == null) {
        toast.error(`Row ${i + 1}: Fulfilled Qty is required for Final Save (use 0 if nothing arrived for this row)`);
        return;
      }
    }
    setSavingFinal(true);
    try {
      // Save the qty + date first
      await api.put(`/short-received-notes/${srn.id}`, buildPayload());
      // Then finalize (auto-creates child SRN if any row's fulfilled < short)
      const { data } = await api.post(`/short-received-notes/${srn.id}/finalize`);
      toast.success(`${srn.srn_no} finalized · ${statusMeta(data.status).label}`);
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not finalize");
    } finally { setSavingFinal(false); }
  };

  const handleLastRowKey = (e, isLastRow) => {
    if (!isLastRow) return;
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      finalBtnRef.current?.focus();
    }
  };

  return (
    <div className="mt-4 space-y-6" data-testid="srn-finalize-view">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="srn-back">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
        <div className="flex items-center gap-2">
          <Button
            onClick={saveDraft}
            disabled={savingDraft || savingFinal}
            variant="outline"
            className="rounded-sm border-blue-700 text-blue-700 hover:bg-blue-50"
            data-testid="srn-save-draft"
          >
            <FloppyDisk size={14} weight="bold" className="mr-2" />
            {savingDraft ? "Saving…" : "Save"}
          </Button>
          <Button
            ref={finalBtnRef}
            onClick={saveFinal}
            disabled={savingDraft || savingFinal}
            className="rounded-sm bg-blue-700 hover:bg-blue-800"
            data-testid="srn-save-final"
            title="Final Save · creates child SRN for any residual shortfall"
          >
            <CheckCircle size={14} weight="bold" className="mr-2" />
            {savingFinal ? "Saving…" : "Save Final"}
          </Button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm p-6 grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Detail k="SRN Date" v={fmtDate(srn.srn_date)} />
        <Detail k="SRN No" v={srn.srn_no} />
        <Detail k="Parent RN" v={`${srn.parent_rn_no || "—"} (${fmtDate(srn.parent_rn_date) || "—"})`} />
        <Detail k="Invoice No" v={srn.invoice_no || "—"} />
        <div>
          <Label className="label-sm">Fulfilment Date</Label>
          <Input
            type="date"
            value={fulfillmentDate}
            max={todayISO()}
            onChange={(e) => setFulfillmentDate(e.target.value)}
            className="mt-2 rounded-sm font-mono"
            data-testid="srn-fulfillment-date"
          />
          <div className="text-[11px] text-slate-500 mt-1">Date material arrived · no future date</div>
        </div>
        <Detail k="Status" v={<span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${statusMeta(srn.status).cls}`}>{statusMeta(srn.status).label}</span>} />
      </div>

      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto">
        <div className="px-4 py-3 border-b border-slate-200 label-sm">SHORT ITEMS — Enter Fulfilled Qty</div>
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-10">#</th>
              <th className="w-44">PART NO</th>
              <th>DESCRIPTION 1</th>
              <th className="w-28 text-right">INV QTY</th>
              <th className="w-28 text-right">RCVD QTY</th>
              <th className="w-28 text-right">SHORT QTY</th>
              <th className="w-32 text-right">FULFILLED QTY</th>
              <th className="w-28 text-right">PENDING QTY</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => {
              const f = it.fulfilled_qty === "" ? null : parseFloat(it.fulfilled_qty);
              const pending = f == null ? it.short_qty : (it.short_qty - f);
              const pendingCls = pending > 0 ? "text-amber-700 font-bold" : (pending < 0 ? "text-red-700 font-bold" : "text-green-700 font-bold");
              const isLastRow = idx === items.length - 1;
              return (
                <tr key={idx} data-testid={`srn-item-${idx}`}>
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                  <td className="text-slate-700 text-xs truncate max-w-[260px]" title={it.description_1}>{it.description_1 || "—"}</td>
                  <td className="text-right font-mono">{it.invoice_qty.toFixed(2)}</td>
                  <td className="text-right font-mono">{it.received_qty.toFixed(2)}</td>
                  <td className="text-right font-mono font-bold text-red-700">{it.short_qty.toFixed(2)}</td>
                  <td>
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      value={it.fulfilled_qty}
                      onChange={(e) => updateItem(idx, { fulfilled_qty: e.target.value })}
                      onKeyDown={(e) => handleLastRowKey(e, isLastRow)}
                      placeholder="0"
                      className="rounded-sm font-mono h-8 text-right"
                      data-testid={`srn-fulfilled-${idx}`}
                    />
                  </td>
                  <td className={`text-right font-mono ${pendingCls}`}>
                    {pending.toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="px-4 py-3 border-t border-slate-200 bg-blue-50 text-blue-900 text-xs">
          <strong>Note:</strong> Saving Final with any row where Fulfilled Qty &lt; Short Qty will auto-create a child SRN
          for the residual shortfall, linked to the original Receipt Note. The Fulfilled Qty entered here is immediately
          available to Racking — you don't need a fully-received SRN before racking.
        </div>
      </div>
    </div>
  );
}

/** ERN finalize/edit form — user enters accepted_qty + rejected_qty per row. */
function ErnFinalizeForm({ ern, onCancel, onSaved }) {
  const [items, setItems] = useState(() => (ern.items || []).map((it) => ({
    part_no: it.part_no,
    make: it.make,
    description_1: it.description_1 || "",
    invoice_qty: parseFloat(it.invoice_qty) || 0,
    received_qty: parseFloat(it.received_qty) || 0,
    extra_qty: parseFloat(it.extra_qty) || 0,
    accepted_qty: it.accepted_qty == null ? "" : it.accepted_qty,
    rejected_qty: it.rejected_qty == null ? "" : it.rejected_qty,
  })));
  const [savingDraft, setSavingDraft] = useState(false);
  const [savingFinal, setSavingFinal] = useState(false);
  const finalBtnRef = useRef(null);

  const updateItem = (i, patch) => setItems((p) => p.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  const buildPayload = () => ({
    items: items.map((it) => ({
      part_no: it.part_no,
      make: it.make,
      accepted_qty: it.accepted_qty === "" ? null : (parseFloat(it.accepted_qty) || 0),
      rejected_qty: it.rejected_qty === "" ? null : (parseFloat(it.rejected_qty) || 0),
    })),
  });

  const validate = () => {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const a = it.accepted_qty === "" ? null : parseFloat(it.accepted_qty);
      const r = it.rejected_qty === "" ? null : parseFloat(it.rejected_qty);
      if (a != null && (isNaN(a) || a < 0)) { toast.error(`Row ${i + 1}: Accepted Qty must be ≥ 0`); return false; }
      if (r != null && (isNaN(r) || r < 0)) { toast.error(`Row ${i + 1}: Rejected Qty must be ≥ 0`); return false; }
      if ((a || 0) + (r || 0) > it.extra_qty + 1e-6) {
        toast.error(`Row ${i + 1}: Accepted (${a || 0}) + Rejected (${r || 0}) cannot exceed Extra (${it.extra_qty})`);
        return false;
      }
    }
    return true;
  };

  const saveDraft = async () => {
    if (!validate()) return;
    setSavingDraft(true);
    try {
      await api.put(`/extra-received-notes/${ern.id}`, buildPayload());
      toast.success(`${ern.ern_no} saved`);
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save");
    } finally { setSavingDraft(false); }
  };

  const saveFinal = async () => {
    if (!validate()) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].accepted_qty === "" || items[i].accepted_qty == null) {
        toast.error(`Row ${i + 1}: Accepted Qty is required for Final Save (use 0 if nothing accepted for this row)`);
        return;
      }
    }
    setSavingFinal(true);
    try {
      await api.put(`/extra-received-notes/${ern.id}`, buildPayload());
      const { data } = await api.post(`/extra-received-notes/${ern.id}/finalize`);
      toast.success(`${ern.ern_no} finalized · ${statusMeta(data.status).label}`);
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not finalize");
    } finally { setSavingFinal(false); }
  };

  const handleLastRowKey = (e, isLastRow) => {
    if (!isLastRow) return;
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      finalBtnRef.current?.focus();
    }
  };

  return (
    <div className="mt-4 space-y-6" data-testid="ern-finalize-view">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="ern-back">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
        <div className="flex items-center gap-2">
          <Button
            onClick={saveDraft}
            disabled={savingDraft || savingFinal}
            variant="outline"
            className="rounded-sm border-blue-700 text-blue-700 hover:bg-blue-50"
            data-testid="ern-save-draft"
          >
            <FloppyDisk size={14} weight="bold" className="mr-2" />
            {savingDraft ? "Saving…" : "Save"}
          </Button>
          <Button
            ref={finalBtnRef}
            onClick={saveFinal}
            disabled={savingDraft || savingFinal}
            className="rounded-sm bg-blue-700 hover:bg-blue-800"
            data-testid="ern-save-final"
            title="Final Save · creates child ERN for any residual undecided extra"
          >
            <CheckCircle size={14} weight="bold" className="mr-2" />
            {savingFinal ? "Saving…" : "Save Final"}
          </Button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm p-6 grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Detail k="ERN Date" v={fmtDate(ern.ern_date)} />
        <Detail k="ERN No" v={ern.ern_no} />
        <Detail k="Parent RN" v={`${ern.parent_rn_no || "—"} (${fmtDate(ern.parent_rn_date) || "—"})`} />
        <Detail k="Invoice No" v={ern.invoice_no || "—"} />
        <Detail k="Status" v={<span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${statusMeta(ern.status).cls}`}>{statusMeta(ern.status).label}</span>} />
      </div>

      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto">
        <div className="px-4 py-3 border-b border-slate-200 label-sm">EXTRA ITEMS — Enter Accepted / Rejected Qty</div>
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-10">#</th>
              <th className="w-44">PART NO</th>
              <th>DESCRIPTION 1</th>
              <th className="w-24 text-right">INV QTY</th>
              <th className="w-24 text-right">RCVD QTY</th>
              <th className="w-24 text-right">EXTRA QTY</th>
              <th className="w-32 text-right">ACCEPTED QTY</th>
              <th className="w-32 text-right">REJECTED QTY</th>
              <th className="w-28 text-right">UNDECIDED</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => {
              const a = it.accepted_qty === "" ? 0 : (parseFloat(it.accepted_qty) || 0);
              const r = it.rejected_qty === "" ? 0 : (parseFloat(it.rejected_qty) || 0);
              const undecided = it.extra_qty - a - r;
              const undecidedCls = undecided > 0.0001 ? "text-amber-700 font-bold" : (undecided < -0.0001 ? "text-red-700 font-bold" : "text-green-700 font-bold");
              const isLastRow = idx === items.length - 1;
              return (
                <tr key={idx} data-testid={`ern-item-${idx}`}>
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                  <td className="text-slate-700 text-xs truncate max-w-[260px]" title={it.description_1}>{it.description_1 || "—"}</td>
                  <td className="text-right font-mono">{it.invoice_qty.toFixed(2)}</td>
                  <td className="text-right font-mono">{it.received_qty.toFixed(2)}</td>
                  <td className="text-right font-mono font-bold text-amber-700">{it.extra_qty.toFixed(2)}</td>
                  <td>
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      value={it.accepted_qty}
                      onChange={(e) => updateItem(idx, { accepted_qty: e.target.value })}
                      placeholder="0"
                      className="rounded-sm font-mono h-8 text-right"
                      data-testid={`ern-accepted-${idx}`}
                    />
                  </td>
                  <td>
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      value={it.rejected_qty}
                      onChange={(e) => updateItem(idx, { rejected_qty: e.target.value })}
                      onKeyDown={(e) => handleLastRowKey(e, isLastRow)}
                      placeholder="0"
                      className="rounded-sm font-mono h-8 text-right"
                      data-testid={`ern-rejected-${idx}`}
                    />
                  </td>
                  <td className={`text-right font-mono ${undecidedCls}`}>{undecided.toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="px-4 py-3 border-t border-slate-200 bg-blue-50 text-blue-900 text-xs">
          <strong>Note:</strong> Accepted Qty becomes available to Racking immediately. Rejected Qty is recorded but
          not racked (returned to supplier). If Accepted + Rejected &lt; Extra Qty for any row, a child ERN is auto-created
          for the residual undecided quantity.
        </div>
      </div>
    </div>
  );
}