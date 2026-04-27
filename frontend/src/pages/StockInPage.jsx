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
  DownloadSimple, ArrowsClockwise, UploadSimple, Printer, CheckCircle, Warning,
} from "@phosphor-icons/react";
import RackingNoteTab from "./RackingNoteTab";
import AssigneeSelect, { AssigneeBadge } from "../components/AssigneeSelect";
import { useAuth } from "../lib/auth";
import { useTableSortFilter, ColumnHeader } from "../components/DataTable";
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
function statusMeta(status) {
  switch (status) {
    case "DRAFT":
      return { label: "Draft", cls: "bg-slate-100 text-slate-700" };
    case "FINAL":
    case "RACKING_PENDING":
      return { label: "Racking Pending", cls: "bg-amber-50 text-amber-700" };
    case "PARTIALLY_RACKED":
      return { label: "Partially Racked", cls: "bg-blue-50 text-blue-800" };
    case "FULLY_RACKED":
      return { label: "Fully Racked", cls: "bg-green-100 text-green-800" };
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
          <TabsTrigger value="racking-note" className="rounded-sm" data-testid="tab-racking-note">
            <Stack size={14} weight="bold" className="mr-2" /> Racking Note
          </TabsTrigger>
          <TabsTrigger value="short-received-note" className="rounded-sm" data-testid="tab-short-received-note">
            <Warning size={14} weight="bold" className="mr-2" /> Short Received Note
          </TabsTrigger>
          <TabsTrigger value="extra-received-note" className="rounded-sm" data-testid="tab-extra-received-note">
            <Plus size={14} weight="bold" className="mr-2" /> Extra Received Note
          </TabsTrigger>
        </TabsList>

        <TabsContent value="receipt-note">
          <ReceiptNoteTab />
        </TabsContent>
        <TabsContent value="racking-note">
          <RackingNoteTab />
        </TabsContent>
        <TabsContent value="short-received-note">
          <ChildNoteListTab kind="srn" />
        </TabsContent>
        <TabsContent value="extra-received-note">
          <ChildNoteListTab kind="ern" />
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/receipt-notes", { params: { page, page_size: PAGE_SIZE } });
      setRows(res.data);
      const t = parseInt(res.headers["x-total-count"], 10);
      setTotal(isNaN(t) ? res.data.length : t);
    } finally { setLoading(false); }
  }, [page]);

  useEffect(() => { load(); }, [load, reloadKey]);

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
    { key: "rn_date", label: "Receipt Note Date", value: (r) => fmtDate(r.rn_date) },
    { key: "rn_no", label: "Receipt Note No", value: (r) => r.rn_no || "" },
    { key: "invoice_date", label: "Invoice Date", value: (r) => fmtDate(r.invoice_date) },
    { key: "invoice_no", label: "Invoice No", value: (r) => r.invoice_no || "" },
    { key: "goods_received_date", label: "Goods Received Date", value: (r) => fmtDate(r.goods_received_date) },
    { key: "items_count", label: "Items", value: (r) => (r.items || []).length },
    { key: "total_qty", label: "Total Quantity", value: totalQtyOf },
    { key: "assigned_to", label: "Assigned To", value: (r) => r.assigned_to_name || r.assigned_to_email || "" },
    { key: "status", label: "Status", value: (r) => statusMeta(r.status).label },
  ], []);

  const { filteredRows, getColumnHeaderProps } = useTableSortFilter(rows, columns);

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

      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto overflow-visible">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-14">SL NO</th>
              <ColumnHeader {...getColumnHeaderProps("rn_date")} label="RECEIPT NOTE DATE" testid="rn-col-date" />
              <ColumnHeader {...getColumnHeaderProps("rn_no")} label="RECEIPT NOTE NO" testid="rn-col-no" />
              <ColumnHeader {...getColumnHeaderProps("invoice_date")} label="INVOICE DATE" testid="rn-col-inv-date" />
              <ColumnHeader {...getColumnHeaderProps("invoice_no")} label="INVOICE NO" testid="rn-col-inv-no" />
              <ColumnHeader {...getColumnHeaderProps("goods_received_date")} label="GOODS RCVD DATE" testid="rn-col-grd" />
              <ColumnHeader {...getColumnHeaderProps("items_count")} align="right" label="ITEMS" testid="rn-col-items" />
              <ColumnHeader {...getColumnHeaderProps("total_qty")} align="right" label="TOTAL QUANTITY" testid="rn-col-qty" />
              <ColumnHeader {...getColumnHeaderProps("assigned_to")} label="ASSIGNED TO" testid="rn-col-assigned" />
              <ColumnHeader {...getColumnHeaderProps("status")} label="STATUS" testid="rn-col-status" />
              <th className="text-right">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r, idx) => {
              const totalQty = totalQtyOf(r);
              const isDraft = r.status === "DRAFT";
              const isFully = r.status === "FULLY_RACKED";
              const isPartial = r.status === "PARTIALLY_RACKED";
              const hasRacking = isFully || isPartial; // any RKN exists -> edit/delete blocked unless DRAFT
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
                  <td className="font-mono text-slate-700">{fmtDate(r.invoice_date)}</td>
                  <td className="font-mono text-slate-700">{r.invoice_no || "—"}</td>
                  <td className="font-mono text-slate-700">{fmtDate(r.goods_received_date)}</td>
                  <td className="text-right font-mono text-slate-600">{(r.items || []).length}</td>
                  <td className="text-right font-mono font-bold text-slate-900">{totalQty}</td>
                  <td>
                    <AssigneeBadge name={r.assigned_to_name} email={r.assigned_to_email} testid={`rn-assignee-${r.rn_no}`} />
                  </td>
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${sm.cls}`}
                      data-testid={`rn-status-${r.rn_no}`}>
                      {sm.label}
                    </span>
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
              <tr><td colSpan={11} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? "No receipt notes. Click 'Create New Receipt Note' to begin." : "No rows match the current filters.")}</td></tr>
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
function ReceiptNoteDetailDialog({ rn, onClose }) {
  const handlePrint = () => printReceiptNote(rn);
  return (
    <Dialog open={!!rn} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl rounded-sm" data-testid="rn-detail-dialog">
        {rn && (
          <>
            <DialogHeader>
              <div className="flex items-center justify-between">
                <DialogTitle className="text-2xl font-black font-mono">{rn.rn_no}</DialogTitle>
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
                    <th>MAKE</th>
                    <th className="text-right">INVOICE QTY</th>
                    <th className="text-right">RECEIVED QTY</th>
                    <th className="text-right">QTY DIFF</th>
                  </tr>
                </thead>
                <tbody>
                  {(rn.items || []).map((it, idx) => {
                    const diff = qtyDiff(it);
                    const diffCls = diff < 0 ? "text-red-700" : diff > 0 ? "text-amber-700" : "text-slate-500";
                    return (
                      <tr key={idx}>
                        <td className="font-mono text-slate-500">{idx + 1}</td>
                        <td className="font-mono font-semibold">{it.part_no}</td>
                        <td>{it.make}</td>
                        <td className="text-right font-mono">{toNum(it.invoice_qty) ?? "—"}</td>
                        <td className="text-right font-mono">{toNum(it.received_qty) ?? "—"}</td>
                        <td className={`text-right font-mono font-bold ${diffCls}`}>
                          {toNum(it.received_qty) == null ? "—" : (diff > 0 ? `+${diff}` : diff)}
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

/* --------------------------------------------------------------
   Print view — opens a new window with a print-friendly layout
   -------------------------------------------------------------- */
function printReceiptNote(rn) {
  if (!rn) return;
  const sm = statusMeta(rn.status);
  const items = (rn.items || []).map((it, idx) => {
    const inv = toNum(it.invoice_qty) ?? "—";
    const rec = toNum(it.received_qty);
    const diff = qtyDiff(it);
    const diffStr = rec == null ? "—" : (diff > 0 ? `+${diff}` : diff);
    return `<tr>
      <td>${idx + 1}</td>
      <td><strong>${escapeHtml(it.part_no || "")}</strong></td>
      <td>${escapeHtml(it.make || "")}</td>
      <td style="text-align:right">${inv}</td>
      <td style="text-align:right">${rec ?? "—"}</td>
      <td style="text-align:right">${diffStr}</td>
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
      <div class="muted">Receipt Note</div>
      <h1>${escapeHtml(rn.rn_no)}</h1>
    </div>
    <span class="pill">${escapeHtml(sm.label)}</span>
  </div>
  <div class="grid">
    <div><div class="field-label">Receipt Note Date</div><div class="field-value">${escapeHtml(fmtDate(rn.rn_date))}</div></div>
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
      <th>Sl No</th><th>Part No</th><th>Make</th>
      <th style="text-align:right">Invoice Qty</th>
      <th style="text-align:right">Received Qty</th>
      <th style="text-align:right">Qty Diff</th>
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
  makes: [],
  partLooked: false,
});

