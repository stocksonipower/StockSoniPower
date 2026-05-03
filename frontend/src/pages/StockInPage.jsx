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
  Plus, Trash, ArrowLeft, FloppyDisk, FileText, CaretLeft, CaretRight, Pencil, PencilSimple, Stack,
  DownloadSimple, ArrowsClockwise, UploadSimple, Printer, CheckCircle, Warning, Eye, X,
  Receipt, Package as PackageIcon,
} from "@phosphor-icons/react";
import RackingNoteTab from "./RackingNoteTab";
import AssigneeSelect, { AssigneeBadge } from "../components/AssigneeSelect";
import PartNoLink from "../components/PartNoLink";
import DocumentDetailDialog from "../components/DocumentDetailDialog";
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

/** Format an ISO datetime string -> "DD-MM-YYYY HH:MM:SS". Returns "—" for falsy. */
function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

function sumSrnQty(srn)           { return (srn.items||[]).reduce((s,it) => s + (+it.short_qty||0), 0); }
function sumSrnReceived(srn)      { return (srn.items||[]).reduce((s,it) => s + (it.children||[]).reduce((c,ch) => c + (+ch.received_qty||0), 0), 0); }
function sumSrnNotReceivable(srn) { return (srn.items||[]).reduce((s,it) => s + (it.children||[]).reduce((c,ch) => c + (+ch.not_receivable_qty||0), 0), 0); }
function sumErnQty(ern)           { return (ern.items||[]).reduce((s,it) => s + (+it.extra_qty||0), 0); }
function sumErnAccepted(ern)      { return (ern.items||[]).reduce((s,it) => { const ch=it.children||[]; return s+(ch.length?ch.reduce((c,r)=>c+(+r.accepted_qty||0),0):(+it.accepted_qty||0)); }, 0); }
function sumErnRejected(ern)      { return (ern.items||[]).reduce((s,it) => { const ch=it.children||[]; return s+(ch.length?ch.reduce((c,r)=>c+(+r.rejected_qty||0),0):(+it.rejected_qty||0)); }, 0); }
function sumRknQty(rkn)           { return (rkn.items||[]).reduce((s,it) => s + (+it.quantity||0), 0); }

/** Status pill metadata used in list view AND detail dialog. */
export function stockInTypeMeta(type) {
  const t = (type || "INVOICE").toUpperCase();
  if (t === "GENERAL") return { label: "General", cls: "bg-indigo-50 text-indigo-800 border border-indigo-200" };
  return { label: "Invoice", cls: "bg-blue-50 text-blue-800 border border-blue-200" };
}
export function stockInTypeLabel(type) { return stockInTypeMeta(type).label; }