function ReceiptNoteCreate({ editing, onCancel, onSaved }) {
  const isEdit = !!editing;
  const isDraftEdit = isEdit && editing.status === "DRAFT";
  const isFinalEdit = isEdit && !isDraftEdit;

  const [rnNo, setRnNo] = useState("");
  const [rnDate, setRnDate] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [goodsReceivedDate, setGoodsReceivedDate] = useState("");
  const [items, setItems] = useState([emptyItem()]);
  const [addCount, setAddCount] = useState(""); // bulk-add quantity
  const [savingDraft, setSavingDraft] = useState(false);
  const [savingFinal, setSavingFinal] = useState(false);
  const [assignedToUserId, setAssignedToUserId] = useState("");

  // Inline "Create New Master" dialog
  const [masterDialog, setMasterDialog] = useState(null); // { rowIdx, part_no }
  const fileInputRef = useRef(null);
  const draftBtnRef = useRef(null);
  const finalBtnRef = useRef(null);

  // On mount: either populate from `editing` (edit mode) or fetch next preview (create mode)
  useEffect(() => {
    if (isEdit) {
      setRnNo(editing.rn_no || "");
      setRnDate(editing.rn_date || "");
      setInvoiceNo(editing.invoice_no || "");
      setInvoiceDate(editing.invoice_date || "");
      setGoodsReceivedDate(editing.goods_received_date || "");
      setAssignedToUserId(editing.assigned_to_user_id || "");
      const initial = (editing.items || []).map((it) => ({
        part_no: it.part_no || "",
        make: it.make || "",
        // Backwards-compat: pre-Phase-1 rows had only `quantity`. Treat that as both invoice and received.
        invoice_qty: (it.invoice_qty ?? it.quantity ?? ""),
        received_qty: (it.received_qty ?? (isFinalEdit ? (it.quantity ?? "") : "")),
        makes: it.make ? [it.make] : [],
        partLooked: !!it.part_no,
      }));
      setItems(initial.length ? initial : [emptyItem()]);
      // Refresh real makes list from stock_master so the dropdown shows all options
      initial.forEach((row, idx) => {
        if (!row.part_no) return;
        api.get("/stock-master/lookup/makes", { params: { part_no: row.part_no } })
          .then(({ data }) => {
            const list = data.makes || [];
            const merged = row.make && !list.includes(row.make) ? [...list, row.make] : list;
            setItems((prev) => prev.map((r, i) => i === idx ? { ...r, makes: merged } : r));
          }).catch(() => { /* ignore */ });
      });
    } else {
      api.get("/receipt-notes/next-no").then((r) => {
        setRnNo(r.data.next_rn_no);
        setRnDate(r.data.rn_date);
      }).catch(() => toast.error("Could not preview receipt-note number"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, isEdit]);

  const addItem = () => {
    const n = Math.max(1, Math.min(500, parseInt(addCount, 10) || 1));
    setItems((p) => [...p, ...Array.from({ length: n }, emptyItem)]);
    setAddCount("");
  };
  const removeItem = (i) => setItems((p) => (p.length === 1 ? p : p.filter((_, idx) => idx !== i)));
  const updateItem = (i, patch) => setItems((p) => p.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  // Lookup makes from stock_master when Part No is entered
  const lookupMakes = async (i, partNo) => {
    const v = (partNo || "").trim();
    if (!v) {
      updateItem(i, { makes: [], make: "", partLooked: false });
      return;
    }
    try {
      const { data } = await api.get("/stock-master/lookup/makes", { params: { part_no: v } });
      const list = data.makes || [];
      updateItem(i, { makes: list, partLooked: true, make: list.length === 1 ? list[0] : "" });
    } catch {
      updateItem(i, { makes: [], partLooked: true, make: "" });
    }
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
      updateItem(i, { make: value });
    }
  };

  const handleMasterCreated = (newItem) => {
    if (masterDialog == null) return;
    const i = masterDialog.rowIdx;
    setItems((prev) => prev.map((r, idx) => idx === i
      ? { ...r, makes: [...new Set([...(r.makes || []), newItem.make])], make: newItem.make, partLooked: true }
      : r));
    setMasterDialog(null);
    toast.success(`Master created: ${newItem.part_no} / ${newItem.make}`);
  };

  /* ---- Excel import: client-side via xlsx ---- */
  const handleExcelImport = async (file) => {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
      if (!rows.length) { toast.error("Excel file has no rows"); return; }
      // Tolerate a variety of column header spellings.
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
        if (!part_no && (invQ === "" || invQ == null)) continue;
        if (!part_no) { toast.error("Skipped row — Part No missing"); continue; }
        const inv = parseFloat(invQ);
        if (isNaN(inv) || inv <= 0) { toast.error(`Row for ${part_no} skipped — Invoice Qty must be > 0`); continue; }
        const rec = recQ === "" || recQ == null ? "" : (isNaN(parseFloat(recQ)) ? "" : parseFloat(recQ));
        newRows.push({
          part_no, make,
          invoice_qty: inv,
          received_qty: rec,
          makes: make ? [make] : [],
          partLooked: false, // will trigger lookup below
        });
      }
      if (!newRows.length) { toast.error("No valid rows found in file"); return; }
      // Replace the empty first row if user hasn't typed anything yet, else append
      setItems((prev) => {
        const onlyEmpty = prev.length === 1 && !prev[0].part_no && !prev[0].invoice_qty;
        return onlyEmpty ? newRows : [...prev, ...newRows];
      });
      // Run lookup for each part_no to populate make dropdowns
      newRows.forEach((row, offset) => {
        // Resolve at the right index lazily in the next tick to avoid stale-state issues
        setTimeout(() => {
          api.get("/stock-master/lookup/makes", { params: { part_no: row.part_no } })
            .then(({ data }) => {
              const list = data.makes || [];
              setItems((prev) => prev.map((r) => {
                if (r.part_no !== row.part_no) return r;
                const merged = r.make && !list.includes(r.make) ? [...list, r.make] : list;
                return { ...r, makes: merged, partLooked: true, make: r.make || (list.length === 1 ? list[0] : "") };
              }));
            }).catch(() => {});
        }, 0);
      });
      toast.success(`Imported ${newRows.length} row${newRows.length > 1 ? "s" : ""} from Excel`);
    } catch (err) {
      toast.error("Could not read Excel file");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  /* ---- Validation: shared by save handlers ---- */
  const validateBaseRows = () => {
    if (items.length === 0) { toast.error("Add at least one item"); return false; }
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      if (!it.part_no.trim()) { toast.error(`Row ${idx + 1}: Part No is required`); return false; }
      if (!it.make.trim()) { toast.error(`Row ${idx + 1}: Make is required`); return false; }
      const inv = toNum(it.invoice_qty);
      if (inv == null || inv <= 0) { toast.error(`Row ${idx + 1}: Invoice Qty must be > 0`); return false; }
      const rec = toNum(it.received_qty);
      if (rec != null && rec < 0) { toast.error(`Row ${idx + 1}: Received Qty cannot be negative`); return false; }
    }
    return true;
  };

  const validateDates = (_requireGRD) => {
    if (invoiceDate && invoiceDate > todayISO()) { toast.error("Invoice Date cannot be in the future"); return false; }
    if (goodsReceivedDate && goodsReceivedDate > todayISO()) { toast.error("Goods Received Date cannot be in the future"); return false; }
    return true;
  };

  const allReceivedFilled = useMemo(
    () => items.length > 0 && items.every((it) => {
      const r = toNum(it.received_qty);
      return r != null && r > 0;
    }),
    [items]
  );

  const canFinalize = useMemo(() => (
    items.length > 0
    && items.every((it) => it.part_no.trim() && it.make.trim() && (toNum(it.invoice_qty) || 0) > 0)
    && allReceivedFilled
    && !!invoiceDate
    && !!goodsReceivedDate
    && (!invoiceDate || invoiceDate <= todayISO())
    && (!goodsReceivedDate || goodsReceivedDate <= todayISO())
  ), [items, allReceivedFilled, invoiceDate, goodsReceivedDate]);

  const buildPayload = () => ({
    invoice_no: invoiceNo.trim(),
    invoice_date: invoiceDate || "",
    goods_received_date: goodsReceivedDate || "",
    assigned_to_user_id: assignedToUserId || null,
    items: items.map((it) => ({
      part_no: it.part_no.trim(),
      make: it.make.trim(),
      invoice_qty: toNum(it.invoice_qty),
      received_qty: toNum(it.received_qty),
    })),
  });

  /* ---- Save Draft ---- */
  const saveDraft = async () => {
    if (!validateBaseRows()) return;
    if (!validateDates(false)) return;
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

  /* ---- Save Final: PUT (or POST), then POST /finalize ---- */
  const saveFinal = async () => {
    if (!validateBaseRows()) return;
    if (!validateDates(true)) return;
    if (!allReceivedFilled) { toast.error("Every row must have a Received Qty greater than 0"); return; }
    setSavingFinal(true);
    try {
      const payload = buildPayload();
      // Step 1: persist the row data (DRAFT update or new DRAFT). For FINAL edits with no children,
      // server allows updates; finalize stays a no-op since status is already FINAL.
      let rnId;
      let rnNoDisplay;
      if (isEdit) {
        const { data } = await api.put(`/receipt-notes/${editing.id}`, payload);
        rnId = data.id; rnNoDisplay = data.rn_no;
      } else {
        const { data } = await api.post("/receipt-notes", payload);
        rnId = data.id; rnNoDisplay = data.rn_no;
      }
      // Step 2: only call finalize if the doc is currently DRAFT.
      // (For FINAL edits, the server returns FINAL already and finalize would 409.)
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

  // Last-row keyboard handler: Tab from the last visible field jumps to the appropriate save button.
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
          {/* Hide Draft when editing a FINAL+ note (you can't go back to draft) */}
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
            title={!canFinalize && !isFinalEdit ? "Fill all rows including Received Qty, plus both dates, to enable Final Save" : (isFinalEdit ? "Update finalized receipt" : "Final Save — promotes to Racking")}
          >
            <CheckCircle size={14} weight="bold" className="mr-2" />
            {savingFinal ? "Saving…" : (isFinalEdit ? "Update Receipt Note" : "Save Final")}
          </Button>
        </div>
      </div>

      {/* HEADER */}
      <div className="bg-white border border-slate-200 rounded-sm p-6 grid grid-cols-2 lg:grid-cols-4 gap-4">
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
          <Label className="label-sm">Invoice Date</Label>
          <Input
            type="date"
            value={invoiceDate}
            max={todayISO()}
            onChange={(e) => setInvoiceDate(e.target.value)}
            className="mt-2 rounded-sm font-mono"
            data-testid="rn-invoice-date-input"
          />
          <div className="text-[11px] text-slate-500 mt-1">Optional · no future date</div>
        </div>
        <div>
          <Label className="label-sm">Invoice No</Label>
          <Input
            value={invoiceNo}
            onChange={(e) => setInvoiceNo(e.target.value)}
            placeholder="e.g. INV-1024 (optional)"
            className="mt-2 rounded-sm font-mono"
            data-testid="rn-invoice-no-input"
          />
        </div>
        <div>
          <Label className="label-sm">Goods Received Date</Label>
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
        <div className="col-span-2 lg:col-span-3">
          <AssigneeSelect
            value={assignedToUserId}
            onChange={setAssignedToUserId}
            module="stock_in"
            testid="rn-assignee"
          />
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
              title="Columns: Part No, Invoice Qty, Make (optional), Received Qty (optional)"
            >
              <UploadSimple size={14} weight="bold" className="mr-1" /> Import Excel
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

        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-14">SL NO</th>
              <th>PART NO</th>
              <th className="w-32 text-right">INVOICE QTY</th>
              <th className="w-32 text-right">RECEIVED QTY</th>
              <th className="w-24 text-right">QTY DIFF</th>
              <th>MAKE</th>
              <th className="w-14"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => {
              const diff = qtyDiff(it);
              const recFilled = toNum(it.received_qty) != null;
              const diffNonZero = recFilled && diff !== 0;
              const recCls = `rounded-sm font-mono h-8 text-right ${diffNonZero ? "border-red-500 ring-1 ring-red-200" : ""}`;
              const diffCls = !recFilled
                ? "text-slate-400"
                : (diff < 0 ? "text-red-700 font-bold" : (diff > 0 ? "text-amber-700 font-bold" : "text-slate-500"));
              const isLastRow = idx === items.length - 1;
              return (
                <tr key={idx} data-testid={`rn-item-row-${idx}`}>
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td>
                    <Input
                      value={it.part_no}
                      onChange={(e) => updateItem(idx, { part_no: e.target.value, partLooked: false, makes: [], make: "" })}
                      onBlur={(e) => lookupMakes(idx, e.target.value)}
                      placeholder="Enter part no"
                      className="rounded-sm font-mono h-8"
                      data-testid={`rn-part-no-${idx}`}
                    />
                  </td>
                  <td className="w-32">
                    <Input
                      type="number"
                      min="0.001"
                      step="any"
                      value={it.invoice_qty}
                      onChange={(e) => updateItem(idx, { invoice_qty: e.target.value })}
                      placeholder="0"
                      className="rounded-sm font-mono h-8 text-right"
                      data-testid={`rn-invoice-qty-${idx}`}
                    />
                  </td>
                  <td className="w-32">
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      value={it.received_qty}
                      onChange={(e) => updateItem(idx, { received_qty: e.target.value })}
                      placeholder="optional for draft"
                      className={recCls}
                      data-testid={`rn-received-qty-${idx}`}
                      title={diffNonZero ? (diff < 0 ? `Short by ${Math.abs(diff)} — SRN will be auto-created on Final Save` : `Extra of ${diff} — ERN will be auto-created on Final Save`) : undefined}
                    />
                  </td>
                  <td className={`w-24 text-right font-mono ${diffCls}`} data-testid={`rn-qty-diff-${idx}`}>
                    {!recFilled ? "—" : (diff > 0 ? `+${diff}` : diff)}
                  </td>
                  <td className="w-64">
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
                    <button
                      onClick={() => removeItem(idx)}
                      disabled={items.length === 1}
                      className={`p-1.5 rounded-sm ${items.length === 1 ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                      data-testid={`rn-remove-row-${idx}`}
                    >
                      <Trash size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Hint banner: visible whenever any row has a non-zero diff. */}
        {items.some((it) => qtyDiff(it) !== 0 && toNum(it.received_qty) != null) && (
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
   PHASE 1 STUB · Short / Extra Received Note tabs
   List-only views. Phase 2/3 will add the finalize forms.
   ============================================================== */
function ChildNoteListTab({ kind }) {
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

  useEffect(() => { load(); }, [load]);

  return (
    <div className="mt-4" data-testid={`${kind}-list-view`}>
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div>
          <div className="label-sm">{labelTitle}</div>
          <div className="text-xs text-slate-500 mt-0.5">
            {isSrn
              ? "Auto-created when a Receipt Note is finalized with a shortfall. Finalize each SRN once the missing qty arrives."
              : "Auto-created when a Receipt Note is finalized with an overage. Finalize each ERN by entering accepted/rejected qty."}
            {" "}<em>(finalize action coming in next phase — list view only for now)</em>
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
              <th>{noun} DATE</th>
              <th>{noun} NO</th>
              <th>PARENT RN</th>
              <th>INVOICE NO</th>
              <th className="text-right">ITEMS</th>
              <th>STATUS</th>
              <th>CREATED BY</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={r.id} data-testid={`${kind}-row-${r[idField]}`}>
                <td className="font-mono text-slate-500">{idx + 1}</td>
                <td className="font-mono text-slate-700">{fmtDate(r[dateField])}</td>
                <td className="font-mono font-semibold text-blue-700">{r[idField]}</td>
                <td className="font-mono text-slate-700">{r.parent_rn_no || "—"}</td>
                <td className="font-mono text-slate-700">{r.invoice_no || "—"}</td>
                <td className="text-right font-mono">{(r.items || []).length}</td>
                <td>
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${statusMeta(r.status).cls}`}>
                    {statusMeta(r.status).label}
                  </span>
                </td>
                <td className="text-slate-600">{r.created_by || "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={8} className="text-center py-12 text-slate-500">{loading ? "Loading…" : `No ${noun}s yet. They appear automatically when a Receipt Note is finalized with ${isSrn ? "a shortfall" : "an overage"}.`}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}