// Status metadata. The backend emits exactly 12 active values across all 4
// note types — anything else falls through to the default chip.
//   Receipt Note:  DRAFT, RACKING_NOTE_DRAFT, PARTIALLY_RACKED, FULLY_RACKED
//   SRN:           PENDING, PARTIALLY_RECEIVED, COMPLETE
//   ERN:           PENDING, PARTIALLY_ACCEPTED, COMPLETE
//   Racking Note:  DRAFT, RECORDED
function statusMeta(status) {
  switch (status) {
    case "DRAFT":
      return { label: "Draft", cls: "bg-slate-100 text-slate-700" };
    case "RACKING_NOTE_DRAFT":
      return { label: "Racking Note Draft", cls: "bg-orange-50 text-orange-800 border border-orange-200" };
    case "PARTIALLY_RACKED":
      return { label: "Partially Racked", cls: "bg-blue-50 text-blue-800" };
    case "FULLY_RACKED":
      return { label: "Fully Racked", cls: "bg-green-100 text-green-800" };
    case "PENDING":
      return { label: "Pending", cls: "bg-amber-50 text-amber-700" };
    case "PARTIALLY_RECEIVED":
      return { label: "Partially Received", cls: "bg-blue-50 text-blue-800" };
    case "PARTIALLY_ACCEPTED":
      return { label: "Partially Accepted", cls: "bg-blue-50 text-blue-800" };
    case "COMPLETE":
      return { label: "Complete", cls: "bg-green-100 text-green-800" };
    case "RECORDED":
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
const PAGE_SIZE = 100;

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
    { key: "invoice_date", label: "INVOICE DATE", value: (r) => fmtDate(r.invoice_date) },
    { key: "invoice_no", label: "INVOICE NO", value: (r) => r.invoice_no || "" },
    { key: "goods_received_date", label: "MATERIAL RECEIVED DATE", value: (r) => fmtDate(r.goods_received_date) },
    { key: "status", label: "STATUS", value: (r) => statusMeta(r.status).label },
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
        <div />
        <div className="flex items-center gap-2">
<Input
            ref={searchInputRef}     
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search"
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
              <th className="text-left">ACTIONS</th>
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
<td className="font-mono text-slate-700">{fmtDate(r.invoice_date)}</td>
<td className="font-mono text-slate-700">{r.invoice_no || "—"}</td>
<td className="font-mono text-slate-700">{fmtDate(r.goods_received_date)}</td>
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${sm.cls}`}
                      data-testid={`rn-status-${r.rn_no}`}>
                      {sm.label}
                    </span>
                  </td>
                  <td className="text-left whitespace-nowrap">
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
              <tr><td colSpan={9} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? "No receipt notes. Click 'Create New Receipt Note' to begin." : "No rows match the current filters.")}</td></tr>
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

/* --------------------------------------------------------------
   Detail dialog (read-only) — redesigned with live SRN/ERN/RKN data
   -------------------------------------------------------------- */
export function ReceiptNoteDetailDialog({ rn, onClose }) {
  const [srns, setSrns] = useState([]);
  const [erns, setErns] = useState([]);
  const [rkns, setRkns] = useState([]);
  const [masterData, setMasterData] = useState({});
  const [loading, setLoading] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [openSrn, setOpenSrn] = useState(null);
  const [openErn, setOpenErn] = useState(null);
  const [openRkn, setOpenRkn] = useState(null);

  useEffect(() => {
    if (!rn) { setSrns([]); setErns([]); setRkns([]); setMasterData({}); return; }
    setLoading(true);
    Promise.all([
      api.get("/short-received-notes", { params: { parent_rn_id: rn.id, page_size: 100 } }),
      api.get("/extra-received-notes", { params: { parent_rn_id: rn.id, page_size: 100 } }),
      api.get("/racking-notes",        { params: { receipt_note_id: rn.id, page_size: 100 } }),
    ]).then(([s, e, r]) => {
      setSrns(s.data || []);
      setErns(e.data || []);
      setRkns([...(r.data || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));
    }).catch(() => {}).finally(() => setLoading(false));

    setMasterData({});
    const seen = new Set();
    (rn.items || []).forEach(it => {
      const key = `${it.part_no}||${it.make}`;
      if (seen.has(key)) return;
      seen.add(key);
      api.get("/stock-master/lookup/item", { params: { part_no: it.part_no, make: it.make } })
        .then(({ data }) => setMasterData(prev => ({ ...prev, [key]: data })))
        .catch(() => {});
    });
  }, [rn?.id, reloadTick]);

  const srnTree = useMemo(() => {
    const parents = srns.filter(s => !s.parent_srn_id);
    return parents.map(p => ({ parent: p, children: srns.filter(c => c.parent_srn_id === p.id) }));
  }, [srns]);

  const ernTree = useMemo(() => {
    const parents = erns.filter(e => !e.parent_ern_id);
    return parents.map(p => ({ parent: p, children: erns.filter(c => c.parent_ern_id === p.id) }));
  }, [erns]);

  const handlePrint = () => printReceiptNote(rn, srns, erns, rkns, masterData, srnTree, ernTree);

  return (
    <Dialog open={!!rn} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl max-h-[92vh] overflow-y-auto rounded-sm" data-testid="rn-detail-dialog">
        {rn && (
          <>
            {/* ── HEADING ── */}
            <div className="text-center text-xl font-black tracking-widest uppercase pt-1 pb-2 border-b border-slate-200">
              RECEIPT NOTE
            </div>

            {/* ── HEADER: LEFT / RIGHT ── */}
            <div className="grid grid-cols-2 gap-6 text-sm pt-3 pb-4 border-b border-slate-200">
              {/* Left */}
              <div className="space-y-2">
                {(() => { const sit = stockInTypeMeta(rn.stock_in_type); return (
                  <div>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-sm ${sit.cls}`}
                      data-testid="rn-detail-stock-in-type">
                      {sit.label} Stock In
                    </span>
                  </div>
                ); })()}
                <Detail k="RECEIPT NOTE DATE" v={fmtDate(rn.rn_date)} />
                <Detail k="RECEIPT NOTE NO" v={rn.rn_no} />
                <Detail k="INVOICE DATE" v={fmtDate(rn.invoice_date)} />
                <Detail k="INVOICE NO" v={rn.invoice_no || "—"} />
                <Detail k="MATERIAL RECEIVED DATE" v={fmtDate(rn.goods_received_date)} />
                <Detail k="STATUS" v={
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${statusMeta(rn.status).cls}`}>
                    {statusMeta(rn.status).label}
                  </span>
                } />
              </div>
              {/* Right */}
              <div className="space-y-2">
                <Detail k="CREATED BY" v={rn.created_by || "—"} />
                <Detail k="CREATED AT" v={fmtDateTime(rn.created_at)} />
                <div>
                  <div className="label-sm">ASSIGNED TO</div>
                  <div className="mt-1"><AssigneeBadge name={rn.assigned_to_name} email={rn.assigned_to_email} /></div>
                </div>
                <div>
                  <div className="label-sm">NARRATION</div>
                  <div className="font-mono mt-1 text-slate-900 whitespace-pre-wrap">{rn.narration || "—"}</div>
                </div>
              </div>
            </div>

            {/* ── ITEMS TABLE ── */}
            <div className="mt-2">
              <div className="label-sm mb-2">Items ({(rn.items || []).length}){loading && <span className="ml-2 text-slate-400 font-normal normal-case">Loading live data…</span>}</div>
              <div className="overflow-x-auto">
                <table className="data-table w-full">
                  <thead>
                    <tr>
                      <th className="w-12">SL NO</th>
                      <th>MODEL</th>
                      <th>PART NO</th>
                      <th>DESCRIPTION 1</th>
                      <th>MAKE</th>
                      <th className="text-right">INVOICE QTY</th>
                      <th className="text-right">RECEIVED QTY</th>
                      <th className="text-right">DIFFERENCE QTY</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(rn.items || []).map((it, idx) => {
                      const key = `${it.part_no}||${it.make}`;
                      const sm = masterData[key];
                      const diff = qtyDiff(it);
                      const diffCls = diff < 0 ? "text-red-700" : diff > 0 ? "text-amber-700" : "text-slate-500";
                      return (
                        <tr key={idx}>
                          <td className="font-mono text-slate-500">{idx + 1}</td>
                          <td className="font-mono text-slate-700">{sm ? (sm.model || "—") : <span className="text-slate-300">—</span>}</td>
                          <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                          <td className="text-slate-700">{sm ? (sm.description_1 || it.description_1 || "—") : (it.description_1 || "—")}</td>
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
            </div>

            {/* ── SRN / ERN / RKN 3-COLUMN SECTION ── */}
            <div className="mt-6 border-t border-slate-200 pt-4">
              <div className="grid grid-cols-3 gap-4">

                {/* ── Column 1: SRN ── */}
                <div>
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-700 mb-2 pb-1 border-b border-slate-200">
                    SRN Details
                  </div>
                  {srnTree.length === 0 ? (
                    <div className="text-xs text-slate-400 italic">No SRN Created</div>
                  ) : srnTree.map(({ parent, children }) => {
                    const srnQty = sumSrnQty(parent);
                    const rcvd   = sumSrnReceived(parent);
                    const notRcv = sumSrnNotReceivable(parent);
                    const pend   = Math.max(0, srnQty - rcvd - notRcv);
                    const sm     = statusMeta(parent.status);
                    return (
                      <div key={parent.id} className="mb-3">
                        <div className="rounded border border-slate-200 p-2 text-xs bg-slate-50">
                          <button onClick={() => setOpenSrn(parent)}
                            className="font-mono font-bold text-blue-700 hover:underline text-[11px]">
                            {parent.srn_no}
                          </button>
                          <div className="mt-1 space-y-0.5 text-slate-600">
                            <div><span className="font-semibold">Date:</span> {fmtDate(parent.srn_date)}</div>
                            <div><span className="font-semibold">SRN Qty:</span> {srnQty || "—"}</div>
                            <div><span className="font-semibold">Received Qty:</span> {rcvd || "—"}</div>
                            <div><span className="font-semibold">Not Receivable:</span> {notRcv || "—"}</div>
                            <div><span className="font-semibold">Pending Qty:</span> {pend || "—"}</div>
                            <div><span className="font-semibold">Status:</span>{" "}
                              <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-sm ${sm.cls}`}>{sm.label}</span>
                            </div>
                          </div>
                        </div>
                        {children.map(child => {
                          const cQty   = sumSrnQty(child);
                          const cRcvd  = sumSrnReceived(child);
                          const cNotR  = sumSrnNotReceivable(child);
                          const cPend  = Math.max(0, cQty - cRcvd - cNotR);
                          const cSm    = statusMeta(child.status);
                          return (
                            <div key={child.id} className="ml-3 mt-1 border-l-2 border-slate-300 pl-2 rounded-r border border-l-0 border-slate-200 p-1.5 text-xs bg-white">
                              <button onClick={() => setOpenSrn(child)}
                                className="font-mono font-bold text-blue-600 hover:underline text-[11px]">
                                {child.srn_no}
                              </button>
                              <div className="mt-0.5 space-y-0.5 text-slate-600">
                                <div><span className="font-semibold">Date:</span> {fmtDate(child.srn_date)}</div>
                                <div><span className="font-semibold">SRN Qty:</span> {cQty || "—"}</div>
                                <div><span className="font-semibold">Received:</span> {cRcvd || "—"}</div>
                                <div><span className="font-semibold">Not Rcv:</span> {cNotR || "—"}</div>
                                <div><span className="font-semibold">Pending:</span> {cPend || "—"}</div>
                                <div><span className="font-semibold">Status:</span>{" "}
                                  <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-sm ${cSm.cls}`}>{cSm.label}</span>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>

                {/* ── Column 2: ERN ── */}
                <div>
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-700 mb-2 pb-1 border-b border-slate-200">
                    ERN Details
                  </div>
                  {ernTree.length === 0 ? (
                    <div className="text-xs text-slate-400 italic">No ERN Created</div>
                  ) : ernTree.map(({ parent, children }) => {
                    const ernQty = sumErnQty(parent);
                    const acc    = sumErnAccepted(parent);
                    const rej    = sumErnRejected(parent);
                    const pend   = Math.max(0, ernQty - acc - rej);
                    const em     = statusMeta(parent.status);
                    return (
                      <div key={parent.id} className="mb-3">
                        <div className="rounded border border-slate-200 p-2 text-xs bg-slate-50">
                          <button onClick={() => setOpenErn(parent)}
                            className="font-mono font-bold text-blue-700 hover:underline text-[11px]">
                            {parent.ern_no}
                          </button>
                          <div className="mt-1 space-y-0.5 text-slate-600">
                            <div><span className="font-semibold">Date:</span> {fmtDate(parent.ern_date)}</div>
                            <div><span className="font-semibold">ERN Qty:</span> {ernQty || "—"}</div>
                            <div><span className="font-semibold">Accepted Qty:</span> {acc || "—"}</div>
                            <div><span className="font-semibold">Rejected Qty:</span> {rej || "—"}</div>
                            <div><span className="font-semibold">Pending Qty:</span> {pend || "—"}</div>
                            <div><span className="font-semibold">Status:</span>{" "}
                              <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-sm ${em.cls}`}>{em.label}</span>
                            </div>
                          </div>
                        </div>
                        {children.map(child => {
                          const cQty  = sumErnQty(child);
                          const cAcc  = sumErnAccepted(child);
                          const cRej  = sumErnRejected(child);
                          const cPend = Math.max(0, cQty - cAcc - cRej);
                          const cEm   = statusMeta(child.status);
                          return (
                            <div key={child.id} className="ml-3 mt-1 border-l-2 border-slate-300 pl-2 rounded-r border border-l-0 border-slate-200 p-1.5 text-xs bg-white">
                              <button onClick={() => setOpenErn(child)}
                                className="font-mono font-bold text-blue-600 hover:underline text-[11px]">
                                {child.ern_no}
                              </button>
                              <div className="mt-0.5 space-y-0.5 text-slate-600">
                                <div><span className="font-semibold">Date:</span> {fmtDate(child.ern_date)}</div>
                                <div><span className="font-semibold">ERN Qty:</span> {cQty || "—"}</div>
                                <div><span className="font-semibold">Accepted:</span> {cAcc || "—"}</div>
                                <div><span className="font-semibold">Rejected:</span> {cRej || "—"}</div>
                                <div><span className="font-semibold">Pending:</span> {cPend || "—"}</div>
                                <div><span className="font-semibold">Status:</span>{" "}
                                  <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-sm ${cEm.cls}`}>{cEm.label}</span>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>

                {/* ── Column 3: RKN (flat list) ── */}
                <div>
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-700 mb-2 pb-1 border-b border-slate-200">
                    RKN Details
                  </div>
                  {rkns.length === 0 ? (
                    <div className="text-xs text-slate-400 italic">No RKN Created</div>
                  ) : rkns.map(rkn => {
                    const rm = statusMeta(rkn.status);
                    return (
                      <div key={rkn.id} className="rounded border border-slate-200 p-2 text-xs bg-slate-50 mb-2">
                        <button onClick={() => setOpenRkn({ kind: "racking", id: rkn.id, no: rkn.rkn_no })}
                          className="font-mono font-bold text-blue-700 hover:underline text-[11px]">
                          {rkn.rkn_no}
                        </button>
                        <div className="mt-1 space-y-0.5 text-slate-600">
                          <div><span className="font-semibold">Date:</span> {fmtDate(rkn.rkn_date)}</div>
                          <div><span className="font-semibold">Source:</span> {rkn.source_type} · {rkn.source_no || "—"}</div>
                          <div><span className="font-semibold">RKN Qty:</span> {sumRknQty(rkn) || "—"}</div>
                          <div><span className="font-semibold">Status:</span>{" "}
                            <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-sm ${rm.cls}`}>{rm.label}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

              </div>
            </div>

            {/* ── ACTION BUTTONS ── */}
            <div className="flex items-center gap-2 pt-4 border-t border-slate-200 mt-2">
              <Button variant="outline" size="sm" className="rounded-sm" onClick={() => setReloadTick(t => t + 1)}>
                <ArrowsClockwise size={14} weight="bold" className="mr-1.5" /> Refresh
              </Button>
              <Button variant="outline" size="sm" className="rounded-sm" onClick={handlePrint} data-testid="rn-detail-print">
                <Printer size={14} weight="bold" className="mr-1.5" /> Print
              </Button>
            </div>

            {/* ── SUB-DIALOGS ── */}
            <ChildDetailDialog kind="srn" doc={openSrn} onClose={() => setOpenSrn(null)} onOpen={() => {}} />
            <ChildDetailDialog kind="ern" doc={openErn} onClose={() => setOpenErn(null)} onOpen={() => {}} />
            <DocumentDetailDialog kind={openRkn?.kind} id={openRkn?.id} no={openRkn?.no} onClose={() => setOpenRkn(null)} />
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
function printReceiptNote(rn, srns = [], erns = [], rkns = [], masterData = {}, srnTree = [], ernTree = []) {
  if (!rn) return;
  const sm = statusMeta(rn.status);
  const sit = stockInTypeMeta(rn.stock_in_type);

  const pField = (label, value) =>
    `<div><div class="field-label">${escapeHtml(label)}</div><div class="field-value">${escapeHtml(String(value ?? "—"))}</div></div>`;

  const items = (rn.items || []).map((it, idx) => {
    const key = `${it.part_no}||${it.make}`;
    const smItem = masterData[key];
    const model = smItem?.model || "—";
    const desc  = smItem?.description_1 || it.description_1 || "—";
    const inv   = toNum(it.invoice_qty) ?? "—";
    const rec   = toNum(it.received_qty);
    const diff  = qtyDiff(it);
    const diffStr = rec == null ? "—" : (diff > 0 ? `+${diff}` : String(diff));
    return `<tr>
      <td>${idx + 1}</td>
      <td>${escapeHtml(model)}</td>
      <td><strong>${escapeHtml(it.part_no || "")}</strong></td>
      <td>${escapeHtml(desc)}</td>
      <td>${escapeHtml(it.make || "")}</td>
      <td style="text-align:right">${inv}</td>
      <td style="text-align:right">${rec ?? "—"}</td>
      <td style="text-align:right">${diffStr}</td>
    </tr>`;
  }).join("");

  const pSrnCard = (srn, indented = false) => {
    const srnQty = sumSrnQty(srn);
    const rcvd   = sumSrnReceived(srn);
    const notRcv = sumSrnNotReceivable(srn);
    const pend   = Math.max(0, srnQty - rcvd - notRcv);
    const indent = indented ? "margin-left:16px;border-left:3px solid #cbd5e1;padding-left:8px;" : "";
    return `<div class="note-card" style="${indent}">
      <div class="note-no">${escapeHtml(srn.srn_no)}</div>
      <div>Date: ${escapeHtml(fmtDate(srn.srn_date))}</div>
      <div>SRN Qty: ${srnQty || "—"}</div>
      <div>Received Qty: ${rcvd || "—"}</div>
      <div>Not Receivable: ${notRcv || "—"}</div>
      <div>Pending Qty: ${pend || "—"}</div>
      <div>Status: ${escapeHtml(statusMeta(srn.status).label)}</div>
    </div>`;
  };

  const pErnCard = (ern, indented = false) => {
    const ernQty = sumErnQty(ern);
    const acc    = sumErnAccepted(ern);
    const rej    = sumErnRejected(ern);
    const pend   = Math.max(0, ernQty - acc - rej);
    const indent = indented ? "margin-left:16px;border-left:3px solid #cbd5e1;padding-left:8px;" : "";
    return `<div class="note-card" style="${indent}">
      <div class="note-no">${escapeHtml(ern.ern_no)}</div>
      <div>Date: ${escapeHtml(fmtDate(ern.ern_date))}</div>
      <div>ERN Qty: ${ernQty || "—"}</div>
      <div>Accepted Qty: ${acc || "—"}</div>
      <div>Rejected Qty: ${rej || "—"}</div>
      <div>Pending Qty: ${pend || "—"}</div>
      <div>Status: ${escapeHtml(statusMeta(ern.status).label)}</div>
    </div>`;
  };

  const srnHtml = srnTree.length === 0
    ? '<div class="empty">No SRN Created</div>'
    : srnTree.map(({ parent, children }) =>
        pSrnCard(parent) + children.map(c => pSrnCard(c, true)).join("")
      ).join("");

  const ernHtml = ernTree.length === 0
    ? '<div class="empty">No ERN Created</div>'
    : ernTree.map(({ parent, children }) =>
        pErnCard(parent) + children.map(c => pErnCard(c, true)).join("")
      ).join("");

  const rknHtml = rkns.length === 0
    ? '<div class="empty">No RKN Created</div>'
    : rkns.map(rkn => `<div class="note-card">
        <div class="note-no">${escapeHtml(rkn.rkn_no)}</div>
        <div>Date: ${escapeHtml(fmtDate(rkn.rkn_date))}</div>
        <div>Source: ${escapeHtml(rkn.source_type || "—")} · ${escapeHtml(rkn.source_no || "—")}</div>
        <div>RKN Qty: ${sumRknQty(rkn) || "—"}</div>
        <div>Status: ${escapeHtml(statusMeta(rkn.status).label)}</div>
      </div>`).join("");

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<title>${escapeHtml(rn.rn_no)} — Receipt Note</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 32px; color: #0f172a; }
  h1 { font-size: 22px; font-weight: 900; margin: 0 0 4px; text-align: center; letter-spacing: 0.12em; text-transform: uppercase; }
  .type-pill { display: inline-block; padding: 3px 8px; border-radius: 3px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; background: #e0e7ff; color: #3730a3; }
  .status-pill { display: inline-block; padding: 3px 8px; border-radius: 3px; font-size: 10px; font-weight: 700; text-transform: uppercase; background: #f1f5f9; color: #334155; }
  .header-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 16px 0; padding: 14px; border: 1px solid #e2e8f0; border-radius: 4px; }
  .field-label { font-size: 9px; color: #64748b; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; }
  .field-value { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; margin-top: 2px; }
  .section-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #475569; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 11px; }
  th { text-align: left; padding: 6px 8px; background: #f1f5f9; border-bottom: 2px solid #cbd5e1; font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  td { padding: 6px 8px; border-bottom: 1px solid #e2e8f0; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; }
  .three-col { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-top: 20px; page-break-inside: avoid; }
  .note-card { border: 1px solid #e2e8f0; border-radius: 4px; padding: 8px; font-size: 10px; background: #f8fafc; margin-bottom: 6px; font-family: ui-monospace, "SF Mono", Menlo, monospace; line-height: 1.6; }
  .note-no { font-weight: 700; color: #1e3a8a; margin-bottom: 4px; }
  .empty { font-size: 10px; color: #94a3b8; font-style: italic; }
  .footer { margin-top: 24px; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 8px; }
  @media print { body { padding: 12mm; } .three-col { page-break-inside: avoid; } }
</style></head>
<body>
  <h1>Receipt Note</h1>
  <div style="text-align:center;margin-bottom:12px;">
    <span class="type-pill">${escapeHtml(sit.label)} Stock In</span>
    &nbsp;
    <span class="status-pill">${escapeHtml(sm.label)}</span>
  </div>

  <div class="header-grid">
    <div>
      ${pField("Receipt Note No", rn.rn_no)}
      ${pField("Receipt Note Date", fmtDate(rn.rn_date))}
      ${pField("Invoice No", rn.invoice_no || "—")}
      ${pField("Invoice Date", fmtDate(rn.invoice_date))}
      ${pField("Material Received Date", fmtDate(rn.goods_received_date))}
      ${pField("Status", sm.label)}
    </div>
    <div>
      ${pField("Created By", rn.created_by || "—")}
      ${pField("Created At", fmtDateTime(rn.created_at))}
      ${pField("Assigned To", rn.assigned_to_name || rn.assigned_to_email || "—")}
      <div><div class="field-label">NARRATION</div><div class="field-value" style="white-space:pre-wrap">${escapeHtml(String(rn.narration ?? "—"))}</div></div>
    </div>
  </div>

  <div class="section-title">Items (${(rn.items || []).length})</div>
  <table>
    <thead><tr>
      <th>Sl No</th><th>Model</th><th>Part No</th><th>Description 1</th><th>Make</th>
      <th style="text-align:right">Invoice Qty</th>
      <th style="text-align:right">Received Qty</th>
      <th style="text-align:right">Diff Qty</th>
    </tr></thead>
    <tbody>${items}</tbody>
  </table>

  <div class="three-col">
    <div>
      <div class="section-title">SRN Details</div>
      ${srnHtml}
    </div>
    <div>
      <div class="section-title">ERN Details</div>
      ${ernHtml}
    </div>
    <div>
      <div class="section-title">RKN Details</div>
      ${rknHtml}
    </div>
  </div>

  <div class="footer">
    Printed: ${escapeHtml(new Date().toLocaleString())}
    &nbsp;·&nbsp; Printed by: ${escapeHtml(rn.created_by || "—")}
  </div>
  <script>window.onload = () => { setTimeout(() => window.print(), 100); };</script>
</body></html>`;

  const w = window.open("", "_blank", "width=1000,height=750");
  if (!w) { toast.error("Popup blocked — allow popups for this site to print"); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* --------------------------------------------------------------
   Print view for SRN (Short Received Note)
   -------------------------------------------------------------- */
function printSrn(srn, me) {
  if (!srn) return;
  const pF = (label, val) =>
    `<div><div class="field-label">${escapeHtml(label)}</div><div class="field-value">${escapeHtml(String(val ?? "—"))}</div></div>`;

  // Build items rows: summary row per item, then child rows
  let itemRows = "";
  let slNo = 0;
  (srn.items || []).forEach((it) => {
    slNo++;
    const totalChildRcv = (it.children || []).reduce((s, c) => s + (parseFloat(c.received_qty) || 0), 0);
    const totalChildNR  = (it.children || []).reduce((s, c) => s + (parseFloat(c.not_receivable_qty) || 0), 0);
    const summaryPending = Math.max(0, (parseFloat(it.short_qty) || 0) - totalChildRcv - totalChildNR);
    itemRows += `<tr class="summary-row">
      <td>${slNo}</td>
      <td><strong>${escapeHtml(it.part_no || "")}</strong></td>
      <td>${escapeHtml(it.description_1 || "—")}</td>
      <td>${escapeHtml(it.make || "")}</td>
      <td style="text-align:right;color:#b91c1c;font-weight:700">${(parseFloat(it.short_qty) || 0).toFixed(2)}</td>
      <td style="text-align:right;color:#15803d">${totalChildRcv.toFixed(2)}</td>
      <td style="text-align:right">${totalChildNR.toFixed(2)}</td>
      <td style="text-align:right;font-weight:700;color:${summaryPending > 0.001 ? "#b45309" : "#15803d"}">${summaryPending.toFixed(2)}</td>
      <td>—</td>
    </tr>`;
    let runningShort = parseFloat(it.short_qty) || 0;
    (it.children || []).forEach((c) => {
      const childRcv = parseFloat(c.received_qty) || 0;
      const childNR  = parseFloat(c.not_receivable_qty) || 0;
      const childPending = Math.max(0, runningShort - childRcv - childNR);
      const isDraft = c.finalized === false;
      itemRows += `<tr class="child-row">
        <td></td>
        <td colspan="3" style="padding-left:20px;font-size:10px;color:#64748b">
          ${isDraft ? '<span style="background:#fef9c3;color:#854d0e;font-size:9px;padding:1px 4px;border-radius:2px;font-weight:700">DRAFT</span>' : '<span style="background:#dcfce7;color:#166534;font-size:9px;padding:1px 4px;border-radius:2px;font-weight:700">FINAL</span>'}
        </td>
        <td style="text-align:right;color:#64748b;font-size:10px">${runningShort.toFixed(2)}</td>
        <td style="text-align:right">${childRcv.toFixed(2)}</td>
        <td style="text-align:right">${childNR.toFixed(2)}</td>
        <td style="text-align:right;color:${childPending > 0.001 ? "#b45309" : "#15803d"}">${childPending.toFixed(2)}</td>
        <td style="font-family:monospace;font-size:11px;color:#1d4ed8">${escapeHtml(c.child_srn_no || "")}</td>
      </tr>`;
      runningShort = childPending;
    });
  });

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<title>${escapeHtml(srn.srn_no || "SRN")} — Short Received Note</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:32px;color:#0f172a;font-size:13px}
  h1{font-size:20px;font-weight:900;text-align:center;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 16px}
  .header-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:0 0 20px;padding:14px;border:1px solid #e2e8f0;border-radius:4px}
  .header-left,.header-right{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .field-label{font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;font-weight:700}
  .field-value{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12px;margin-top:2px}
  table{width:100%;border-collapse:collapse;margin-top:16px;font-size:11px}
  th{text-align:left;padding:6px 8px;background:#f1f5f9;border-bottom:2px solid #cbd5e1;font-size:9px;text-transform:uppercase;letter-spacing:0.06em;font-weight:700}
  td{padding:5px 8px;border-bottom:1px solid #e2e8f0;font-family:ui-monospace,"SF Mono",Menlo,monospace}
  tr.summary-row{background:#f8fafc;font-weight:600}
  tr.child-row{background:#ffffff}
  .narration-box{margin-top:20px;padding:10px 14px;border:1px solid #e2e8f0;border-radius:4px}
  .footer{margin-top:20px;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:8px;display:flex;justify-content:space-between}
  @media print{body{padding:12mm}}
</style></head><body>
<h1>Short Received Note</h1>
<div class="header-grid">
  <div class="header-left">
    ${pF("RECEIPT NOTE DATE", srn.parent_rn_date ? srn.parent_rn_date.split("T")[0].split("-").reverse().join("-") : "—")}
    ${pF("RECEIPT NOTE NO", srn.parent_rn_no)}
    ${pF("SRN DATE", srn.srn_date ? srn.srn_date.split("T")[0].split("-").reverse().join("-") : "—")}
    ${pF("SRN NO", srn.srn_no)}
  </div>
  <div class="header-right">
    ${pF("ASSIGNED TO", srn.assigned_to_name || srn.assigned_to_email || "—")}
    ${pF("STATUS", srn.status || "—")}
  </div>
</div>
<table>
  <thead><tr>
    <th class="w-8">SL NO</th><th>PART NO</th><th>DESCRIPTION 1</th><th>MAKE</th>
    <th style="text-align:right">SHORT QTY</th><th style="text-align:right">RECEIVED QTY</th>
    <th style="text-align:right">NR QTY</th><th style="text-align:right">PENDING QTY</th>
    <th>CHILD SRN NO</th>
  </tr></thead>
  <tbody>${itemRows}</tbody>
</table>
${srn.narration ? `<div class="narration-box"><div class="field-label">NARRATION</div><div class="field-value" style="white-space:pre-wrap;margin-top:4px">${escapeHtml(srn.narration)}</div></div>` : ""}
<div class="footer">
  <span>Printed: ${new Date().toLocaleString()}</span>
  <span>By: ${escapeHtml(me?.name || me?.email || "—")}</span>
</div>
<script>window.onload=()=>{setTimeout(()=>window.print(),100)}</script>
</body></html>`;

  const w = window.open("", "_blank", "width=1000,height=750");
  if (!w) { toast.error("Popup blocked — allow popups to print"); return; }
  w.document.open(); w.document.write(html); w.document.close();
}

/* --------------------------------------------------------------
   Print view for ERN (Extra Received Note)
   -------------------------------------------------------------- */
function printErn(ern, me) {
  if (!ern) return;
  const pF = (label, val) =>
    `<div><div class="field-label">${escapeHtml(label)}</div><div class="field-value">${escapeHtml(String(val ?? "—"))}</div></div>`;

  let itemRows = "";
  let slNo = 0;
  (ern.items || []).forEach((it) => {
    slNo++;
    const totalChildAcc = (it.children || []).reduce((s, c) => s + (parseFloat(c.accepted_qty) || 0), 0);
    const totalChildRej = (it.children || []).reduce((s, c) => s + (parseFloat(c.rejected_qty) || 0), 0);
    const summaryPending = Math.max(0, (parseFloat(it.extra_qty) || 0) - totalChildAcc - totalChildRej);
    itemRows += `<tr class="summary-row">
      <td>${slNo}</td>
      <td><strong>${escapeHtml(it.part_no || "")}</strong></td>
      <td>${escapeHtml(it.description_1 || "—")}</td>
      <td>${escapeHtml(it.make || "")}</td>
      <td style="text-align:right;color:#b45309;font-weight:700">${(parseFloat(it.extra_qty) || 0).toFixed(2)}</td>
      <td style="text-align:right;color:#15803d">${totalChildAcc.toFixed(2)}</td>
      <td style="text-align:right;color:#b91c1c">${totalChildRej.toFixed(2)}</td>
      <td style="text-align:right;font-weight:700;color:${summaryPending > 0.001 ? "#b45309" : "#15803d"}">${summaryPending.toFixed(2)}</td>
      <td>—</td>
    </tr>`;
    let runningExtra = parseFloat(it.extra_qty) || 0;
    (it.children || []).forEach((c) => {
      const childAcc = parseFloat(c.accepted_qty) || 0;
      const childRej = parseFloat(c.rejected_qty) || 0;
      const childPending = Math.max(0, runningExtra - childAcc - childRej);
      const isDraft = c.finalized === false;
      itemRows += `<tr class="child-row">
        <td></td>
        <td colspan="3" style="padding-left:20px;font-size:10px;color:#64748b">
          ${isDraft ? '<span style="background:#fef9c3;color:#854d0e;font-size:9px;padding:1px 4px;border-radius:2px;font-weight:700">DRAFT</span>' : '<span style="background:#dcfce7;color:#166534;font-size:9px;padding:1px 4px;border-radius:2px;font-weight:700">FINAL</span>'}
        </td>
        <td style="text-align:right;color:#64748b;font-size:10px">${runningExtra.toFixed(2)}</td>
        <td style="text-align:right">${childAcc.toFixed(2)}</td>
        <td style="text-align:right">${childRej.toFixed(2)}</td>
        <td style="text-align:right;color:${childPending > 0.001 ? "#b45309" : "#15803d"}">${childPending.toFixed(2)}</td>
        <td style="font-family:monospace;font-size:11px;color:#1d4ed8">${escapeHtml(c.child_ern_no || "")}</td>
      </tr>`;
      runningExtra = childPending;
    });
  });

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<title>${escapeHtml(ern.ern_no || "ERN")} — Extra Received Note</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:32px;color:#0f172a;font-size:13px}
  h1{font-size:20px;font-weight:900;text-align:center;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 16px}
  .header-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:0 0 20px;padding:14px;border:1px solid #e2e8f0;border-radius:4px}
  .header-left,.header-right{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .field-label{font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;font-weight:700}
  .field-value{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12px;margin-top:2px}
  table{width:100%;border-collapse:collapse;margin-top:16px;font-size:11px}
  th{text-align:left;padding:6px 8px;background:#f1f5f9;border-bottom:2px solid #cbd5e1;font-size:9px;text-transform:uppercase;letter-spacing:0.06em;font-weight:700}
  td{padding:5px 8px;border-bottom:1px solid #e2e8f0;font-family:ui-monospace,"SF Mono",Menlo,monospace}
  tr.summary-row{background:#f8fafc;font-weight:600}
  tr.child-row{background:#ffffff}
  .narration-box{margin-top:20px;padding:10px 14px;border:1px solid #e2e8f0;border-radius:4px}
  .footer{margin-top:20px;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:8px;display:flex;justify-content:space-between}
  @media print{body{padding:12mm}}
</style></head><body>
<h1>Extra Received Note</h1>
<div class="header-grid">
  <div class="header-left">
    ${pF("RECEIPT NOTE DATE", ern.parent_rn_date ? ern.parent_rn_date.split("T")[0].split("-").reverse().join("-") : "—")}
    ${pF("RECEIPT NOTE NO", ern.parent_rn_no)}
    ${pF("ERN DATE", ern.ern_date ? ern.ern_date.split("T")[0].split("-").reverse().join("-") : "—")}
    ${pF("ERN NO", ern.ern_no)}
  </div>
  <div class="header-right">
    ${pF("ASSIGNED TO", ern.assigned_to_name || ern.assigned_to_email || "—")}
    ${pF("STATUS", ern.status || "—")}
  </div>
</div>
<table>
  <thead><tr>
    <th>SL NO</th><th>PART NO</th><th>DESCRIPTION 1</th><th>MAKE</th>
    <th style="text-align:right">EXTRA QTY</th><th style="text-align:right">ACCEPTED QTY</th>
    <th style="text-align:right">REJECTED QTY</th><th style="text-align:right">PENDING QTY</th>
    <th>CHILD ERN NO</th>
  </tr></thead>
  <tbody>${itemRows}</tbody>
</table>
${ern.narration ? `<div class="narration-box"><div class="field-label">NARRATION</div><div class="field-value" style="white-space:pre-wrap;margin-top:4px">${escapeHtml(ern.narration)}</div></div>` : ""}
<div class="footer">
  <span>Printed: ${new Date().toLocaleString()}</span>
  <span>By: ${escapeHtml(me?.name || me?.email || "—")}</span>
</div>
<script>window.onload=()=>{setTimeout(()=>window.print(),100)}</script>
</body></html>`;

  const w = window.open("", "_blank", "width=1000,height=750");
  if (!w) { toast.error("Popup blocked — allow popups to print"); return; }
  w.document.open(); w.document.write(html); w.document.close();
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
  model: "",
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
  const [narration, setNarration] = useState("");
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
      setNarration(editing.narration || "");
      const initial = (editing.items || []).map((it) => ({
        part_no: it.part_no || "",
        make: it.make || "",
        invoice_qty: (it.invoice_qty ?? it.quantity ?? ""),
        received_qty: (it.received_qty ?? (isFinalEdit ? (it.quantity ?? "") : "")),
        description_1: it.description_1 || "",
        model: "",
        makes: it.make ? [it.make] : [],
        partLooked: !!it.part_no,
      }));
      setItems(initial.length ? initial : [emptyItem()]);
      // Refresh make lists and fetch model for display
      initial.forEach((row, idx) => {
        if (!row.part_no) return;
        api.get("/stock-master/lookup/makes", { params: { part_no: row.part_no } })
          .then(({ data }) => {
            const list = data.makes || [];
            const merged = row.make && !list.includes(row.make) ? [...list, row.make] : list;
            setItems((prev) => prev.map((r, i) => i === idx ? { ...r, makes: merged } : r));
          }).catch(() => {});
        if (row.make) {
          api.get("/stock-master/lookup/item", { params: { part_no: row.part_no, make: row.make } })
            .then(({ data: m }) => {
              setItems((prev) => prev.map((r, i) => i === idx ? { ...r, model: m.model || "" } : r));
            }).catch(() => {});
        }
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
  let n = Math.max(1, Math.min(500, parseInt(addCount, 10) || 1));
  // If user entered a number, subtract 1 because one row already exists
  if (addCount && parseInt(addCount, 10) > 0) {
    n = Math.max(1, n - 1);
  }
  setItems((p) => [...p, ...Array.from({ length: n }, emptyItem)]);
  setAddCount("");
};
  const removeItem = (i) => setItems((p) => (p.length === 1 ? p : p.filter((_, idx) => idx !== i)));
  const updateItem = (i, patch) => setItems((p) => p.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  // Lookup makes when Part No is entered
  const lookupMakes = async (i, partNo) => {
    const v = (partNo || "").trim();
    if (!v) {
      updateItem(i, { makes: [], make: "", partLooked: false, description_1: "", model: "" });
      return;
    }
    try {
      const { data } = await api.get("/stock-master/lookup/makes", { params: { part_no: v } });
      const list = data.makes || [];
      // If exactly one make is auto-selected, also fetch description_1 + model for that pair
      const autoMake = list.length === 1 ? list[0] : "";
      updateItem(i, { makes: list, partLooked: true, make: autoMake });
      if (autoMake) {
        try {
          const { data: m } = await api.get("/stock-master/lookup/item", { params: { part_no: v, make: autoMake } });
          updateItem(i, { description_1: m.description_1 || "", model: m.model || "" });
        } catch { /* ignore */ }
      } else {
        updateItem(i, { description_1: "", model: "" });
      }
    } catch {
      updateItem(i, { makes: [], partLooked: true, make: "", description_1: "", model: "" });
    }
  };

  // Fetch description_1 + model when make is picked
  const fetchDescription = async (i, partNo, make) => {
    if (!partNo || !make) return;
    try {
      const { data } = await api.get("/stock-master/lookup/item", { params: { part_no: partNo, make } });
      updateItem(i, { description_1: data.description_1 || "", model: data.model || "" });
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
      ? { ...r, makes: [...new Set([...(r.makes || []), newItem.make])], make: newItem.make, partLooked: true, description_1: newItem.description_1 || "", model: newItem.model || "", masterMissing: false }
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
          model: "",
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
                          setItems((p) => p.map((rr, i) => i === idx ? { ...rr, description_1: m.description_1 || "", model: m.model || "" } : rr));
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
  // Convert to Date objects for proper comparison
  const today = new Date();
  today.setHours(0, 0, 0, 0); // Set to start of day
  
  if (invoiceDate) {
    const invoiceDateObj = new Date(invoiceDate);
    invoiceDateObj.setHours(0, 0, 0, 0);
    if (invoiceDateObj > today) {
      toast.error("Invoice Date cannot be in the future");
      return false;
    }
  }
  
  if (goodsReceivedDate) {
    const goodsReceivedDateObj = new Date(goodsReceivedDate);
    goodsReceivedDateObj.setHours(0, 0, 0, 0);
    if (goodsReceivedDateObj > today) {
      toast.error("Goods Received Date cannot be in the future");
      return false;
    }
  }
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
  
  // Use Date objects for future date check (same as validateDates)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  if (invoiceDate) {
    const invoiceDateObj = new Date(invoiceDate);
    invoiceDateObj.setHours(0, 0, 0, 0);
    if (invoiceDateObj > today) return false;
  }
  
  if (goodsReceivedDate) {
    const goodsReceivedDateObj = new Date(goodsReceivedDate);
    goodsReceivedDateObj.setHours(0, 0, 0, 0);
    if (goodsReceivedDateObj > today) return false;
  }
  
  return true;
}, [items, allMakesFilled, allReceivedValid, invoiceDate, goodsReceivedDate, isGeneral]);

  const buildPayload = () => ({
    stock_in_type: stockInType,
    invoice_no: isGeneral ? "" : invoiceNo.trim(),
    invoice_date: isGeneral ? "" : (invoiceDate || ""),
    goods_received_date: goodsReceivedDate || "",
    assigned_to_user_id: assignedToUserId || null,
    narration: narration.trim(),
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
        const finRes = await api.post(`/receipt-notes/${rnId}/finalize`);
        const autoRkn = finRes.headers?.["x-auto-rkn-no"];
        if (autoRkn) {
          toast.success(`Receipt Note ${rnNoDisplay} finalized — ${autoRkn} auto-created for racking`);
        } else {
          toast.success(`Receipt Note ${rnNoDisplay} finalized`);
        }
      } else {
        toast.success(`Receipt Note ${rnNoDisplay} finalized`);
      }
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not finalize receipt note");
    } finally { setSavingFinal(false); }
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
              onClick={handleDownloadTemplate}
              variant="outline"
              className="rounded-sm"
              data-testid="rn-excel-template-button"
              title="Download an empty Excel template (Part No, Invoice Qty, Received Qty, Make)"
            >
              <DownloadSimple size={14} weight="bold" className="mr-1" /> Download Template
            </Button>
            <Button
              onClick={() => fileInputRef.current?.click()}
              variant="outline"
              className="rounded-sm"
              data-testid="rn-excel-import-button"
              title={isGeneral ? "Columns: Part No, Make, Received Qty" : "Columns: Part No, Invoice Qty, Make, Received Qty"}
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

        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="w-14">SL NO</th>
                <th className="w-32">MODEL</th>
                <th className="w-44">PART NO</th>
                <th>DESCRIPTION 1</th>
                <th className="w-56">MAKE</th>
                <th className="w-28 text-right">{isGeneral ? "INV QTY" : "INVOICE QTY"}</th>
                <th className="w-28 text-right">RECEIVED QTY</th>
                <th className="w-24 text-right">QTY DIFF</th>
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
                    <td className="w-32">
                      <div
                        className="text-xs text-slate-700 px-2 py-1 bg-slate-50 rounded-sm border border-slate-200 truncate"
                        title={it.model || "—"}
                        data-testid={`rn-model-${idx}`}
                      >
                        {it.model || <span className="text-slate-400 italic">(auto)</span>}
                      </div>
                    </td>
                    <td>
                      <Input
                        value={it.part_no}
                        onChange={(e) => updateItem(idx, { part_no: e.target.value, partLooked: false, makes: [], make: "", description_1: "", model: "" })}
                        onBlur={(e) => lookupMakes(idx, e.target.value)}
                        onKeyDown={async (e) => {
                          if (e.key === "Tab" && !e.shiftKey && e.target.value.trim() && !it.partLooked) {
                            e.preventDefault();
                            await lookupMakes(idx, e.target.value);
                            setTimeout(() => {
                              document.querySelector(`[data-testid="rn-make-${idx}"]`)?.focus();
                            }, 0);
                          }
                        }}
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
                    <td className="w-56">
                      <MakeDropdown
  value={it.make}
  makes={it.makes}
  partLooked={it.partLooked}
  onChange={(v) => handleMakeChange(idx, v)}
  testid={`rn-make-${idx}`}
/>
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
  onKeyDown={(e) => {
    if (e.key === "Tab" && !e.shiftKey && isLastRow) {
      e.preventDefault();
      if (items.length > 1) {
        const deleteBtn = document.querySelector(`[data-testid="rn-remove-row-${idx}"]`);
        if (deleteBtn && !deleteBtn.disabled) deleteBtn.focus();
      } else {
        const narrationField = document.querySelector('[data-testid="rn-narration"]');
        if (narrationField) narrationField.focus();
      }
    }
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
  onKeyDown={(e) => {
    if (e.key === "Tab" && !e.shiftKey && isLastRow && items.length > 1) {
      e.preventDefault();
      const narrationField = document.querySelector('[data-testid="rn-narration"]');
      if (narrationField) narrationField.focus();
    }
  }}
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

        {/* SAVE BAR — narration on left, action buttons on right */}
        <div className="flex items-start justify-between gap-4 p-4 border-t border-slate-200 bg-slate-50">
          <div className="flex-1 max-w-sm">
            <label className="label-sm block mb-1.5">Narration</label>
            <textarea
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Tab" && !e.shiftKey) {
                  e.preventDefault();
                  const draftBtn = document.querySelector('[data-testid="rn-save-draft-button"]');
                  if (draftBtn && !draftBtn.disabled) {
                    draftBtn.focus();
                  } else {
                    const finalBtn = document.querySelector('[data-testid="rn-save-final-button"]');
                    if (finalBtn) finalBtn.focus();
                  }
                }
              }}
              placeholder="Optional narration…"
              rows={2}
              className="w-full rounded-sm border border-slate-300 bg-white px-3 py-1.5 text-sm font-mono resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
              data-testid="rn-narration"
            />
          </div>
          <div className="flex items-center gap-2 pt-7">
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

  const handleOpenChild = async (childId, k) => {
    if (!childId) return;
    const path = k === "ern" ? "/extra-received-notes" : "/short-received-notes";
    try {
      const { data } = await api.get(`${path}/${childId}`);
      setOpenDetail(data);
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not load child");
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
        <SrnFinalizeForm srn={editing} onCancel={goList} onSaved={goList} onOpenRn={handleOpenRn} />
      )}
      <ChildDetailDialog kind="srn" doc={openDetail} onClose={() => setOpenDetail(null)} onOpen={handleOpenChild} />
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

  const handleOpenChild = async (childId, k) => {
    if (!childId) return;
    const path = k === "srn" ? "/short-received-notes" : "/extra-received-notes";
    try {
      const { data } = await api.get(`${path}/${childId}`);
      setOpenDetail(data);
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not load child");
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
        <ErnFinalizeForm ern={editing} onCancel={goList} onSaved={goList} onOpenRn={handleOpenRn} />
      )}
      <ChildDetailDialog kind="ern" doc={openDetail} onClose={() => setOpenDetail(null)} onOpen={handleOpenChild} />
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
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const searchInputRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(path, { params: { page, page_size: PAGE_SIZE, search: search || undefined } });
      setRows(res.data || []);
      const t = parseInt(res.headers["x-total-count"], 10);
      setTotal(isNaN(t) ? (res.data || []).length : t);
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || `Could not load ${noun}s`);
    } finally { setLoading(false); }
  }, [path, noun, search, page]);
  useEffect(() => { load(); }, [load, reloadKey]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
      { key: "stock_in_type", label: "STOCK IN TYPE", value: (r) => stockInTypeLabel(r.parent_stock_in_type) },
      { key: "rn_date", label: "RECEIPT NOTE DATE", value: (r) => fmtDate(r.parent_rn_date) },
      { key: "rn_no", label: "RECEIPT NOTE NO", value: (r) => r.parent_rn_no || "" },
      { key: "doc_date", label: `${noun} DATE`, value: (r) => fmtDate(r[dateField]) },
      { key: "doc_no", label: `${noun} NO`, value: (r) => r[idField] || "" },
      { key: "status", label: "STATUS", value: (r) => statusMeta(r.status).label },
    ];
    return cols;
  }, [isSrn, noun, dateField, idField]);

  const {
    filteredRows, uniqueValues, colFilters, setColFilter, sort, setColumnSort,
  } = useExcelTableFilter(rows, columns);

  return (
    <div className="mt-4" data-testid={`${kind}-list-view`}>
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
  <div />
  <div className="flex items-center gap-2">
    <Input
      ref={searchInputRef}
      value={search}
      onChange={(e) => { setSearch(e.target.value); setPage(1); }}
      placeholder={`Search`}
      className="rounded-sm font-mono h-9 w-80"
      data-testid={`${kind}-search-input`}
    />
    <Button onClick={load} variant="outline" disabled={loading} className="rounded-sm border-slate-300" data-testid={`${kind}-refresh`}>
      <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
    </Button>
    <Button
      onClick={() => {
        if (filteredRows.length === 0) { toast.error("No rows to export"); return; }
        const exportCols = [
          { label: "Sl No", value: (r) => filteredRows.indexOf(r) + 1 },
          { label: "Receipt Note Date", value: (r) => fmtDate(r.parent_rn_date) },
          { label: "Receipt Note No", value: (r) => r.parent_rn_no || "" },
          { label: `${noun} Date`, value: (r) => fmtDate(r[dateField]) },
          { label: `${noun} No`, value: (r) => r[idField] || "" },
          { label: "Assigned To", value: (r) => r.assigned_to_name || r.assigned_to_email || "" },
          { label: "Status", value: (r) => statusMeta(r.status).label },
          isSrn
            ? { label: "Short Qty", value: (r) => sumSrnQty(r) }
            : { label: "Extra Qty", value: (r) => sumErnQty(r) },
          isSrn
            ? { label: "Received Qty", value: (r) => sumSrnReceived(r) }
            : { label: "Accepted Qty", value: (r) => sumErnAccepted(r) },
          isSrn
            ? { label: "Not Receivable Qty", value: (r) => sumSrnNotReceivable(r) }
            : { label: "Rejected Qty", value: (r) => sumErnRejected(r) },
        ];
        exportToExcel(filteredRows, exportCols, `${isSrn ? "Short" : "Extra"}_Received_Notes_${todayISO()}.xlsx`);
      }}
      variant="outline" className="rounded-sm border-slate-300" data-testid={`${kind}-export`}>
      <DownloadSimple size={14} weight="bold" className="mr-2" /> Export
    </Button>
  </div>
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
              <th className="w-28 text-left">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r, idx) => {
              const meta = statusMeta(r.status);
              const canEdit = r.status !== "COMPLETE";
              return (
                <tr key={r.id} data-testid={`${kind}-row-${r[idField]}`}>
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td>
                    {(() => { const sit = stockInTypeMeta(r.parent_stock_in_type); return (
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${sit.cls}`}
                            data-testid={`${kind}-stock-in-type-${r[idField]}`}>
                        {sit.label}
                      </span>
                    ); })()}
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
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${meta.cls}`}>
                      {meta.label}
                    </span>
                  </td>

                  <td className="text-left">
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
              <tr><td colSpan={8} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? `No ${noun}s yet. They appear automatically when a Receipt Note is finalized with ${isSrn ? "a shortfall" : "an overage"}.` : "No rows match the current filters.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between mt-3 text-xs text-slate-600">
        <div>
  {total === 0 ? "No short received notes" : (
    <>
      Showing <span className="font-semibold text-slate-900">{filteredRows.length}</span>
      {" - "}<span className="font-semibold text-slate-900">{total}</span> total
    </>
  )}
</div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading} variant="outline" size="sm" className="rounded-sm h-7" data-testid={`${kind}-prev`}>
            <CaretLeft size={12} weight="bold" className="mr-1" /> Prev
          </Button>
          <span className="font-mono">Page {page} of {totalPages}</span>
          <Button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages || loading} variant="outline" size="sm" className="rounded-sm h-7" data-testid={`${kind}-next`}>
            Next <CaretRight size={12} weight="bold" className="ml-1" />
          </Button>
          <span className="text-slate-400 ml-2">{PAGE_SIZE.toLocaleString()} / page</span>
        </div>
      </div>
    </div>
  );
}

/** Read-only detail dialog for SRN/ERN — layout mirrors the print format, includes Print button. */
function ChildDetailDialog({ kind, doc, onClose, onOpen }) {
  const { user: me } = useAuth();
  if (!doc) return null;
  const isSrn = kind === "srn";
  const idField = isSrn ? "srn_no" : "ern_no";
  const dateField = isSrn ? "srn_date" : "ern_date";
  const meta = statusMeta(doc.status);

  return (
    <Dialog open={!!doc} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl rounded-sm max-h-[90vh] overflow-y-auto" data-testid={`${kind}-detail-dialog`}>
        <DialogHeader>
          <DialogTitle className="text-center text-base font-black uppercase tracking-widest">
            {isSrn ? "Short Received Note" : "Extra Received Note"}
          </DialogTitle>
        </DialogHeader>

        {/* Header: 4-field + 2-field rows */}
        <div className="space-y-3 py-2">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Detail k="RECEIPT NOTE DATE" v={fmtDate(doc.parent_rn_date)} />
            <Detail k="RECEIPT NOTE NO" v={doc.parent_rn_no || "—"} />
            <Detail k={`${isSrn ? "SRN" : "ERN"} DATE`} v={fmtDate(doc[dateField])} />
            <Detail k={`${isSrn ? "SRN" : "ERN"} NO`} v={doc[idField] || "—"} />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 pt-2 border-t border-slate-100">
            <Detail k="ASSIGNED TO" v={doc.assigned_to_name || doc.assigned_to_email || "—"} />
            <div>
              <div className="label-sm">STATUS</div>
              <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm mt-1 inline-block ${meta.cls}`}>{meta.label}</span>
            </div>
          </div>
        </div>
        {doc.chain_remarks && (
          <div className="text-xs text-slate-500 italic border-l-2 border-slate-200 pl-3">{doc.chain_remarks}</div>
        )}

        {/* Items table: Summary + Child rows, no ACTIONS column */}
        <div className="overflow-x-auto border border-slate-200 rounded-sm">
          <table className="data-table w-full text-xs">
            <thead>
              <tr>
                <th className="w-10">SL NO</th>
                <th>PART NO</th>
                <th>DESCRIPTION 1</th>
                <th>MAKE</th>
                {isSrn ? (
                  <>
                    <th className="text-right">SHORT QTY</th>
                    <th className="text-right">RECEIVED QTY</th>
                    <th className="text-right">NR QTY</th>
                    <th className="text-right">PENDING QTY</th>
                    <th>CHILD SRN NO</th>
                  </>
                ) : (
                  <>
                    <th className="text-right">EXTRA QTY</th>
                    <th className="text-right">ACCEPTED QTY</th>
                    <th className="text-right">REJECTED QTY</th>
                    <th className="text-right">PENDING QTY</th>
                    <th>CHILD ERN NO</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {(doc.items || []).flatMap((it, idx) => {
                const rows = [];
                if (isSrn) {
                  const shortQ = parseFloat(it.short_qty) || 0;
                  const totalRcv = (it.children || []).reduce((s, c) => s + (parseFloat(c.received_qty) || 0), 0);
                  const totalNR  = (it.children || []).reduce((s, c) => s + (parseFloat(c.not_receivable_qty) || 0), 0);
                  const summaryPending = Math.max(0, shortQ - totalRcv - totalNR);
                  rows.push(
                    <tr key={`sum-${idx}`} className="bg-slate-50 font-semibold">
                      <td className="font-mono text-slate-500">{idx + 1}</td>
                      <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                      <td className="text-slate-700">{it.description_1 || "—"}</td>
                      <td>{it.make}</td>
                      <td className="text-right font-mono text-red-700">{shortQ.toFixed(2)}</td>
                      <td className="text-right font-mono text-green-700">{totalRcv.toFixed(2)}</td>
                      <td className="text-right font-mono">{totalNR.toFixed(2)}</td>
                      <td className={`text-right font-mono ${summaryPending > 0.001 ? "text-amber-700" : "text-green-700"}`}>{summaryPending.toFixed(2)}</td>
                      <td className="text-slate-400 font-mono">—</td>
                    </tr>
                  );
                  let runningShort = shortQ;
                  (it.children || []).forEach((c, ci) => {
                    const childRcv = parseFloat(c.received_qty) || 0;
                    const childNR = parseFloat(c.not_receivable_qty) || 0;
                    const childPending = Math.max(0, runningShort - childRcv - childNR);
                    const isDraftRow = c.finalized === false;
                    rows.push(
                      <tr key={`child-${idx}-${ci}`} className={isDraftRow ? "bg-yellow-50/60" : "bg-green-50/30"}>
                        <td className="font-mono text-slate-400 text-[10px] pl-4">{idx + 1}.{ci + 1}</td>
                        <td colSpan={3} className="text-xs text-slate-500 pl-4">
                          <span className="text-slate-300">└ </span>
                          <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-sm ${isDraftRow ? "bg-yellow-100 text-yellow-800" : "bg-green-100 text-green-800"}`}>
                            {isDraftRow ? "Draft" : "Final"}
                          </span>
                        </td>
                        <td className="text-right font-mono text-slate-500 text-[10px]">{runningShort.toFixed(2)}</td>
                        <td className="text-right font-mono font-semibold text-green-800">{childRcv.toFixed(2)}</td>
                        <td className="text-right font-mono text-slate-600">{childNR.toFixed(2)}</td>
                        <td className={`text-right font-mono ${childPending > 0.001 ? "text-amber-600" : "text-green-600"}`}>{childPending.toFixed(2)}</td>
                        <td className="font-mono text-[11px] text-blue-700">{c.child_srn_no}</td>
                      </tr>
                    );
                    runningShort = childPending;
                  });
                } else {
                  const extraQ = parseFloat(it.extra_qty) || 0;
                  const totalAcc = (it.children || []).reduce((s, c) => s + (parseFloat(c.accepted_qty) || 0), 0);
                  const totalRej = (it.children || []).reduce((s, c) => s + (parseFloat(c.rejected_qty) || 0), 0);
                  const summaryPending = Math.max(0, extraQ - totalAcc - totalRej);
                  rows.push(
                    <tr key={`sum-${idx}`} className="bg-slate-50 font-semibold">
                      <td className="font-mono text-slate-500">{idx + 1}</td>
                      <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                      <td className="text-slate-700">{it.description_1 || "—"}</td>
                      <td>{it.make}</td>
                      <td className="text-right font-mono text-amber-700">{extraQ.toFixed(2)}</td>
                      <td className="text-right font-mono text-green-700">{totalAcc.toFixed(2)}</td>
                      <td className="text-right font-mono text-red-700">{totalRej.toFixed(2)}</td>
                      <td className={`text-right font-mono ${summaryPending > 0.001 ? "text-amber-700" : "text-green-700"}`}>{summaryPending.toFixed(2)}</td>
                      <td className="text-slate-400 font-mono">—</td>
                    </tr>
                  );
                  let runningExtra = extraQ;
                  (it.children || []).forEach((c, ci) => {
                    const childAcc = parseFloat(c.accepted_qty) || 0;
                    const childRej = parseFloat(c.rejected_qty) || 0;
                    const childPending = Math.max(0, runningExtra - childAcc - childRej);
                    const isDraftRow = c.finalized === false;
                    rows.push(
                      <tr key={`child-${idx}-${ci}`} className={isDraftRow ? "bg-yellow-50/60" : "bg-green-50/30"}>
                        <td className="font-mono text-slate-400 text-[10px] pl-4">{idx + 1}.{ci + 1}</td>
                        <td colSpan={3} className="text-xs text-slate-500 pl-4">
                          <span className="text-slate-300">└ </span>
                          <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-sm ${isDraftRow ? "bg-yellow-100 text-yellow-800" : "bg-green-100 text-green-800"}`}>
                            {isDraftRow ? "Draft" : "Final"}
                          </span>
                        </td>
                        <td className="text-right font-mono text-slate-500 text-[10px]">{runningExtra.toFixed(2)}</td>
                        <td className="text-right font-mono font-semibold text-green-800">{childAcc.toFixed(2)}</td>
                        <td className="text-right font-mono text-red-700">{childRej.toFixed(2)}</td>
                        <td className={`text-right font-mono ${childPending > 0.001 ? "text-amber-600" : "text-green-600"}`}>{childPending.toFixed(2)}</td>
                        <td className="font-mono text-[11px] text-blue-700">{c.child_ern_no}</td>
                      </tr>
                    );
                    runningExtra = childPending;
                  });
                }
                return rows;
              })}
            </tbody>
          </table>
        </div>

        {/* Narration */}
        {doc.narration && (
          <div className="pt-2">
            <div className="label-sm">NARRATION</div>
            <div className="font-mono mt-1 text-sm text-slate-700 whitespace-pre-wrap">{doc.narration}</div>
          </div>
        )}

        <DialogFooter className="flex items-center justify-between pt-2">
          <Button onClick={() => isSrn ? printSrn(doc, me) : printErn(doc, me)}
            variant="outline" size="sm" className="rounded-sm border-slate-300">
            <Printer size={14} weight="bold" className="mr-1.5" /> Print
          </Button>
          <Button onClick={onClose} variant="outline" size="sm" className="rounded-sm border-slate-300">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** SRN entry/edit form — redesigned with grouped table, immediate child numbers, and page-level save. */
function SrnFinalizeForm({ srn: initialSrn, onCancel, onSaved, onOpenRn }) {
  const [parent, setParent] = useState(initialSrn);
  // pendingChildren: { [itemIdx]: [{ localId, childNo, shortQty, received_qty, not_receivable_qty }] }
  const [pendingChildren, setPendingChildren] = useState({});
  const [editingChild, setEditingChild] = useState(null); // { itemIdx, child_srn_no, received_qty, not_receivable_qty }
  const [narration, setNarration] = useState(initialSrn.narration || "");
  const [busy, setBusy] = useState(false);
  const { user: me } = useAuth();

  const reload = async () => {
    try {
      const { data } = await api.get(`/short-received-notes/${parent.id}`);
      setParent(data);
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not reload");
    }
  };

  // Effective pending for an item: accounts for saved + pending (unsaved) children
  const effectivePending = (item, idx) => {
    const savedUsed = (item.children || []).reduce(
      (s, c) => s + (parseFloat(c.received_qty) || 0) + (parseFloat(c.not_receivable_qty) || 0), 0
    );
    const pendingUsed = (pendingChildren[idx] || []).reduce(
      (s, p) => s + (parseFloat(p.received_qty) || 0) + (parseFloat(p.not_receivable_qty) || 0), 0
    );
    return Math.max(0, (parseFloat(item.short_qty) || 0) - savedUsed - pendingUsed);
  };

  // Summary totals: includes both saved and pending children
  const summaryRcv = (item, idx) =>
    (item.children || []).reduce((s, c) => s + (parseFloat(c.received_qty) || 0), 0) +
    (pendingChildren[idx] || []).reduce((s, p) => s + (parseFloat(p.received_qty) || 0), 0);
  const summaryNR = (item, idx) =>
    (item.children || []).reduce((s, c) => s + (parseFloat(c.not_receivable_qty) || 0), 0) +
    (pendingChildren[idx] || []).reduce((s, p) => s + (parseFloat(p.not_receivable_qty) || 0), 0);

  // Compute the next available child letter (A, B, C...) for an item
  const computeNextChildNo = (item, idx) => {
    const usedLetters = new Set([
      ...(item.children || []).map(c => { const p = (c.child_srn_no || "").split("-"); return p[p.length - 1]; }),
      ...(pendingChildren[idx] || []).map(p => { const parts = (p.childNo || "").split("-"); return parts[parts.length - 1]; }),
    ]);
    for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      if (!usedLetters.has(ch)) return `${parent.srn_no}-${ch}`;
    }
    return null;
  };

  const handleAddRow = (itemIdx) => {
    const item = parent.items[itemIdx];
    const childNo = computeNextChildNo(item, itemIdx);
    if (!childNo) { toast.error("Maximum child rows reached (26)"); return; }
    const shortQty = effectivePending(item, itemIdx);
    if (shortQty <= 0) { toast.error("No pending quantity remaining"); return; }
    setPendingChildren(prev => ({
      ...prev,
      [itemIdx]: [...(prev[itemIdx] || []), {
        localId: Math.random().toString(36).slice(2),
        childNo,
        shortQty,
        received_qty: "",
        not_receivable_qty: "",
      }],
    }));
  };

  const updatePendingRow = (itemIdx, rowIdx, field, value) => {
    setPendingChildren(prev => {
      const rows = [...(prev[itemIdx] || [])];
      rows[rowIdx] = { ...rows[rowIdx], [field]: value };
      return { ...prev, [itemIdx]: rows };
    });
  };

  const removePendingRow = (itemIdx, rowIdx) => {
    setPendingChildren(prev => {
      const rows = [...(prev[itemIdx] || [])];
      rows.splice(rowIdx, 1);
      if (rows.length === 0) {
        const next = { ...prev };
        delete next[itemIdx];
        return next;
      }
      return { ...prev, [itemIdx]: rows };
    });
  };

  const saveAll = async (isDraft) => {
    for (const [idx, rows] of Object.entries(pendingChildren)) {
      for (const r of rows) {
        const rcv = parseFloat(r.received_qty) || 0;
        const nrcv = parseFloat(r.not_receivable_qty) || 0;
        if (!rcv && !nrcv) { toast.error(`Row ${r.childNo}: enter at least one quantity`); return; }
        if (rcv + nrcv > r.shortQty + 1e-6) { toast.error(`Row ${r.childNo}: sum exceeds pending qty (${r.shortQty.toFixed(2)})`); return; }
      }
    }
    const hasPending = Object.values(pendingChildren).some(rows => rows.length > 0);
    const hasNarrationChange = narration !== (parent.narration || "");
    if (!hasPending && !hasNarrationChange) { toast.error("Nothing to save"); return; }
    setBusy(true);
    try {
      for (const [idx, rows] of Object.entries(pendingChildren)) {
        const item = parent.items[+idx];
        for (const r of rows) {
          const res = await api.post(`/short-received-notes/${parent.id}/children`, {
            part_no: item.part_no, make: item.make,
            received_qty: parseFloat(r.received_qty) || 0,
            not_receivable_qty: parseFloat(r.not_receivable_qty) || 0,
            is_draft: isDraft,
          });
          if (!isDraft) {
            const autoRkn = res.headers?.["x-auto-rkn-no"];
            if (autoRkn) toast.success(`${r.childNo} saved — ${autoRkn} auto-created for racking`);
          }
        }
      }
      if (hasNarrationChange) {
        await api.patch(`/short-received-notes/${parent.id}/narration`, { narration: narration.trim() });
      }
      setPendingChildren({});
      const { data } = await api.get(`/short-received-notes/${parent.id}`);
      setParent(data);
      toast.success(isDraft
        ? "Saved as draft — rows are editable, no racking note created"
        : "Saved final — rows are locked, racking note auto-created");
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save");
    } finally { setBusy(false); }
  };

  const saveEditedChild = async () => {
    if (!editingChild) return;
    const { itemIdx, child_srn_no, received_qty, not_receivable_qty } = editingChild;
    const item = parent.items[itemIdx];
    const rcv = parseFloat(received_qty) || 0;
    const nrcv = parseFloat(not_receivable_qty) || 0;
    if (!rcv && !nrcv) { toast.error("Enter at least one quantity"); return; }
    setBusy(true);
    try {
      const res = await api.put(
        `/short-received-notes/${parent.id}/children/${encodeURIComponent(child_srn_no)}`,
        { part_no: item.part_no, make: item.make, received_qty: rcv, not_receivable_qty: nrcv, is_draft: false },
      );
      const autoRkn = res.headers?.["x-auto-rkn-no"];
      if (autoRkn) toast.success(`Row updated — ${autoRkn} auto-created for racking`);
      else toast.success("Row updated");
      setEditingChild(null);
      await reload();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not update");
    } finally { setBusy(false); }
  };

  const deleteChild = async (childNo) => {
    if (!window.confirm("Delete this row?")) return;
    setBusy(true);
    try {
      await api.delete(`/short-received-notes/${parent.id}/children/${encodeURIComponent(childNo)}`);
      toast.success("Row deleted");
      await reload();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not delete");
    } finally { setBusy(false); }
  };

  const hasPendingRows = Object.values(pendingChildren).some(rows => rows.length > 0);
  const hasNarrationChange = narration !== (parent.narration || "");
  const canSave = hasPendingRows || hasNarrationChange;
  const meta = statusMeta(parent.status);

  return (
    <div className="mt-4 space-y-6" data-testid="srn-finalize-view">
      {/* TOP BAR */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="srn-back">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
        <Button onClick={() => printSrn(parent, me)} variant="outline" className="rounded-sm border-slate-300">
          <Printer size={14} weight="bold" className="mr-2" /> Print
        </Button>
      </div>

      {/* HEADER SECTION */}
      <div className="bg-white border border-slate-200 rounded-sm p-6 space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
          <Detail k="RECEIPT NOTE DATE" v={fmtDate(parent.parent_rn_date)} />
          <div>
            <div className="label-sm">RECEIPT NOTE NO</div>
            <button onClick={() => onOpenRn?.(parent.parent_rn_id)}
              className="font-mono mt-1 text-blue-700 hover:underline text-sm" data-testid="srn-open-rn">
              {parent.parent_rn_no || "—"}
            </button>
          </div>
          <Detail k="SRN DATE" v={fmtDate(parent.srn_date)} />
          <Detail k="SRN NO" v={parent.srn_no} />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 pt-3 border-t border-slate-100">
          <Detail k="ASSIGNED TO" v={parent.assigned_to_name || parent.assigned_to_email || "—"} />
          <div>
            <div className="label-sm">STATUS</div>
            <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm mt-1 inline-block ${meta.cls}`}>
              {meta.label}
            </span>
          </div>
        </div>
      </div>

      {/* ITEMS TABLE */}
      <div className="bg-white border border-slate-200 rounded-sm overflow-hidden">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-10">SL NO</th>
              <th className="w-36">PART NO</th>
              <th>DESCRIPTION 1</th>
              <th className="w-28">MAKE</th>
              <th className="w-24 text-right">SHORT QTY</th>
              <th className="w-28 text-right">RECEIVED QTY</th>
              <th className="w-24 text-right">NR QTY</th>
              <th className="w-24 text-right">PENDING QTY</th>
              <th className="w-36">CHILD SRN NO</th>
              <th className="w-20 text-center">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {(parent.items || []).flatMap((item, idx) => {
              const rows = [];
              const sPending = effectivePending(item, idx);
              const sRcv = summaryRcv(item, idx);
              const sNR = summaryNR(item, idx);

              // Summary Row (read-only)
              rows.push(
                <tr key={`sum-${idx}`} className="bg-slate-50 font-semibold">
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td><PartNoLink partNo={item.part_no} make={item.make} /></td>
                  <td className="text-xs text-slate-700 truncate max-w-[200px]" title={item.description_1}>{item.description_1 || "—"}</td>
                  <td className="text-xs text-slate-700">{item.make}</td>
                  <td className="text-right font-mono text-red-700">{(parseFloat(item.short_qty) || 0).toFixed(2)}</td>
                  <td className="text-right font-mono text-green-700">{sRcv.toFixed(2)}</td>
                  <td className="text-right font-mono text-slate-600">{sNR.toFixed(2)}</td>
                  <td className={`text-right font-mono ${sPending > 0.0001 ? "text-amber-700" : "text-green-700"}`}>{sPending.toFixed(2)}</td>
                  <td className="text-slate-400 font-mono text-xs">—</td>
                  <td className="text-center">
                    {sPending > 1e-6 && (
                      <button onClick={() => handleAddRow(idx)} disabled={busy}
                        className="p-1.5 rounded-sm text-blue-700 hover:bg-blue-50" title="Add child row"
                        data-testid={`srn-add-${idx}`}>
                        <Plus size={14} weight="bold" />
                      </button>
                    )}
                  </td>
                </tr>
              );

              // Saved child rows with running short qty chain
              let runningShort = parseFloat(item.short_qty) || 0;
              (item.children || []).forEach((c, ci) => {
                const childShort = runningShort;
                const childRcv = parseFloat(c.received_qty) || 0;
                const childNR = parseFloat(c.not_receivable_qty) || 0;
                const childPending = Math.max(0, childShort - childRcv - childNR);
                runningShort = childPending;
                const isEdit = editingChild && editingChild.child_srn_no === c.child_srn_no;
                const isDraftRow = c.finalized === false;

                rows.push(
                  <tr key={`saved-${idx}-${ci}`} className={isDraftRow ? "bg-yellow-50/60" : "bg-green-50/40"}
                    data-testid={`srn-saved-${idx}-${ci}`}>
                    <td className="font-mono text-slate-400 text-[10px] pl-4">{idx + 1}.{ci + 1}</td>
                    <td colSpan={3} className="text-xs text-slate-500 pl-4">
                      <span className="text-slate-300">└ </span>
                      <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-sm ${isDraftRow ? "bg-yellow-100 text-yellow-800" : "bg-green-100 text-green-800"}`}>
                        {isDraftRow ? "Draft" : "Final"}
                      </span>
                    </td>
                    <td className="text-right font-mono text-slate-500 text-xs">{childShort.toFixed(2)}</td>
                    <td className="text-right">
                      {isEdit ? (
                        <Input type="number" min="0" step="any" value={editingChild.received_qty}
                          onChange={e => setEditingChild({...editingChild, received_qty: e.target.value})}
                          className="rounded-sm font-mono h-7 text-right w-28" />
                      ) : <span className="font-mono font-semibold text-green-800">{childRcv.toFixed(2)}</span>}
                    </td>
                    <td className="text-right">
                      {isEdit ? (
                        <Input type="number" min="0" step="any" value={editingChild.not_receivable_qty}
                          onChange={e => setEditingChild({...editingChild, not_receivable_qty: e.target.value})}
                          className="rounded-sm font-mono h-7 text-right w-28" />
                      ) : <span className="font-mono text-slate-600">{childNR.toFixed(2)}</span>}
                    </td>
                    <td className={`text-right font-mono text-xs ${childPending > 0.0001 ? "text-amber-600" : "text-green-600"}`}>{childPending.toFixed(2)}</td>
                    <td className="font-mono text-[11px] text-blue-700">{c.child_srn_no}</td>
                    <td className="text-center">
                      {isEdit ? (
                        <div className="flex gap-1 justify-center">
                          <button onClick={saveEditedChild} disabled={busy}
                            className="p-1.5 text-green-700 hover:bg-green-50 rounded-sm" title="Save edit">
                            <FloppyDisk size={13} weight="bold" />
                          </button>
                          <button onClick={() => setEditingChild(null)} disabled={busy}
                            className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-sm" title="Cancel">
                            <X size={13} weight="bold" />
                          </button>
                        </div>
                      ) : isDraftRow ? (
                        <div className="flex gap-1 justify-center">
                          <button onClick={() => setEditingChild({
                            itemIdx: idx, child_srn_no: c.child_srn_no,
                            received_qty: c.received_qty, not_receivable_qty: c.not_receivable_qty,
                          })} disabled={busy}
                            className="p-1.5 text-blue-700 hover:bg-blue-50 rounded-sm" title="Edit"
                            data-testid={`srn-row-edit-${idx}-${ci}`}>
                            <PencilSimple size={13} weight="bold" />
                          </button>
                          <button onClick={() => deleteChild(c.child_srn_no)} disabled={busy}
                            className="p-1.5 text-red-700 hover:bg-red-50 rounded-sm" title="Delete"
                            data-testid={`srn-row-del-${idx}-${ci}`}>
                            <Trash size={13} weight="bold" />
                          </button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              });

              // Pending (unsaved) new child rows
              (pendingChildren[idx] || []).forEach((row, ri) => {
                const pendingRcv = parseFloat(row.received_qty) || 0;
                const pendingNR = parseFloat(row.not_receivable_qty) || 0;
                const pendingQty = Math.max(0, row.shortQty - pendingRcv - pendingNR);
                rows.push(
                  <tr key={`pend-${idx}-${ri}`} className="bg-blue-50/60" data-testid={`srn-pending-${idx}-${ri}`}>
                    <td className="font-mono text-blue-500 text-[10px] pl-4">{idx + 1}.{(item.children || []).length + ri + 1}</td>
                    <td colSpan={3} className="text-xs text-blue-600 pl-4 italic">
                      <span className="text-slate-300">└ </span>
                      <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-sm bg-blue-100 text-blue-800">New</span>
                    </td>
                    <td className="text-right font-mono text-slate-500 text-xs">{row.shortQty.toFixed(2)}</td>
                    <td className="text-right">
                      <Input type="number" min="0" step="any" max={row.shortQty}
                        value={row.received_qty}
                        onChange={e => updatePendingRow(idx, ri, "received_qty", e.target.value)}
                        placeholder="0"
                        className="rounded-sm font-mono h-8 text-right w-28"
                        data-testid={`srn-pend-rcv-${idx}-${ri}`} />
                    </td>
                    <td className="text-right">
                      <Input type="number" min="0" step="any" max={row.shortQty}
                        value={row.not_receivable_qty}
                        onChange={e => updatePendingRow(idx, ri, "not_receivable_qty", e.target.value)}
                        placeholder="0"
                        className="rounded-sm font-mono h-8 text-right w-28"
                        data-testid={`srn-pend-nrcv-${idx}-${ri}`} />
                    </td>
                    <td className={`text-right font-mono text-xs ${pendingQty > 0.0001 ? "text-amber-600" : "text-green-600"}`}>{pendingQty.toFixed(2)}</td>
                    <td className="font-mono text-[11px] text-blue-700">{row.childNo}</td>
                    <td className="text-center">
                      <div className="flex gap-1 justify-center">
                        <button onClick={() => handleAddRow(idx)} disabled={busy || pendingQty <= 0}
                          className={`p-1.5 rounded-sm ${pendingQty > 0 ? "text-blue-700 hover:bg-blue-100" : "text-slate-300 cursor-not-allowed"}`}
                          title="Add another row">
                          <Plus size={13} weight="bold" />
                        </button>
                        <button onClick={() => removePendingRow(idx, ri)} disabled={busy}
                          className="p-1.5 text-red-700 hover:bg-red-50 rounded-sm" title="Remove">
                          <Trash size={13} weight="bold" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              });

              return rows;
            })}
          </tbody>
        </table>
      </div>

      {/* NARRATION + SAVE BUTTONS */}
      <div className="bg-white border border-slate-200 rounded-sm">
        <div className="flex items-start justify-between gap-4 p-4">
          <div className="flex-1 max-w-sm">
            <label className="label-sm block mb-1.5">NARRATION</label>
            <textarea
              value={narration}
              onChange={e => setNarration(e.target.value)}
              placeholder="Optional narration…"
              rows={2}
              className="w-full rounded-sm border border-slate-300 bg-white px-3 py-1.5 text-sm font-mono resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
              data-testid="srn-narration"
            />
          </div>
          <div className="flex items-center gap-2 pt-7">
            <Button onClick={() => saveAll(true)} disabled={busy || !canSave}
              variant="outline"
              className="rounded-sm border-blue-700 text-blue-700 hover:bg-blue-50 disabled:border-slate-300 disabled:text-slate-400"
              data-testid="srn-save-draft">
              <FloppyDisk size={14} weight="bold" className="mr-2" />
              {busy ? "Saving…" : "SAVE AS DRAFT"}
            </Button>
            <Button onClick={() => saveAll(false)} disabled={busy || !canSave}
              className="rounded-sm bg-blue-700 hover:bg-blue-800 disabled:bg-slate-300 disabled:cursor-not-allowed"
              data-testid="srn-save-final">
              <CheckCircle size={14} weight="bold" className="mr-2" />
              {busy ? "Saving…" : "SAVE FINAL"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
/** ERN entry/edit form — mirror of SrnFinalizeForm with ERN-specific columns. */
function ErnFinalizeForm({ ern: initialErn, onCancel, onSaved, onOpenRn }) {
  const [parent, setParent] = useState(initialErn);
  const [pendingChildren, setPendingChildren] = useState({});
  const [editingChild, setEditingChild] = useState(null);
  const [narration, setNarration] = useState(initialErn.narration || "");
  const [busy, setBusy] = useState(false);
  const { user: me } = useAuth();

  const reload = async () => {
    try {
      const { data } = await api.get(`/extra-received-notes/${parent.id}`);
      setParent(data);
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not reload");
    }
  };

  const effectivePending = (item, idx) => {
    const savedUsed = (item.children || []).reduce(
      (s, c) => s + (parseFloat(c.accepted_qty) || 0) + (parseFloat(c.rejected_qty) || 0), 0
    );
    const pendingUsed = (pendingChildren[idx] || []).reduce(
      (s, p) => s + (parseFloat(p.accepted_qty) || 0) + (parseFloat(p.rejected_qty) || 0), 0
    );
    return Math.max(0, (parseFloat(item.extra_qty) || 0) - savedUsed - pendingUsed);
  };

  const summaryAcc = (item, idx) =>
    (item.children || []).reduce((s, c) => s + (parseFloat(c.accepted_qty) || 0), 0) +
    (pendingChildren[idx] || []).reduce((s, p) => s + (parseFloat(p.accepted_qty) || 0), 0);
  const summaryRej = (item, idx) =>
    (item.children || []).reduce((s, c) => s + (parseFloat(c.rejected_qty) || 0), 0) +
    (pendingChildren[idx] || []).reduce((s, p) => s + (parseFloat(p.rejected_qty) || 0), 0);

  const computeNextChildNo = (item, idx) => {
    const usedLetters = new Set([
      ...(item.children || []).map(c => { const p = (c.child_ern_no || "").split("-"); return p[p.length - 1]; }),
      ...(pendingChildren[idx] || []).map(p => { const parts = (p.childNo || "").split("-"); return parts[parts.length - 1]; }),
    ]);
    for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      if (!usedLetters.has(ch)) return `${parent.ern_no}-${ch}`;
    }
    return null;
  };

  const handleAddRow = (itemIdx) => {
    const item = parent.items[itemIdx];
    const childNo = computeNextChildNo(item, itemIdx);
    if (!childNo) { toast.error("Maximum child rows reached (26)"); return; }
    const extraQty = effectivePending(item, itemIdx);
    if (extraQty <= 0) { toast.error("No pending quantity remaining"); return; }
    setPendingChildren(prev => ({
      ...prev,
      [itemIdx]: [...(prev[itemIdx] || []), {
        localId: Math.random().toString(36).slice(2),
        childNo, extraQty, accepted_qty: "", rejected_qty: "",
      }],
    }));
  };

  const updatePendingRow = (itemIdx, rowIdx, field, value) => {
    setPendingChildren(prev => {
      const rows = [...(prev[itemIdx] || [])];
      rows[rowIdx] = { ...rows[rowIdx], [field]: value };
      return { ...prev, [itemIdx]: rows };
    });
  };

  const removePendingRow = (itemIdx, rowIdx) => {
    setPendingChildren(prev => {
      const rows = [...(prev[itemIdx] || [])];
      rows.splice(rowIdx, 1);
      if (rows.length === 0) { const n = { ...prev }; delete n[itemIdx]; return n; }
      return { ...prev, [itemIdx]: rows };
    });
  };

  const saveAll = async (isDraft) => {
    for (const [idx, rows] of Object.entries(pendingChildren)) {
      for (const r of rows) {
        const acc = parseFloat(r.accepted_qty) || 0;
        const rej = parseFloat(r.rejected_qty) || 0;
        if (!acc && !rej) { toast.error(`Row ${r.childNo}: enter at least one quantity`); return; }
        if (acc + rej > r.extraQty + 1e-6) { toast.error(`Row ${r.childNo}: sum exceeds pending qty (${r.extraQty.toFixed(2)})`); return; }
      }
    }
    const hasPending = Object.values(pendingChildren).some(rows => rows.length > 0);
    const hasNarrationChange = narration !== (parent.narration || "");
    if (!hasPending && !hasNarrationChange) { toast.error("Nothing to save"); return; }
    setBusy(true);
    try {
      for (const [idx, rows] of Object.entries(pendingChildren)) {
        const item = parent.items[+idx];
        for (const r of rows) {
          const res = await api.post(`/extra-received-notes/${parent.id}/children`, {
            part_no: item.part_no, make: item.make,
            accepted_qty: parseFloat(r.accepted_qty) || 0,
            rejected_qty: parseFloat(r.rejected_qty) || 0,
            is_draft: isDraft,
          });
          if (!isDraft) {
            const autoRkn = res.headers?.["x-auto-rkn-no"];
            if (autoRkn) toast.success(`${r.childNo} saved — ${autoRkn} auto-created for racking`);
          }
        }
      }
      if (hasNarrationChange) {
        await api.patch(`/extra-received-notes/${parent.id}/narration`, { narration: narration.trim() });
      }
      setPendingChildren({});
      const { data } = await api.get(`/extra-received-notes/${parent.id}`);
      setParent(data);
      toast.success(isDraft
        ? "Saved as draft — rows are editable, no racking note created"
        : "Saved final — rows are locked, racking note auto-created");
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save");
    } finally { setBusy(false); }
  };

  const saveEditedChild = async () => {
    if (!editingChild) return;
    const { itemIdx, child_ern_no, accepted_qty, rejected_qty } = editingChild;
    const item = parent.items[itemIdx];
    const acc = parseFloat(accepted_qty) || 0;
    const rej = parseFloat(rejected_qty) || 0;
    if (!acc && !rej) { toast.error("Enter at least one quantity"); return; }
    setBusy(true);
    try {
      const res = await api.put(
        `/extra-received-notes/${parent.id}/children/${encodeURIComponent(child_ern_no)}`,
        { part_no: item.part_no, make: item.make, accepted_qty: acc, rejected_qty: rej, is_draft: false },
      );
      const autoRkn = res.headers?.["x-auto-rkn-no"];
      if (autoRkn) toast.success(`Row updated — ${autoRkn} auto-created for racking`);
      else toast.success("Row updated");
      setEditingChild(null);
      await reload();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not update");
    } finally { setBusy(false); }
  };

  const deleteChild = async (childNo) => {
    if (!window.confirm("Delete this row?")) return;
    setBusy(true);
    try {
      await api.delete(`/extra-received-notes/${parent.id}/children/${encodeURIComponent(childNo)}`);
      toast.success("Row deleted");
      await reload();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not delete");
    } finally { setBusy(false); }
  };

  const hasPendingRows = Object.values(pendingChildren).some(rows => rows.length > 0);
  const hasNarrationChange = narration !== (parent.narration || "");
  const canSave = hasPendingRows || hasNarrationChange;
  const meta = statusMeta(parent.status);

  return (
    <div className="mt-4 space-y-6" data-testid="ern-finalize-view">
      {/* TOP BAR */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="ern-back">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
        <Button onClick={() => printErn(parent, me)} variant="outline" className="rounded-sm border-slate-300">
          <Printer size={14} weight="bold" className="mr-2" /> Print
        </Button>
      </div>

      {/* HEADER SECTION */}
      <div className="bg-white border border-slate-200 rounded-sm p-6 space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
          <Detail k="RECEIPT NOTE DATE" v={fmtDate(parent.parent_rn_date)} />
          <div>
            <div className="label-sm">RECEIPT NOTE NO</div>
            <button onClick={() => onOpenRn?.(parent.parent_rn_id)}
              className="font-mono mt-1 text-blue-700 hover:underline text-sm" data-testid="ern-open-rn">
              {parent.parent_rn_no || "—"}
            </button>
          </div>
          <Detail k="ERN DATE" v={fmtDate(parent.ern_date)} />
          <Detail k="ERN NO" v={parent.ern_no} />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 pt-3 border-t border-slate-100">
          <Detail k="ASSIGNED TO" v={parent.assigned_to_name || parent.assigned_to_email || "—"} />
          <div>
            <div className="label-sm">STATUS</div>
            <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm mt-1 inline-block ${meta.cls}`}>
              {meta.label}
            </span>
          </div>
        </div>
      </div>

      {/* ITEMS TABLE */}
      <div className="bg-white border border-slate-200 rounded-sm overflow-hidden">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-10">SL NO</th>
              <th className="w-36">PART NO</th>
              <th>DESCRIPTION 1</th>
              <th className="w-28">MAKE</th>
              <th className="w-24 text-right">EXTRA QTY</th>
              <th className="w-28 text-right">ACCEPTED QTY</th>
              <th className="w-24 text-right">REJECTED QTY</th>
              <th className="w-24 text-right">PENDING QTY</th>
              <th className="w-36">CHILD ERN NO</th>
              <th className="w-20 text-center">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {(parent.items || []).flatMap((item, idx) => {
              const rows = [];
              const sPending = effectivePending(item, idx);
              const sAcc = summaryAcc(item, idx);
              const sRej = summaryRej(item, idx);

              // Summary Row (read-only)
              rows.push(
                <tr key={`sum-${idx}`} className="bg-slate-50 font-semibold">
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td><PartNoLink partNo={item.part_no} make={item.make} /></td>
                  <td className="text-xs text-slate-700 truncate max-w-[200px]" title={item.description_1}>{item.description_1 || "—"}</td>
                  <td className="text-xs text-slate-700">{item.make}</td>
                  <td className="text-right font-mono text-amber-700">{(parseFloat(item.extra_qty) || 0).toFixed(2)}</td>
                  <td className="text-right font-mono text-green-700">{sAcc.toFixed(2)}</td>
                  <td className="text-right font-mono text-red-700">{sRej.toFixed(2)}</td>
                  <td className={`text-right font-mono ${sPending > 0.0001 ? "text-amber-700" : "text-green-700"}`}>{sPending.toFixed(2)}</td>
                  <td className="text-slate-400 font-mono text-xs">—</td>
                  <td className="text-center">
                    {sPending > 1e-6 && (
                      <button onClick={() => handleAddRow(idx)} disabled={busy}
                        className="p-1.5 rounded-sm text-blue-700 hover:bg-blue-50" title="Add child row"
                        data-testid={`ern-add-${idx}`}>
                        <Plus size={14} weight="bold" />
                      </button>
                    )}
                  </td>
                </tr>
              );

              // Saved child rows with running extra qty chain
              let runningExtra = parseFloat(item.extra_qty) || 0;
              (item.children || []).forEach((c, ci) => {
                const childExtra = runningExtra;
                const childAcc = parseFloat(c.accepted_qty) || 0;
                const childRej = parseFloat(c.rejected_qty) || 0;
                const childPending = Math.max(0, childExtra - childAcc - childRej);
                runningExtra = childPending;
                const isEdit = editingChild && editingChild.child_ern_no === c.child_ern_no;
                const isDraftRow = c.finalized === false;

                rows.push(
                  <tr key={`saved-${idx}-${ci}`} className={isDraftRow ? "bg-yellow-50/60" : "bg-green-50/40"}
                    data-testid={`ern-saved-${idx}-${ci}`}>
                    <td className="font-mono text-slate-400 text-[10px] pl-4">{idx + 1}.{ci + 1}</td>
                    <td colSpan={3} className="text-xs text-slate-500 pl-4">
                      <span className="text-slate-300">└ </span>
                      <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-sm ${isDraftRow ? "bg-yellow-100 text-yellow-800" : "bg-green-100 text-green-800"}`}>
                        {isDraftRow ? "Draft" : "Final"}
                      </span>
                    </td>
                    <td className="text-right font-mono text-slate-500 text-xs">{childExtra.toFixed(2)}</td>
                    <td className="text-right">
                      {isEdit ? (
                        <Input type="number" min="0" step="any" value={editingChild.accepted_qty}
                          onChange={e => setEditingChild({...editingChild, accepted_qty: e.target.value})}
                          className="rounded-sm font-mono h-7 text-right w-28" />
                      ) : <span className="font-mono font-semibold text-green-800">{childAcc.toFixed(2)}</span>}
                    </td>
                    <td className="text-right">
                      {isEdit ? (
                        <Input type="number" min="0" step="any" value={editingChild.rejected_qty}
                          onChange={e => setEditingChild({...editingChild, rejected_qty: e.target.value})}
                          className="rounded-sm font-mono h-7 text-right w-28" />
                      ) : <span className="font-mono text-red-700">{childRej.toFixed(2)}</span>}
                    </td>
                    <td className={`text-right font-mono text-xs ${childPending > 0.0001 ? "text-amber-600" : "text-green-600"}`}>{childPending.toFixed(2)}</td>
                    <td className="font-mono text-[11px] text-blue-700">{c.child_ern_no}</td>
                    <td className="text-center">
                      {isEdit ? (
                        <div className="flex gap-1 justify-center">
                          <button onClick={saveEditedChild} disabled={busy}
                            className="p-1.5 text-green-700 hover:bg-green-50 rounded-sm" title="Save edit">
                            <FloppyDisk size={13} weight="bold" />
                          </button>
                          <button onClick={() => setEditingChild(null)} disabled={busy}
                            className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-sm" title="Cancel">
                            <X size={13} weight="bold" />
                          </button>
                        </div>
                      ) : isDraftRow ? (
                        <div className="flex gap-1 justify-center">
                          <button onClick={() => setEditingChild({
                            itemIdx: idx, child_ern_no: c.child_ern_no,
                            accepted_qty: c.accepted_qty, rejected_qty: c.rejected_qty,
                          })} disabled={busy}
                            className="p-1.5 text-blue-700 hover:bg-blue-50 rounded-sm" title="Edit"
                            data-testid={`ern-row-edit-${idx}-${ci}`}>
                            <PencilSimple size={13} weight="bold" />
                          </button>
                          <button onClick={() => deleteChild(c.child_ern_no)} disabled={busy}
                            className="p-1.5 text-red-700 hover:bg-red-50 rounded-sm" title="Delete"
                            data-testid={`ern-row-del-${idx}-${ci}`}>
                            <Trash size={13} weight="bold" />
                          </button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              });

              // Pending (unsaved) new child rows
              (pendingChildren[idx] || []).forEach((row, ri) => {
                const pendingAcc = parseFloat(row.accepted_qty) || 0;
                const pendingRej = parseFloat(row.rejected_qty) || 0;
                const pendingQty = Math.max(0, row.extraQty - pendingAcc - pendingRej);
                rows.push(
                  <tr key={`pend-${idx}-${ri}`} className="bg-blue-50/60" data-testid={`ern-pending-${idx}-${ri}`}>
                    <td className="font-mono text-blue-500 text-[10px] pl-4">{idx + 1}.{(item.children || []).length + ri + 1}</td>
                    <td colSpan={3} className="text-xs text-blue-600 pl-4 italic">
                      <span className="text-slate-300">└ </span>
                      <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-sm bg-blue-100 text-blue-800">New</span>
                    </td>
                    <td className="text-right font-mono text-slate-500 text-xs">{row.extraQty.toFixed(2)}</td>
                    <td className="text-right">
                      <Input type="number" min="0" step="any" max={row.extraQty}
                        value={row.accepted_qty}
                        onChange={e => updatePendingRow(idx, ri, "accepted_qty", e.target.value)}
                        placeholder="0"
                        className="rounded-sm font-mono h-8 text-right w-28"
                        data-testid={`ern-pend-acc-${idx}-${ri}`} />
                    </td>
                    <td className="text-right">
                      <Input type="number" min="0" step="any" max={row.extraQty}
                        value={row.rejected_qty}
                        onChange={e => updatePendingRow(idx, ri, "rejected_qty", e.target.value)}
                        placeholder="0"
                        className="rounded-sm font-mono h-8 text-right w-28"
                        data-testid={`ern-pend-rej-${idx}-${ri}`} />
                    </td>
                    <td className={`text-right font-mono text-xs ${pendingQty > 0.0001 ? "text-amber-600" : "text-green-600"}`}>{pendingQty.toFixed(2)}</td>
                    <td className="font-mono text-[11px] text-blue-700">{row.childNo}</td>
                    <td className="text-center">
                      <div className="flex gap-1 justify-center">
                        <button onClick={() => handleAddRow(idx)} disabled={busy || pendingQty <= 0}
                          className={`p-1.5 rounded-sm ${pendingQty > 0 ? "text-blue-700 hover:bg-blue-100" : "text-slate-300 cursor-not-allowed"}`}
                          title="Add another row">
                          <Plus size={13} weight="bold" />
                        </button>
                        <button onClick={() => removePendingRow(idx, ri)} disabled={busy}
                          className="p-1.5 text-red-700 hover:bg-red-50 rounded-sm" title="Remove">
                          <Trash size={13} weight="bold" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              });

              return rows;
            })}
          </tbody>
        </table>
      </div>

      {/* NARRATION + SAVE BUTTONS */}
      <div className="bg-white border border-slate-200 rounded-sm">
        <div className="flex items-start justify-between gap-4 p-4">
          <div className="flex-1 max-w-sm">
            <label className="label-sm block mb-1.5">NARRATION</label>
            <textarea
              value={narration}
              onChange={e => setNarration(e.target.value)}
              placeholder="Optional narration…"
              rows={2}
              className="w-full rounded-sm border border-slate-300 bg-white px-3 py-1.5 text-sm font-mono resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
              data-testid="ern-narration"
            />
          </div>
          <div className="flex items-center gap-2 pt-7">
            <Button onClick={() => saveAll(true)} disabled={busy || !canSave}
              variant="outline"
              className="rounded-sm border-blue-700 text-blue-700 hover:bg-blue-50 disabled:border-slate-300 disabled:text-slate-400"
              data-testid="ern-save-draft">
              <FloppyDisk size={14} weight="bold" className="mr-2" />
              {busy ? "Saving…" : "SAVE AS DRAFT"}
            </Button>
            <Button onClick={() => saveAll(false)} disabled={busy || !canSave}
              className="rounded-sm bg-blue-700 hover:bg-blue-800 disabled:bg-slate-300 disabled:cursor-not-allowed"
              data-testid="ern-save-final">
              <CheckCircle size={14} weight="bold" className="mr-2" />
              {busy ? "Saving…" : "SAVE FINAL"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
