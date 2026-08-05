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
  Receipt, Package as PackageIcon, MagnifyingGlass, CircleNotch,
} from "@phosphor-icons/react";
import RackingNoteTab from "./RackingNoteTab";
import AssigneeSelect, { AssigneeBadge } from "../components/AssigneeSelect";
import PartNoLink from "../components/PartNoLink";
import DocumentDetailDialog, { isChildEditable, isRknEditable } from "../components/DocumentDetailDialog";
import { useAuth } from "../lib/auth";
import { StockInNavContext, useStockInNav } from "../lib/stockInNav";
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

/** Numeric helper — empty/blank -> null, else float (quantities may be fractional, e.g. KG/LTR). */
function toNum(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

/** Format a quantity for display — whole numbers show no decimals, fractional
 * quantities (KG/LTR/etc.) keep up to 3 decimal places without trailing zeros. */
function fmtQty(n) {
  const v = parseFloat(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
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
function sumRknQty(rkn)           { return (rkn.items||[]).reduce((s,it) => s + (+it.quantity||0), 0); }

/** True once a Store Manager has decided an ERN — approved, partly approved, or rejected. */
function isErnDecided(ern) {
  return ["APPROVED", "REJECTED", "COMPLETE"].includes((ern?.status || "").toUpperCase());
}
/** Approved / rejected slice of an ERN row.
 *  Notes decided before the per-row split existed carry no approved_qty, so they
 *  fall back to the whole-note meaning the status implies: everything approved on
 *  an APPROVED/COMPLETE note, everything rejected on a REJECTED one. */
function ernApprovedQty(it, status) {
  if (it?.approved_qty != null) return +it.approved_qty || 0;
  return (status || "").toUpperCase() === "REJECTED" ? 0 : (+it?.extra_qty || 0);
}
function ernRejectedQty(it, status) {
  if (it?.rejected_qty != null) return +it.rejected_qty || 0;
  return Math.max(0, (+it?.extra_qty || 0) - ernApprovedQty(it, status));
}
function sumErnApproved(ern) {
  return (ern.items||[]).reduce((s,it) => s + ernApprovedQty(it, ern.status), 0);
}
function sumErnRejected(ern) {
  return (ern.items||[]).reduce((s,it) => s + ernRejectedQty(it, ern.status), 0);
}

/** Status pill metadata used in list view AND detail dialog. */
export function stockInTypeMeta(type) {
  const t = (type || "INVOICE").toUpperCase();
  if (t === "GENERAL") return { label: "General", cls: "bg-indigo-50 text-indigo-800 border border-indigo-200" };
  return { label: "Invoice", cls: "bg-blue-50 text-blue-800 border border-blue-200" };
}
export function stockInTypeLabel(type) { return stockInTypeMeta(type).label; }


// Status metadata. The backend emits exactly 12 active values across all 4
// note types — anything else falls through to the default chip. Every value
// is displayed under one of three standard labels:
//   Pending     — the document is created but the racking workflow hasn't started.
//   In Process  — material has entered the workflow but racking isn't fully complete yet
//                 (partial racking, pending SRN/ERN quantity, undecided ERN lines, etc).
//   Complete    — the entire receipt workflow for this document has finished.
// This is purely a display mapping — the underlying raw status values (and the
// business logic that computes them) are unchanged.
//   Receipt Note:  DRAFT (pre-finalize only), PENDING, IN_PROCESS, COMPLETE
//   SRN:           PENDING, PARTIALLY_RECEIVED, COMPLETE
//   ERN:           PENDING, PARTIALLY_ACCEPTED, COMPLETE
//   Racking Note:  DRAFT, RECORDED
// RACKING_NOTE_DRAFT/PARTIALLY_RACKED/FULLY_RACKED are legacy RN values (pre
// status-collapse); kept here defensively in case a stale client cache still
// holds one before a refresh picks up the server-side migration.
function statusMeta(status) {
  switch (status) {
    case "DRAFT":
      return { label: "Pending", cls: "bg-amber-50 text-amber-700" };
    case "PENDING":
      return { label: "Pending", cls: "bg-amber-50 text-amber-700" };
    case "RACKING_NOTE_DRAFT":
      return { label: "Pending", cls: "bg-amber-50 text-amber-700" };
    case "IN_PROCESS":
      return { label: "In Process", cls: "bg-blue-50 text-blue-800" };
    case "PARTIALLY_RACKED":
      return { label: "In Process", cls: "bg-blue-50 text-blue-800" };
    case "PARTIALLY_RECEIVED":
      return { label: "In Process", cls: "bg-blue-50 text-blue-800" };
    case "PARTIALLY_ACCEPTED":
      return { label: "In Process", cls: "bg-blue-50 text-blue-800" };
    case "PENDING_APPROVAL":
      return { label: "Pending Approval", cls: "bg-amber-50 text-amber-700" };
    case "APPROVED":
      return { label: "Approved", cls: "bg-blue-50 text-blue-800" };
    case "REJECTED":
      return { label: "Rejected", cls: "bg-red-50 text-red-700" };
    case "COMPLETE":
      return { label: "Complete", cls: "bg-green-100 text-green-800" };
    case "FULLY_RACKED":
      return { label: "Complete", cls: "bg-green-100 text-green-800" };
    case "RECORDED":
      return { label: "Complete", cls: "bg-green-100 text-green-800" };
    default:
      return { label: status || "—", cls: "bg-slate-100 text-slate-700" };
  }
}

const TAB_FOR_DOC_TYPE = {
  rn: "receipt-note",
  srn: "short-received-note",
  ern: "extra-received-note",
  rkn: "racking-note",
};

export default function StockInPage() {
  const [tab, setTab] = useState("receipt-note");
  // { type: "rn"|"srn"|"ern"|"rkn", doc, token } — a pending request (from a
  // nested preview's Linked Docs bar) to open a document's edit form.
  const [editRequest, setEditRequest] = useState(null);

  const requestEdit = useCallback((type, doc) => {
    setTab(TAB_FOR_DOC_TYPE[type] || "receipt-note");
    setEditRequest({ type, doc, token: `${Date.now()}-${Math.random()}` });
  }, []);
  const clearEditRequest = useCallback(() => setEditRequest(null), []);
  const navValue = useMemo(() => ({ editRequest, requestEdit, clearEditRequest }), [editRequest, requestEdit, clearEditRequest]);

  return (
    <StockInNavContext.Provider value={navValue}>
      <div className="p-8 max-w-[1600px] mx-auto" data-testid="stock-in-page">
        <div className="mb-6">
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
    </StockInNavContext.Provider>
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
  const nav = useStockInNav();

  const goCreate = () => { setEditingRn(null); setView("create"); };
  const goEdit = (rn) => { setEditingRn(rn); setView("edit"); };
  const goList = () => { setEditingRn(null); setView("list"); setReloadKey((k) => k + 1); };

  useEffect(() => {
    if (nav?.editRequest?.type === "rn") {
      setOpenRn(null);
      goEdit(nav.editRequest.doc);
      nav.clearEditRequest();
    }
  }, [nav?.editRequest?.token]); // eslint-disable-line react-hooks/exhaustive-deps

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
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not load receipt notes");
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
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input
            ref={searchInputRef}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search receipt notes…"
            className="rounded-sm font-mono h-9 pl-10 w-full"
            data-testid="rn-search-input"
          />
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

      <div className="flex items-center justify-between mb-3 text-xs text-slate-600">
        <div>
          {total === 0 ? "No receipt notes" : (
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

      <div className="bg-white border border-slate-200 rounded-sm overflow-auto" style={{ maxHeight: "70vh" }}>
        <table className="data-table w-full">
          <thead className="sticky top-0 z-10 bg-slate-50">
            <tr>
              <th className="w-16 whitespace-nowrap">SL NO</th>
              {columns.map((c) => (
                <th key={c.key} className={c.isQty ? "text-center" : ""}>
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
              // Locked only once stock has genuinely moved — has_racking_note reflects a
              // RECORDED racking note, not merely a DRAFT allocation (see assert_rn_mutable).
              const hasRacking = r.has_racking_note === true;
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
  const nav = useStockInNav();
  const { user: me, isAdmin } = useAuth();

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
  }, [rn, reloadTick]);

  const srnTree = useMemo(() => {
    const parents = srns.filter(s => !s.parent_srn_id);
    return parents.map(p => ({ parent: p, children: srns.filter(c => c.parent_srn_id === p.id) }));
  }, [srns]);

  const ernTree = useMemo(() => {
    const parents = erns.filter(e => !e.parent_ern_id);
    return parents.map(p => ({ parent: p, children: erns.filter(c => c.parent_ern_id === p.id) }));
  }, [erns]);

  const handlePrint = () => printReceiptNote(rn, srns, erns, rkns, masterData, srnTree, ernTree);

  // Navigate between the nested SRN/ERN/RKN preview dialogs (and back to this RN).
  const navigateTo = (type, doc) => {
    setOpenSrn(null); setOpenErn(null); setOpenRkn(null);
    if (type === "srn") setOpenSrn(doc);
    else if (type === "ern") setOpenErn(doc);
    else if (type === "rkn") setOpenRkn({ kind: "racking", id: doc.id, no: doc.rkn_no });
    // type === "rn" needs no action — closing the nested dialogs reveals this RN dialog.
  };
  const related = { rn, srns, erns, rkns };

  // Clicking an SRN/ERN/RKN id in the 3-column section below opens its EDIT
  // form directly (switching tabs); a locked/finalized doc falls back to the
  // read-only preview since there's nothing to edit.
  const goToSrn = (srn) => {
    if (isChildEditable(srn) && nav?.requestEdit) nav.requestEdit("srn", srn);
    else setOpenSrn(srn);
  };
  const goToErn = (ern) => {
    if (isChildEditable(ern) && nav?.requestEdit) nav.requestEdit("ern", ern);
    else setOpenErn(ern);
  };
  const goToRkn = (rkn) => {
    if (isRknEditable(rkn, me, isAdmin) && nav?.requestEdit) nav.requestEdit("rkn", rkn);
    else setOpenRkn({ kind: "racking", id: rkn.id, no: rkn.rkn_no });
  };

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
                <Detail k="CREATED AT" v={rn.created_at ? new Date(rn.created_at).toLocaleString() : "—"} />
                <div>
                  <div className="label-sm">ASSIGNED TO</div>
                  <div className="mt-1"><AssigneeBadge name={rn.assigned_to_name} email={rn.assigned_to_email} /></div>
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
                      <th className="w-16 whitespace-nowrap">SL NO</th>
                      <th>MODEL</th>
                      <th>PART NO</th>
                      <th>DESCRIPTION 1</th>
                      <th>MAKE</th>
                      <th className="text-center">INVOICE QTY</th>
                      <th className="text-center">RECEIVED QTY</th>
                      <th className="text-center">DIFFERENCE QTY</th>
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
                          <td className="text-center font-mono">{toNum(it.invoice_qty) ?? "—"}</td>
                          <td className="text-center font-mono">{toNum(it.received_qty) ?? "—"}</td>
                          <td className={`text-center font-mono font-bold ${diffCls}`}>
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
                          <button onClick={() => goToSrn(parent)}
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
                              <button onClick={() => goToSrn(child)}
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
                    const em     = statusMeta(parent.status);
                    const pDecided = isErnDecided(parent);
                    return (
                      <div key={parent.id} className="mb-3">
                        <div className="rounded border border-slate-200 p-2 text-xs bg-slate-50">
                          <button onClick={() => goToErn(parent)}
                            className="font-mono font-bold text-blue-700 hover:underline text-[11px]">
                            {parent.ern_no}
                          </button>
                          <div className="mt-1 space-y-0.5 text-slate-600">
                            <div><span className="font-semibold">Date:</span> {fmtDate(parent.ern_date)}</div>
                            <div><span className="font-semibold">Extra Qty:</span> {ernQty || "—"}</div>
                            {pDecided && (
                              <>
                                <div><span className="font-semibold">Approved Qty:</span> {sumErnApproved(parent).toFixed(2)}</div>
                                <div><span className="font-semibold">Rejected Qty:</span> {sumErnRejected(parent).toFixed(2)}</div>
                              </>
                            )}
                            <div><span className="font-semibold">Status:</span>{" "}
                              <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-sm ${em.cls}`}>{em.label}</span>
                            </div>
                            {parent.decided_by && (
                              <div><span className="font-semibold">Decided By:</span> {parent.decided_by}</div>
                            )}
                          </div>
                        </div>
                        {children.map(child => {
                          const cQty  = sumErnQty(child);
                          const cEm   = statusMeta(child.status);
                          const cDecided = isErnDecided(child);
                          return (
                            <div key={child.id} className="ml-3 mt-1 border-l-2 border-slate-300 pl-2 rounded-r border border-l-0 border-slate-200 p-1.5 text-xs bg-white">
                              <button onClick={() => goToErn(child)}
                                className="font-mono font-bold text-blue-600 hover:underline text-[11px]">
                                {child.ern_no}
                              </button>
                              <div className="mt-0.5 space-y-0.5 text-slate-600">
                                <div><span className="font-semibold">Date:</span> {fmtDate(child.ern_date)}</div>
                                <div><span className="font-semibold">Extra Qty:</span> {cQty || "—"}</div>
                                {cDecided && (
                                  <>
                                    <div><span className="font-semibold">Approved Qty:</span> {sumErnApproved(child).toFixed(2)}</div>
                                    <div><span className="font-semibold">Rejected Qty:</span> {sumErnRejected(child).toFixed(2)}</div>
                                  </>
                                )}
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
                        <button onClick={() => goToRkn(rkn)}
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
            <ChildDetailDialog kind="srn" doc={openSrn} onClose={() => setOpenSrn(null)} onOpen={() => {}} related={related} onNavigate={navigateTo} />
            <ChildDetailDialog kind="ern" doc={openErn} onClose={() => setOpenErn(null)} onOpen={() => {}} related={related} onNavigate={navigateTo} />
            <DocumentDetailDialog kind={openRkn?.kind} id={openRkn?.id} no={openRkn?.no} onClose={() => setOpenRkn(null)} related={related} onNavigate={navigateTo} />
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
    const decided = isErnDecided(ern);
    const appr = sumErnApproved(ern);
    const rej = sumErnRejected(ern);
    const indent = indented ? "margin-left:16px;border-left:3px solid #cbd5e1;padding-left:8px;" : "";
    return `<div class="note-card" style="${indent}">
      <div class="note-no">${escapeHtml(ern.ern_no)}</div>
      <div>Date: ${escapeHtml(fmtDate(ern.ern_date))}</div>
      <div>Extra Qty: ${ernQty || "—"}</div>
      ${decided ? `<div>Approved Qty: ${appr.toFixed(2)}</div>
      <div>Rejected Qty: ${rej.toFixed(2)}</div>` : ""}
      <div>Status: ${escapeHtml(statusMeta(ern.status).label)}</div>
      ${ern.decided_by ? `<div>Decided By: ${escapeHtml(ern.decided_by)}</div>` : ""}
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
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 32px; color: #020617; }
  h1 { font-size: 22px; font-weight: 900; margin: 0 0 4px; text-align: center; letter-spacing: 0.12em; text-transform: uppercase; color: #000000; }
  .type-pill { display: inline-block; padding: 3px 8px; border-radius: 3px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; background: #e0e7ff; color: #3730a3; }
  .status-pill { display: inline-block; padding: 3px 8px; border-radius: 3px; font-size: 10px; font-weight: 700; text-transform: uppercase; background: #f1f5f9; color: #334155; }
  .header-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 16px 0; padding: 14px; border: 1px solid #e2e8f0; border-radius: 4px; }
  .field-label { font-size: 9px; color: #475569; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 800; }
  .field-value { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; margin-top: 2px; color: #0f172a; }
  .section-title { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #1e293b; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 11px; }
  th { text-align: left; padding: 6px 8px; background: #f1f5f9; border-bottom: 2px solid #cbd5e1; font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 800; color: #0f172a; }
  td { padding: 6px 8px; border-bottom: 1px solid #e2e8f0; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; color: #0f172a; }
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
      ${pField("Created At", rn.created_at ? new Date(rn.created_at).toLocaleString() : "—")}
      ${pField("Assigned To", rn.assigned_to_name || rn.assigned_to_email || "—")}
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
   Print view for SRN / ERN — standalone print window, styled to
   match the Receipt Note print layout/typography.
   -------------------------------------------------------------- */
function printChildDoc(doc, kind) {
  if (!doc) return;
  const isSrn = kind === "srn";
  const idField = isSrn ? "srn_no" : "ern_no";
  const dateField = isSrn ? "srn_date" : "ern_date";
  const meta = statusMeta(doc.status);
  const title = isSrn ? "Short Receipt Note" : "Extra Receipt Note";

  const pField = (label, value) =>
    `<div><div class="field-label">${escapeHtml(label)}</div><div class="field-value">${escapeHtml(String(value ?? "—"))}</div></div>`;

  const items = (doc.items || []).map((it, idx) => {
    const inv = fmtQty(it.invoice_qty);
    const rec = fmtQty(it.received_qty);
    if (isSrn) {
      const shortQ = parseFloat(it.short_qty) || 0;
      const childRcv = (it.children || []).reduce((s, c) => s + (parseFloat(c.received_qty) || 0), 0);
      const childNRcv = (it.children || []).reduce((s, c) => s + (parseFloat(c.not_receivable_qty) || 0), 0);
      const ful = (it.children || []).length > 0 ? childRcv : (it.fulfilled_qty == null ? null : (parseFloat(it.fulfilled_qty) || 0));
      const pending = ful == null ? shortQ : (shortQ - ful - childNRcv);
      return `<tr>
        <td>${idx + 1}</td>
        <td><strong>${escapeHtml(it.part_no || "")}</strong></td>
        <td>${escapeHtml(it.description_1 || "—")}</td>
        <td>${escapeHtml(it.make || "")}</td>
        <td style="text-align:right">${inv}</td>
        <td style="text-align:right">${rec}</td>
        <td style="text-align:right">${shortQ.toFixed(2)}</td>
        <td style="text-align:right">${ful == null ? "—" : ful.toFixed(2)}</td>
        <td style="text-align:right">${pending.toFixed(2)}</td>
      </tr>`;
    }
    const extraQ = parseFloat(it.extra_qty) || 0;
    const decided = isErnDecided(doc);
    return `<tr>
      <td>${idx + 1}</td>
      <td><strong>${escapeHtml(it.part_no || "")}</strong></td>
      <td>${escapeHtml(it.description_1 || "—")}</td>
      <td>${escapeHtml(it.make || "")}</td>
      <td style="text-align:right">${inv}</td>
      <td style="text-align:right">${rec}</td>
      <td style="text-align:right">${extraQ.toFixed(2)}</td>
      <td style="text-align:right">${decided ? ernApprovedQty(it, doc.status).toFixed(2) : "—"}</td>
      <td style="text-align:right">${decided ? ernRejectedQty(it, doc.status).toFixed(2) : "—"}</td>
    </tr>`;
  }).join("");

  const extraCols = isSrn
    ? `<th style="text-align:right">Short Qty</th><th style="text-align:right">Fulfilled Qty</th><th style="text-align:right">Pending Qty</th>`
    : `<th style="text-align:right">Extra Qty</th><th style="text-align:right">Approved Qty</th><th style="text-align:right">Rejected Qty</th>`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<title>${escapeHtml(doc[idField])} — ${escapeHtml(title)}</title>
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
  <h1>${escapeHtml(title)}</h1>
  <div style="text-align:center;margin-bottom:12px;">
    <span class="status-pill">${escapeHtml(meta.label)}</span>
  </div>

  <div class="header-grid">
    <div>
      ${pField(isSrn ? "SRN No" : "ERN No", doc[idField])}
      ${pField(isSrn ? "SRN Date" : "ERN Date", fmtDate(doc[dateField]))}
      ${pField("Related Receipt Note", `${doc.parent_rn_no || "—"} (${fmtDate(doc.parent_rn_date)})`)}
      ${pField("Invoice No", doc.invoice_no || "—")}
      ${pField("Invoice Date", fmtDate(doc.invoice_date))}
      ${pField("Status", meta.label)}
    </div>
    <div>
      ${isSrn ? pField("Pending Quantity", fmtQty(sumSrnQty(doc))) : pField("Extra Quantity", fmtQty(sumErnQty(doc)))}
      ${isSrn ? pField("Received Quantity", fmtQty(sumSrnReceived(doc))) : pField("Decided By", doc.decided_by || "—")}
      ${isSrn ? pField("Remaining Quantity", fmtQty(Math.max(0, sumSrnQty(doc) - sumSrnReceived(doc) - sumSrnNotReceivable(doc)))) : pField("Decided At", fmtDate(doc.decided_at) || "—")}
      ${pField("Created By", doc.created_by || "—")}
      ${pField("Assigned To", doc.assigned_to_name || doc.assigned_to_email || "—")}
    </div>
  </div>

  <div class="section-title">Items (${(doc.items || []).length})</div>
  <table>
    <thead><tr>
      <th>Sl No</th><th>Part No</th><th>Description 1</th><th>Make</th>
      <th style="text-align:right">Invoice Qty</th>
      <th style="text-align:right">Received Qty</th>
      ${extraCols}
    </tr></thead>
    <tbody>${items}</tbody>
  </table>

  <div class="footer">
    Printed: ${escapeHtml(new Date().toLocaleString())}
    &nbsp;·&nbsp; Printed by: ${escapeHtml(doc.created_by || "—")}
  </div>
  <script>window.onload = () => { setTimeout(() => window.print(), 100); };</script>
</body></html>`;

  const w = window.open("", "_blank", "width=1000,height=750");
  if (!w) { toast.error("Popup blocked — allow popups for this site to print"); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
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
  // { data, proceed } while the recompute preview is on screen; null otherwise.
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [assignedToUserId, setAssignedToUserId] = useState("");

  const [masterDialog, setMasterDialog] = useState(null);
  const fileInputRef = useRef(null);
  const draftBtnRef = useRef(null);
  const finalBtnRef = useRef(null);

  // One idempotency token per create session — a double-click / retried request on
  // POST /receipt-notes replays the same document instead of creating a duplicate draft.
  const clientTokenRef = useRef(isEdit ? null : (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`));

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
        model: it.model || "",
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
      // If exactly one make is auto-selected, also fetch description_1/model for that pair
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

  // Fetch description_1 / model when make is picked
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
    // Column order matches the entry table's importable fields: Part No, Make,
    // Invoice Qty, Received Qty (Model / Description 1 are always auto-populated
    // from Stock Master by Part No + Make, so they're not import columns).
    // Header names match handleExcelImport's parser (case-/separator-insensitive).
    // Include 2 hint rows: a generic example + an empty row the user can fill in.
    const header = isGeneral
      ? ["Part No", "Make", "Received Qty"]
      : ["Part No", "Make", "Invoice Qty", "Received Qty"];
    const example = isGeneral
      ? ["EXAMPLE-001", "ACME", 10]
      : ["EXAMPLE-001", "ACME", 10, 10];
    const blank = header.map(() => "");
    const ws = XLSX.utils.aoa_to_sheet([header, example, blank]);
    ws["!cols"] = isGeneral
      ? [{ wch: 18 }, { wch: 16 }, { wch: 14 }]
      : [{ wch: 18 }, { wch: 16 }, { wch: 12 }, { wch: 14 }];
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
    if (isGeneral && (rec == null || rec <= 0)) { toast.error(`Row ${idx + 1}: Received Qty must be > 0`); return false; }
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
  if (isGeneral && !items.every((it) => (toNum(it.received_qty) || 0) > 0)) return false;
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
    client_token: isEdit ? undefined : clientTokenRef.current,
    // Optimistic lock: the version we loaded. The server rejects the save with a
    // 409 if someone else edited this receipt in the meantime.
    version: isEdit ? (editing?.version ?? 0) : undefined,
    items: items.map((it) => ({
      part_no: it.part_no.trim(),
      make: it.make.trim(),
      // In GENERAL mode the server forces invoice_qty = received_qty. Send 0 here; the server overrides.
      invoice_qty: isGeneral ? (toNum(it.received_qty) || 0) : toNum(it.invoice_qty),
      received_qty: toNum(it.received_qty),
    })),
  });

  // Editing a finalized receipt recomputes its SRN / ERN / Racking Notes. Show the
  // user exactly what that will do before anything is written.
  const needsPreview = isEdit && editing?.status && editing.status !== "DRAFT";

  const runPreview = async (proceed) => {
    if (!needsPreview) return proceed();
    setPreviewLoading(true);
    try {
      const { data } = await api.post(`/receipt-notes/${editing.id}/edit-preview`, buildPayload());
      const noChanges =
        !data.srn.create.length && !data.srn.update.length && !data.srn.delete.length &&
        !data.ern.create.length && !data.ern.update.length && !data.ern.delete.length &&
        !data.racking.create.length && !data.racking.update.length && !data.racking.delete.length;
      if (noChanges && !data.blocked.length) return proceed();
      setPreview({ data, proceed });
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not preview this change");
    } finally { setPreviewLoading(false); }
  };

  const saveDraft = async () => {
    if (!validateBaseRows()) return;
    if (!validateDates()) return;
    return runPreview(doSaveDraft);
  };

  const doSaveDraft = async () => {
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
    return runPreview(doSaveFinal);
  };

  const doSaveFinal = async () => {
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
              onClick={handleDownloadTemplate}
              variant="outline"
              className="rounded-sm"
              data-testid="rn-excel-template-button"
              title={isGeneral ? "Download an empty Excel template (Part No, Make, Received Qty)" : "Download an empty Excel template (Part No, Make, Invoice Qty, Received Qty)"}
            >
              <DownloadSimple size={14} weight="bold" className="mr-1" /> Download Template
            </Button>
            <Button
              onClick={() => fileInputRef.current?.click()}
              variant="outline"
              className="rounded-sm"
              data-testid="rn-excel-import-button"
              title={isGeneral ? "Columns: Part No, Make, Received Qty" : "Columns: Part No, Make, Invoice Qty, Received Qty"}
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
                <th className="w-16 whitespace-nowrap">SL NO</th>
                <th className="w-32">MODEL</th>
                <th className="w-44">PART NO</th>
                <th>DESCRIPTION 1</th>
                <th className="w-56">MAKE</th>
                <th className="w-28 text-center">{isGeneral ? "INV QTY" : "INVOICE QTY"}</th>
                <th className="w-28 text-center">RECEIVED QTY</th>
                <th className="w-24 text-center">QTY DIFF</th>
                <th className="w-14"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => {
                // In GENERAL mode, qty diff is always 0 (invoice forced equal to received).
                const diff = isGeneral ? 0 : qtyDiff(it);
                const recFilled = toNum(it.received_qty) != null;
                const diffNonZero = !isGeneral && recFilled && diff !== 0;
                const recCls = `rounded-sm font-mono h-8 text-center ${diffNonZero ? "border-red-500 ring-1 ring-red-200" : ""}`;
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
                      <div
                        className="text-xs text-slate-700 px-2 py-1 bg-slate-50 rounded-sm border border-slate-200 truncate"
                        title={it.model || "—"}
                        data-testid={`rn-model-${idx}`}
                      >
                        {it.model || <span className="text-slate-400 italic">(auto from master)</span>}
                      </div>
                    </td>
                    <td>
                      <Input
                        value={it.part_no}
                        onChange={(e) => updateItem(idx, { part_no: e.target.value, partLooked: false, makes: [], make: "", description_1: "", model: "" })}
                        onBlur={(e) => { if (!it.partLooked) lookupMakes(idx, e.target.value); }}
                        onKeyDown={async (e) => {
                          if (e.key === "Tab" && !e.shiftKey) {
                            e.preventDefault();
                            if (!it.partLooked) {
                              await lookupMakes(idx, it.part_no);
                            }
                            const makeTrigger = document.querySelector(`[data-testid="rn-make-${idx}"]`);
                            if (makeTrigger) makeTrigger.focus();
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
                        className={`rounded-sm font-mono h-8 text-center ${isGeneral ? "bg-slate-100 text-slate-400" : ""}`}
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
                    <td className={`w-24 text-center font-mono ${diffCls}`} data-testid={`rn-qty-diff-${idx}`}>
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
              {items.some((it) => qtyDiff(it) > 0) && " An ERN's extra quantity needs Store Manager approval before it can be racked."}
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
                disabled={savingDraft || savingFinal || previewLoading}
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
              disabled={savingDraft || savingFinal || previewLoading || (!canFinalize && !isFinalEdit)}
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

      <RecomputePreviewDialog
        preview={preview}
        busy={savingDraft || savingFinal}
        onClose={() => setPreview(null)}
        onConfirm={() => { const p = preview; setPreview(null); p?.proceed(); }}
      />
    </div>
  );
}

/** Old -> new preview of what editing a finalized Receipt Note will do to its
 *  derived documents. Shown before anything is written, so the user confirms the
 *  recompute rather than discovering it afterwards. */
function RecomputePreviewDialog({ preview, busy, onClose, onConfirm }) {
  const d = preview?.data;
  if (!d) return null;
  const blocked = d.blocked?.length > 0;

  const qtyList = (rows) =>
    rows.map((r) => `${r.part_no} / ${r.make} → ${r.qty}`).join(", ");

  const Section = ({ title, plan, unit }) => {
    const has = plan.create.length || plan.update.length || plan.delete.length;
    if (!has) return null;
    return (
      <div className="rounded-sm border border-slate-200">
        <div className="bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700">{title}</div>
        <div className="divide-y divide-slate-100 text-sm">
          {plan.create.length > 0 && (
            <div className="px-3 py-2">
              <span className="mr-2 rounded-sm bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700">Create</span>
              {qtyList(plan.create)} <span className="text-slate-400">{unit}</span>
            </div>
          )}
          {plan.update.map((u, i) => (
            <div key={i} className="px-3 py-2">
              <span className="mr-2 rounded-sm bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700">Update</span>
              <span className="font-medium">{u.no}</span> — {qtyList(u.items)} <span className="text-slate-400">{unit}</span>
              {u.re_approval_required && (
                <span className="ml-2 text-xs font-medium text-amber-700">· needs re-approval</span>
              )}
            </div>
          ))}
          {plan.delete.length > 0 && (
            <div className="px-3 py-2">
              <span className="mr-2 rounded-sm bg-rose-50 px-1.5 py-0.5 text-xs font-medium text-rose-700">Remove</span>
              {plan.delete.join(", ")}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl" data-testid="rn-recompute-preview">
        <DialogHeader>
          <DialogTitle>
            {blocked ? "This edit cannot be saved" : "Confirm changes to derived documents"}
          </DialogTitle>
        </DialogHeader>

        {blocked ? (
          <div className="space-y-2 rounded-sm border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            {d.blocked.map((b, i) => <div key={i}>{b}</div>)}
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto">
            <p className="text-sm text-slate-600">
              The Receipt Note is the master document. Saving recomputes everything derived from it:
            </p>

            {d.items.some((i) => i.old_received_qty !== i.new_received_qty ||
                                 i.old_invoice_qty !== i.new_invoice_qty) && (
              <div className="rounded-sm border border-slate-200">
                <div className="bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700">Quantities</div>
                <table className="w-full text-sm">
                  <thead className="text-xs text-slate-500">
                    <tr>
                      <th className="px-3 py-1 text-left font-medium">Item</th>
                      <th className="px-3 py-1 text-right font-medium">Invoice</th>
                      <th className="px-3 py-1 text-right font-medium">Received</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {d.items.map((i, idx) => (
                      <tr key={idx}>
                        <td className="px-3 py-1.5">{i.part_no} / {i.make}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {i.old_invoice_qty !== i.new_invoice_qty
                            ? <><span className="text-slate-400 line-through">{i.old_invoice_qty ?? "—"}</span> {i.new_invoice_qty}</>
                            : i.new_invoice_qty}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {i.old_received_qty !== i.new_received_qty
                            ? <><span className="text-slate-400 line-through">{i.old_received_qty ?? "—"}</span> {i.new_received_qty}</>
                            : i.new_received_qty}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <Section title="Racking Note" plan={d.racking} unit="qty" />
            <Section title="Short Received Note (SRN)" plan={d.srn} unit="short" />
            <Section title="Extra Received Note (ERN)" plan={d.ern} unit="extra" />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" className="rounded-sm" onClick={onClose}>
            {blocked ? "Close" : "Cancel"}
          </Button>
          {!blocked && (
            <Button
              className="rounded-sm bg-blue-700 hover:bg-blue-800"
              disabled={busy}
              onClick={onConfirm}
              data-testid="rn-recompute-confirm"
            >
              {busy ? "Saving…" : "Save changes"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const nav = useStockInNav();

  const goEdit = (srn) => { setEditing(srn); setView("edit"); };
  const goList = () => { setEditing(null); setView("list"); setReloadKey((k) => k + 1); };

  useEffect(() => {
    if (nav?.editRequest?.type === "srn") {
      setOpenDetail(null);
      goEdit(nav.editRequest.doc);
      nav.clearEditRequest();
    }
  }, [nav?.editRequest?.token]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <SrnFinalizeForm srn={editing} onCancel={goList} />
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
  const nav = useStockInNav();

  const goEdit = (ern) => { setEditing(ern); setView("edit"); };
  const goList = () => { setEditing(null); setView("list"); setReloadKey((k) => k + 1); };

  useEffect(() => {
    if (nav?.editRequest?.type === "ern") {
      setOpenDetail(null);
      goEdit(nav.editRequest.doc);
      nav.clearEditRequest();
    }
  }, [nav?.editRequest?.token]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <ErnFinalizeForm ern={editing} onCancel={goList} onSaved={goList} />
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
      { key: "doc_date", label: `${noun} DATE`, value: (r) => fmtDate(r[dateField]) },
      { key: "doc_no", label: `${noun} NO`, value: (r) => r[idField] || "" },
      { key: "rn_date", label: "RECEIPT NOTE DATE", value: (r) => fmtDate(r.parent_rn_date) },
      { key: "rn_no", label: "RECEIPT NOTE NO", value: (r) => r.parent_rn_no || "" },
      { key: "status", label: "STATUS", value: (r) => statusMeta(r.status).label },
    ];
    return cols;
  }, [noun, dateField, idField]);

  const {
    filteredRows, uniqueValues, colFilters, setColFilter, sort, setColumnSort,
  } = useExcelTableFilter(rows, columns);

  return (
    <div className="mt-4" data-testid={`${kind}-list-view`}>
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input
            ref={searchInputRef}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder={`Search ${noun.toLowerCase()}s…`}
            className="rounded-sm font-mono h-9 pl-10 w-full"
            data-testid={`${kind}-search-input`}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={load} variant="outline" disabled={loading} className="rounded-sm border-slate-300" data-testid={`${kind}-refresh`}>
            <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-between mb-3 text-xs text-slate-600">
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
      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-16 whitespace-nowrap">SL NO</th>
              {columns.map((c) => (
                <th key={c.key} className={c.isQty ? "text-center" : ""}>
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
              // Editable until stock has actually been racked from this note — a
              // terminal status is not itself a lock, so a decision or fulfilment
              // recorded in error can still be corrected.
              const canEdit = !r.has_recorded_racking;
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
                        title={canEdit ? "Edit / Finalize" : "Locked — stock has already been racked from this note"}
                        data-testid={`${kind}-edit-${r[idField]}`}
                      >
                        <Pencil size={14} />
                      </button>
                      {/* No delete action: SRN and ERN are derived from the Receipt
                          Note. Removing one means removing the shortfall/overage at
                          source — edit the Receipt Note's Received Qty instead. */}
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
    </div>
  );
}

/** Read-only detail dialog for SRN/ERN — shows all rows with quantities. */
function ChildDetailDialog({ kind, doc: docProp, onClose, onOpen }) {
  const isSrn = kind === "srn";
  const idField = isSrn ? "srn_no" : "ern_no";
  const dateField = isSrn ? "srn_date" : "ern_date";
  const path = isSrn ? "/short-received-notes" : "/extra-received-notes";

  const [doc, setDoc] = useState(docProp);
  const [refreshing, setRefreshing] = useState(false);
  const [syncedId, setSyncedId] = useState(docProp?.id ?? null);
  // Keep local `doc` (mutable via Refresh) in sync with the `doc` prop whenever
  // the caller swaps in a different document — done during render (not a
  // useEffect) so `doc` never lags a render behind `docProp` here below.
  if ((docProp?.id ?? null) !== syncedId) {
    setSyncedId(docProp?.id ?? null);
    setDoc(docProp);
  }

  if (!doc) return null;
  const meta = statusMeta(doc.status);

  const handleRefresh = async () => {
    if (!doc?.id) return;
    setRefreshing(true);
    try {
      const { data } = await api.get(`${path}/${doc.id}`);
      setDoc(data);
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not refresh");
    } finally { setRefreshing(false); }
  };
  const handlePrint = () => printChildDoc(doc, kind);

  const renderChildren = (it) => {
    const list = it.children || [];
    if (!list.length) return <span className="text-slate-300">—</span>;
    return (
      <div className="flex flex-col gap-0.5 items-end">
        {list.map((c, i) => {
          const childNo = c.child_srn_no || c.child_ern_no;
          const qty = isSrn ? c.received_qty : c.accepted_qty;
          const altQty = isSrn ? c.not_receivable_qty : c.rejected_qty;
          const altLabel = isSrn ? "n/r" : "rej";
          return (
            <span
              key={i}
              className="font-mono text-blue-700 text-[11px]"
              title={`${childNo} · ${qty} rcvd${altQty ? ` · ${altQty} ${altLabel}` : ""}`}
              data-testid={`${kind}-child-${childNo}`}
            >
              {childNo}
            </span>
          );
        })}
      </div>
    );
  };

  return (
    <Dialog open={!!doc} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto rounded-sm" data-testid={`${kind}-detail-dialog`}>
        {/* ── HEADING ── */}
        <div className="text-center text-xl font-black tracking-widest uppercase pt-1 pb-2 border-b border-slate-200">
          {isSrn ? "SHORT RECEIPT NOTE" : "EXTRA RECEIPT NOTE"}
        </div>

        {/* ── HEADER: LEFT / RIGHT ── */}
        <div className="grid grid-cols-2 gap-6 text-sm pt-3 pb-4 border-b border-slate-200">
          {/* Left */}
          <div className="space-y-2">
            <Detail k={isSrn ? "SRN NO" : "ERN NO"} v={doc[idField]} />
            <Detail k={isSrn ? "SRN DATE" : "ERN DATE"} v={fmtDate(doc[dateField])} />
            <Detail k="RELATED RECEIPT NOTE" v={`${doc.parent_rn_no || "—"} (${fmtDate(doc.parent_rn_date)})`} />
            {isSrn ? (
              <>
                <Detail k="PENDING QUANTITY" v={fmtQty(sumSrnQty(doc))} />
                <Detail k="RECEIVED QUANTITY" v={fmtQty(sumSrnReceived(doc))} />
                <Detail k="REMAINING QUANTITY" v={fmtQty(Math.max(0, sumSrnQty(doc) - sumSrnReceived(doc) - sumSrnNotReceivable(doc)))} />
              </>
            ) : (
              <>
                <Detail k="EXTRA QUANTITY" v={fmtQty(sumErnQty(doc))} />
                <Detail k="DECIDED BY" v={doc.decided_by || "—"} />
                <Detail k="DECIDED AT" v={fmtDate(doc.decided_at) || "—"} />
              </>
            )}
            <Detail k="STATUS" v={
              <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${meta.cls}`}>
                {meta.label}
              </span>
            } />
          </div>
          {/* Right */}
          <div className="space-y-2">
            <Detail k="INVOICE NO" v={doc.invoice_no || "—"} />
            <Detail k="INVOICE DATE" v={fmtDate(doc.invoice_date)} />
            {isSrn && <Detail k="FULFILMENT DATE" v={fmtDate(doc.fulfillment_date)} />}
            <Detail k="ASSIGNED TO" v={doc.assigned_to_name || doc.assigned_to_email || "—"} />
            <Detail k="CREATED BY" v={doc.created_by || "—"} />
            {doc.parent_srn_no && <Detail k="PARENT SRN" v={doc.parent_srn_no} />}
            {doc.parent_ern_no && <Detail k="PARENT ERN" v={doc.parent_ern_no} />}
          </div>
        </div>

        {doc.chain_remarks && (
          <div className="text-xs text-slate-600 italic mt-2">{doc.chain_remarks}</div>
        )}

        {/* ── ITEMS TABLE ── */}
        <div className="mt-4">
          <div className="label-sm mb-2">Items ({(doc.items || []).length})</div>
          <div className="overflow-x-auto">
          <table className="data-table w-full text-xs">
            <thead>
              <tr>
                <th className="w-10">#</th>
                <th>PART NO</th>
                <th>DESCRIPTION 1</th>
                <th>MAKE</th>
                <th className="text-center">INV QTY</th>
                <th className="text-center">RCVD QTY</th>
                {isSrn ? (
                  <>
                    <th className="text-center">SHORT QTY</th>
                    <th className="text-center">FULFILLED QTY</th>
                    <th className="text-center">PENDING QTY</th>
                    <th className="text-center">CHILD SRNs</th>
                  </>
                ) : (
                  <>
                    <th className="text-center">EXTRA QTY</th>
                    <th className="text-center">APPROVED QTY</th>
                    <th className="text-center">REJECTED QTY</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {(doc.items || []).map((it, idx) => {
                if (isSrn) {
                  const shortQ = parseFloat(it.short_qty) || 0;
                  // Inline-child model: total received + not_receivable across children
                  const childRcv = (it.children || []).reduce(
                    (s, c) => s + (parseFloat(c.received_qty) || 0), 0,
                  );
                  const childNRcv = (it.children || []).reduce(
                    (s, c) => s + (parseFloat(c.not_receivable_qty) || 0), 0,
                  );
                  const ful = (it.children || []).length > 0
                    ? childRcv
                    : (it.fulfilled_qty == null ? null : (parseFloat(it.fulfilled_qty) || 0));
                  const pending = ful == null ? shortQ : (shortQ - ful - childNRcv);
                  return (
                    <tr key={idx}>
                      <td className="font-mono text-slate-500">{idx + 1}</td>
                      <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                      <td className="text-slate-700">{it.description_1 || "—"}</td>
                      <td>{it.make}</td>
                      <td className="text-center font-mono">{fmtQty(it.invoice_qty)}</td>
                      <td className="text-center font-mono">{fmtQty(it.received_qty)}</td>
                      <td className="text-center font-mono font-bold text-red-700">{shortQ.toFixed(2)}</td>
                      <td className="text-center font-mono">{ful == null ? "—" : ful.toFixed(2)}</td>
                      <td className={`text-center font-mono font-bold ${pending > 0 ? "text-amber-700" : "text-green-700"}`}>{pending.toFixed(2)}</td>
                      <td className="text-center">{renderChildren(it)}</td>
                    </tr>
                  );
                }
                const extraQ = parseFloat(it.extra_qty) || 0;
                const decided = isErnDecided(doc);
                return (
                  <tr key={idx}>
                    <td className="font-mono text-slate-500">{idx + 1}</td>
                    <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                    <td className="text-slate-700">{it.description_1 || "—"}</td>
                    <td>{it.make}</td>
                    <td className="text-center font-mono">{fmtQty(it.invoice_qty)}</td>
                    <td className="text-center font-mono">{fmtQty(it.received_qty)}</td>
                    <td className="text-center font-mono font-bold text-amber-700">{extraQ.toFixed(2)}</td>
                    <td className="text-center font-mono font-bold text-green-700">
                      {decided ? ernApprovedQty(it, doc.status).toFixed(2) : "—"}
                    </td>
                    <td className="text-center font-mono text-red-700">
                      {decided ? ernRejectedQty(it, doc.status).toFixed(2) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>

        {/* ── ACTION BUTTONS ── */}
        <div className="flex items-center gap-2 pt-4 border-t border-slate-200 mt-2">
          <Button variant="outline" size="sm" className="rounded-sm" onClick={handleRefresh} disabled={refreshing}>
            {refreshing
              ? <CircleNotch size={14} weight="bold" className="mr-1.5 animate-spin" />
              : <ArrowsClockwise size={14} weight="bold" className="mr-1.5" />}
            Refresh
          </Button>
          <Button variant="outline" size="sm" className="rounded-sm" onClick={handlePrint} data-testid={`${kind}-detail-print`}>
            <Printer size={14} weight="bold" className="mr-1.5" /> Print
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** SRN finalize/edit form — user enters fulfilled_qty per row + fulfillment_date. */
function SrnFinalizeForm({ srn: initialSrn, onCancel }) {
  // Inline-child model: each item has children[]; user clicks (+) to add a row.
  const [parent, setParent] = useState(initialSrn);
  // Per-item draft: { [itemIdx]: { received_qty, not_receivable_qty } } — appears inline as a new row when user clicks +
  const [drafts, setDrafts] = useState({});
  const [editing, setEditing] = useState(null); // { itemIdx, child_srn_no, received_qty, not_receivable_qty }
  const [busy, setBusy] = useState(false);
  const [narration, setNarration] = useState(initialSrn.narration || "");
  const [savingNarration, setSavingNarration] = useState(false);

  const reload = async () => {
    try {
      const { data } = await api.get(`/short-received-notes/${parent.id}`);
      setParent(data);
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not reload");
    }
  };

  const setDraft = (idx, patch) =>
    setDrafts((d) => ({ ...d, [idx]: { ...(d[idx] || { received_qty: "", not_receivable_qty: "" }), ...patch } }));

  const startAddChild = (idx) => setDraft(idx, {});

  const cancelAddChild = (idx) =>
    setDrafts((d) => { const n = { ...d }; delete n[idx]; return n; });

  const totals = (it) => {
    const children = it.children || [];
    const rcv = children.reduce((s, c) => s + (parseFloat(c.received_qty) || 0), 0);
    const nrcv = children.reduce((s, c) => s + (parseFloat(c.not_receivable_qty) || 0), 0);
    const pending = (parseFloat(it.short_qty) || 0) - rcv - nrcv;
    return { rcv, nrcv, pending };
  };

  const saveNewChild = async (idx) => {
    const it = parent.items[idx];
    const d = drafts[idx] || {};
    const rcv = parseFloat(d.received_qty || 0);
    const nrcv = parseFloat(d.not_receivable_qty || 0);
    if (!rcv && !nrcv) { toast.error("Enter Received Qty or Not Receivable Qty"); return; }
    const { pending } = totals(it);
    if (rcv + nrcv > pending + 1e-6) {
      toast.error(`Exceeds Pending Qty (${pending.toFixed(2)})`); return;
    }
    setBusy(true);
    try {
      const res = await api.post(`/short-received-notes/${parent.id}/children`, {
        part_no: it.part_no, make: it.make,
        received_qty: rcv, not_receivable_qty: nrcv,
      });
      const autoRkn = res.headers?.["x-auto-rkn-no"];
      if (autoRkn) toast.success(`Child row added — ${autoRkn} auto-created for racking`);
      else toast.success("Child row added");
      cancelAddChild(idx);
      await reload();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not add row");
    } finally { setBusy(false); }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const { itemIdx, child_srn_no, received_qty, not_receivable_qty } = editing;
    const it = parent.items[itemIdx];
    const rcv = parseFloat(received_qty || 0);
    const nrcv = parseFloat(not_receivable_qty || 0);
    if (!rcv && !nrcv) { toast.error("Enter Received or Not Receivable Qty"); return; }
    setBusy(true);
    try {
      const res = await api.put(
        `/short-received-notes/${parent.id}/children/${encodeURIComponent(child_srn_no)}`,
        { part_no: it.part_no, make: it.make, received_qty: rcv, not_receivable_qty: nrcv },
      );
      const autoRkn = res.headers?.["x-auto-rkn-no"];
      if (autoRkn) toast.success(`Row updated — ${autoRkn} auto-created for racking`);
      else toast.success("Row updated");
      setEditing(null);
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

  const saveNarration = async () => {
    setSavingNarration(true);
    try {
      await api.patch(`/short-received-notes/${parent.id}/narration`, { narration: narration.trim() });
      toast.success("Narration saved");
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save narration");
    } finally { setSavingNarration(false); }
  };

  return (
    <div className="mt-4 space-y-6" data-testid="srn-finalize-view">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="srn-back">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm p-6 grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Detail k="Stock In Type" v={stockInTypeLabel(parent.parent_stock_in_type)} />
        <Detail k="SRN Date" v={fmtDate(parent.srn_date)} />
        <Detail k="SRN No" v={parent.srn_no} />
        <Detail k="Receipt Note Date" v={fmtDate(parent.parent_rn_date) || "—"} />
        <Detail k="Receipt Note No" v={parent.parent_rn_no || "—"} />
        <Detail k="Invoice Date" v={fmtDate(parent.invoice_date) || "—"} />
        <Detail k="Invoice No" v={parent.invoice_no || "—"} />
      </div>

      <div className="bg-white border border-slate-200 rounded-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 label-sm flex items-center justify-between">
          <span>SHORT ITEMS — Click + to add a fulfillment row as material arrives</span>
          <span className="text-[11px] text-slate-500 normal-case">Each row is a Child SRN (PARENT-A, PARENT-B…). Only Received Qty is rackable.</span>
        </div>
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-8">SL NO</th>
              <th className="w-32">MODEL</th>
              <th className="w-44">PART NO</th>
              <th>DESCRIPTION</th>
              <th className="w-32">MAKE</th>
              <th className="w-20 text-center">SHORT QTY</th>
              <th className="w-28">CHILD SRN NO</th>
              <th className="w-32">RECEIVED QTY</th>
              <th className="w-32">NOT RECEIVABLE</th>
              <th className="w-20 text-center">PENDING</th>
              <th className="w-24 text-center">TOTAL RECEIVED</th>
              <th className="w-24 text-center">TOTAL NOT RECEIVABLE</th>
              <th className="w-24 text-right">ACTION</th>
            </tr>
          </thead>
          <tbody>
            {(parent.items || []).flatMap((it, idx) => {
              const { rcv, nrcv, pending } = totals(it);
              const rows = [];

              // Header row showing the parent item + Add (+) button
              rows.push(
                <tr key={`h-${idx}`} className="bg-slate-50">
                  <td className="font-mono text-slate-500 font-bold">{idx + 1}</td>
                  <td className="text-xs text-slate-700 truncate max-w-[140px]" title={it.model}>{it.model || "—"}</td>
                  <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                  <td className="text-xs text-slate-700 truncate max-w-[220px]" title={it.description_1}>{it.description_1 || "—"}</td>
                  <td className="text-xs text-slate-700 truncate max-w-[140px]" title={it.make}>{it.make || "—"}</td>
                  <td className="text-center font-mono font-bold text-red-700">{(parseFloat(it.short_qty) || 0).toFixed(2)}</td>
                  <td colSpan={3} className="text-slate-400 italic text-xs text-center">— Click + to add a row —</td>
                  <td className={`text-center font-mono font-bold ${pending > 0.0001 ? "text-amber-700" : "text-green-700"}`}>{pending.toFixed(2)}</td>
                  <td className="text-center font-mono font-bold text-green-700">{rcv.toFixed(2)}</td>
                  <td className="text-center font-mono text-slate-700">{nrcv.toFixed(2)}</td>
                  <td className="text-right">
                    {pending > 1e-6 && drafts[idx] === undefined && (
                      <button onClick={() => startAddChild(idx)} disabled={busy}
                        className="bg-blue-700 text-white hover:bg-blue-800 px-2 py-1 rounded-sm text-xs font-bold inline-flex items-center"
                        data-testid={`srn-add-child-${idx}`}>
                        <Plus size={12} weight="bold" className="mr-1" /> Add
                      </button>
                    )}
                  </td>
                </tr>
              );

              // Saved children
              (it.children || []).forEach((c, ci) => {
                const isEdit = editing && editing.child_srn_no === c.child_srn_no;
                rows.push(
                  <tr key={`${idx}-c-${ci}`} className="bg-green-50/30" data-testid={`srn-row-${idx}-${ci}`}>
                    <td className="font-mono text-slate-400 text-[10px]">{idx + 1}.{ci + 1}</td>
                    <td colSpan={5} className="text-xs text-slate-500 pl-8">
                      <span className="text-slate-400">└─ </span>
                      <span className="font-mono text-blue-700">{c.child_srn_no}</span>
                      <span className="ml-2 text-[10px] text-slate-500">({fmtDate(c.created_at)})</span>
                    </td>
                    <td className="font-mono text-blue-700 text-xs">{c.child_srn_no}</td>
                    <td>
                      {isEdit ? (
                        <Input type="number" min="0" step="any" value={editing.received_qty}
                          onChange={(e) => setEditing({ ...editing, received_qty: e.target.value })}
                          className="rounded-sm font-mono h-7 text-center" />
                      ) : <span className="font-mono font-bold text-green-800">{(parseFloat(c.received_qty) || 0).toFixed(2)}</span>}
                    </td>
                    <td>
                      {isEdit ? (
                        <Input type="number" min="0" step="any" value={editing.not_receivable_qty}
                          onChange={(e) => setEditing({ ...editing, not_receivable_qty: e.target.value })}
                          className="rounded-sm font-mono h-7 text-center" />
                      ) : <span className="font-mono text-slate-700">{(parseFloat(c.not_receivable_qty) || 0).toFixed(2)}</span>}
                    </td>
                    <td colSpan={3}></td>
                    <td className="text-right">
                      {isEdit ? (
                        <div className="flex gap-1 justify-end">
                          <button onClick={saveEdit} disabled={busy}
                            className="text-green-700 hover:bg-green-100 p-1 rounded-sm" title="Save"
                            data-testid={`srn-row-save-${idx}-${ci}`}>
                            <FloppyDisk size={14} weight="bold" />
                          </button>
                          <button onClick={() => setEditing(null)} disabled={busy}
                            className="text-slate-500 hover:bg-slate-100 p-1 rounded-sm" title="Cancel">
                            <X size={14} weight="bold" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-1 justify-end">
                          <button onClick={() => setEditing({
                            itemIdx: idx, child_srn_no: c.child_srn_no,
                            received_qty: c.received_qty, not_receivable_qty: c.not_receivable_qty,
                          })} disabled={busy}
                            className="text-blue-700 hover:bg-blue-100 p-1 rounded-sm" title="Edit"
                            data-testid={`srn-row-edit-${idx}-${ci}`}>
                            <PencilSimple size={14} weight="bold" />
                          </button>
                          <button onClick={() => deleteChild(c.child_srn_no)} disabled={busy}
                            className="text-red-700 hover:bg-red-100 p-1 rounded-sm" title="Delete"
                            data-testid={`srn-row-del-${idx}-${ci}`}>
                            <Trash size={14} weight="bold" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              });

              // Inline draft row for adding a new child
              if (drafts[idx] !== undefined) {
                const d = drafts[idx];
                rows.push(
                  <tr key={`${idx}-draft`} className="bg-blue-50" data-testid={`srn-draft-${idx}`}>
                    <td className="font-mono text-blue-600 text-[10px]">+</td>
                    <td colSpan={5} className="text-xs text-blue-900 pl-8 italic">
                      <span className="text-slate-400">└─ </span>New row · max {pending.toFixed(2)}
                    </td>
                    <td className="font-mono text-slate-400 italic text-xs">auto…</td>
                    <td>
                      <Input type="number" min="0" step="any" max={pending}
                        value={d.received_qty || ""}
                        onChange={(e) => setDraft(idx, { received_qty: e.target.value })}
                        placeholder="0"
                        className="rounded-sm font-mono h-8 text-center"
                        data-testid={`srn-input-rcv-${idx}`} />
                    </td>
                    <td>
                      <Input type="number" min="0" step="any" max={pending}
                        value={d.not_receivable_qty || ""}
                        onChange={(e) => setDraft(idx, { not_receivable_qty: e.target.value })}
                        placeholder="0"
                        className="rounded-sm font-mono h-8 text-center"
                        data-testid={`srn-input-nrcv-${idx}`} />
                    </td>
                    <td colSpan={3}></td>
                    <td className="text-right">
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => saveNewChild(idx)} disabled={busy}
                          className="text-green-700 hover:bg-green-100 p-1 rounded-sm" title="Save"
                          data-testid={`srn-draft-save-${idx}`}>
                          <FloppyDisk size={14} weight="bold" />
                        </button>
                        <button onClick={() => cancelAddChild(idx)} disabled={busy}
                          className="text-slate-500 hover:bg-slate-100 p-1 rounded-sm" title="Cancel"
                          data-testid={`srn-draft-cancel-${idx}`}>
                          <X size={14} weight="bold" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              }
              return rows;
            })}
          </tbody>
        </table>
        <div className="px-4 py-3 border-t border-slate-200 bg-blue-50 text-blue-900 text-xs">
          <strong>How this works:</strong> Click <strong>+ Add</strong> to record a fulfillment batch.
          Each batch becomes a Child SRN ({parent.srn_no}-A, -B, -C…). <em>Received Qty</em> is rackable;
          <em> Not Receivable Qty</em> is recorded but won't count toward racking. Status auto-flips to
          <strong> COMPLETE</strong> when Total Received + Total Not Receivable = Short Qty.
        </div>
      </div>

      {/* NARRATION + SAVE BAR */}
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
              data-testid="srn-narration"
            />
          </div>
          <div className="flex items-center gap-2 pt-7">
            <Button onClick={saveNarration} disabled={savingNarration || busy} className="rounded-sm bg-blue-700 hover:bg-blue-800 px-5" data-testid="srn-save-narration">
              <FloppyDisk size={14} weight="bold" className="mr-2" />
              {savingNarration ? "Saving…" : "Save SRN"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
function ErnFinalizeForm({ ern: initialErn, onCancel, onSaved }) {
  const [parent, setParent] = useState(initialErn);
  const [busy, setBusy] = useState(false);
  const [narration, setNarration] = useState(initialErn.narration || "");

  const reload = async () => {
    try {
      const { data } = await api.get(`/extra-received-notes/${parent.id}`);
      setParent(data);
      setApprovedQty(seedApproved(data));
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not reload");
    }
  };

  const isPending = (parent.status || "PENDING_APPROVAL") === "PENDING_APPROVAL";
  const isDecided = !isPending;
  const totalExtra = sumErnQty(parent);
  // Editable for as long as nothing has actually been racked from this ERN yet —
  // a decision, even a terminal-looking one, is correctable right up until then.
  // No separate "reopen" step: changing the split and clicking Approve/Reject
  // re-decides in place.
  const canEdit = !parent.has_recorded_racking;

  // Per-row approved qty, seeded from the note's current state: the full extra
  // for a still-pending row, or its existing split for one already decided.
  const seedApproved = (doc) => (doc.items || []).map((it) => String(ernApprovedQty(it, doc.status)));
  const [approvedQty, setApprovedQty] = useState(() => seedApproved(initialErn));
  const splitFor = (idx, it) => {
    const extra = parseFloat(it.extra_qty) || 0;
    const app = Math.min(Math.max(parseFloat(approvedQty[idx]) || 0, 0), extra);
    return { approved: app, rejected: extra - app };
  };
  const totalApproved = (parent.items || []).reduce((s, it, i) => s + splitFor(i, it).approved, 0);
  const isPartial = totalApproved > 0 && totalApproved < totalExtra - 1e-6;

  const decisionItems = () => (parent.items || []).map((it, i) => {
    const { approved, rejected } = splitFor(i, it);
    return { part_no: it.part_no, make: it.make, approved_qty: approved, rejected_qty: rejected };
  });

  const narrationChanged = narration.trim() !== (parent.narration || "").trim();
  const hasChanges = canEdit || narrationChanged;

  // One button for the whole page: saves the approve/reject split (when the ERN
  // is still editable) and the narration (whenever it changed) together. The
  // server derives APPROVED vs REJECTED from the split's totals — nothing
  // approved lands as REJECTED, anything approved (even partially) lands as
  // APPROVED — so this same action covers the first decision, every
  // re-decision after it, and a narration-only edit once the note is locked.
  const saveErn = async () => {
    const allApproved = totalApproved >= totalExtra - 1e-6;
    const allRejected = totalApproved <= 1e-6;
    if (canEdit) {
      const verb = isDecided ? "Save" : (allApproved ? "Approve" : allRejected ? "Reject" : "Save");
      const msg = allRejected
        ? `${verb} — reject the full extra quantity (${totalExtra.toFixed(2)}) on ${parent.ern_no}? It will never be rackable.`
        : allApproved
          ? `${verb} — approve the full extra quantity (${totalExtra.toFixed(2)}) on ${parent.ern_no}? This makes it rackable.`
          : `${verb} — approve ${totalApproved.toFixed(2)} of ${totalExtra.toFixed(2)} on ${parent.ern_no}? `
            + `The remaining ${(totalExtra - totalApproved).toFixed(2)} is rejected and will never enter stock.`;
      if (!window.confirm(msg)) return;
    }
    setBusy(true);
    try {
      let autoRkn = null;
      if (canEdit) {
        const res = await api.post(`/extra-received-notes/${parent.id}/approve`,
          { items: decisionItems() });
        autoRkn = res.headers?.["x-auto-rkn-no"];
      }
      if (narrationChanged) {
        await api.patch(`/extra-received-notes/${parent.id}/narration`, { narration: narration.trim() });
      }
      toast.success(autoRkn ? `Saved — ${autoRkn} auto-created for racking` : "Saved");
      await reload();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save");
    } finally { setBusy(false); }
  };

  const meta = statusMeta(parent.status);

  return (
    <div className="mt-4 space-y-6" data-testid="ern-finalize-view">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="ern-back">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
        <Button onClick={onSaved} variant="outline"
          className="rounded-sm border-blue-700 text-blue-700 hover:bg-blue-50" data-testid="ern-done">
          <CheckCircle size={14} weight="bold" className="mr-2" /> Done
        </Button>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm p-6 grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Detail k="ERN Date" v={fmtDate(parent.ern_date)} />
        <Detail k="ERN No" v={parent.ern_no} />
        <Detail k="Parent RN" v={`${parent.parent_rn_no || "—"} (${fmtDate(parent.parent_rn_date) || "—"})`} />
        <Detail k="Invoice No" v={parent.invoice_no || "—"} />
        <Detail k="Status" v={<span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${meta.cls}`}>{meta.label}</span>} />
        {!isPending && (
          <>
            <Detail k="Decided By" v={parent.decided_by || "—"} />
            <Detail k="Decided At" v={fmtDate(parent.decided_at) || "—"} />
          </>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 label-sm flex items-center justify-between">
          <span>EXTRA ITEMS</span>
          <span className="text-[11px] text-slate-500 normal-case">
            {canEdit
              ? "Set Approved on each row — the rest is rejected and never enters stock — then Save ERN."
              : "Locked — stock has been racked from this ERN, so the decision is now final."}
          </span>
        </div>
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-8">#</th>
              <th className="w-44">PART NO</th>
              <th>DESCRIPTION 1</th>
              <th className="w-24 text-center">INVOICE</th>
              <th className="w-24 text-center">RECEIVED</th>
              <th className="w-24 text-center">EXTRA</th>
              <th className="w-28 text-center">APPROVED</th>
              <th className="w-24 text-center">REJECTED</th>
            </tr>
          </thead>
          <tbody>
            {(parent.items || []).map((it, idx) => {
              const extra = parseFloat(it.extra_qty) || 0;
              const { approved, rejected } = splitFor(idx, it);
              return (
              <tr key={idx} data-testid={`ern-row-${idx}`}>
                <td className="font-mono text-slate-500 font-bold">{idx + 1}</td>
                <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                <td className="text-xs text-slate-700 truncate max-w-[240px]" title={it.description_1}>{it.description_1 || "—"}</td>
                <td className="text-center font-mono">{(parseFloat(it.invoice_qty) || 0).toFixed(2)}</td>
                <td className="text-center font-mono">{(parseFloat(it.received_qty) || 0).toFixed(2)}</td>
                <td className="text-center font-mono font-bold text-amber-700">{extra.toFixed(2)}</td>
                <td className="text-center">
                  {canEdit ? (
                    <input
                      type="number" min={0} max={extra} step="any"
                      value={approvedQty[idx] ?? ""}
                      onChange={(e) => setApprovedQty((prev) => {
                        const next = [...prev]; next[idx] = e.target.value; return next;
                      })}
                      className="w-20 rounded-sm border border-slate-300 px-2 py-1 text-center text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                      data-testid={`ern-approved-${idx}`}
                    />
                  ) : (
                    <span className="font-mono font-bold text-green-700">{(parseFloat(approved) || 0).toFixed(2)}</span>
                  )}
                </td>
                <td className="text-center font-mono text-red-700">{(parseFloat(rejected) || 0).toFixed(2)}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
        <div className="px-4 py-3 border-t border-slate-200 flex items-center justify-between gap-4">
          <div className="text-xs text-slate-500">
            {!canEdit
              ? `This ERN was ${(parent.status || "").toLowerCase()} and stock has been racked from it — the decision is now final.`
              : isPending
                ? (isPartial
                    ? `Partial decision: ${totalApproved.toFixed(2)} of ${totalExtra.toFixed(2)} will be approved and racked; the rest is rejected.`
                    : "Awaiting a decision — set Approved qty and click Save ERN.")
                : `This ERN was ${(parent.status || "").toLowerCase()}. Nothing has been racked from it yet — adjust Approved above and Save ERN to re-decide.`}
          </div>
        </div>
      </div>

      {/* NARRATION + THE SINGLE SAVE ACTION FOR THIS PAGE */}
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
              data-testid="ern-narration"
            />
          </div>
          <div className="flex items-center gap-2 pt-7">
            <Button onClick={saveErn} disabled={busy || !hasChanges}
              className="rounded-sm bg-blue-700 hover:bg-blue-800 px-5" data-testid="ern-save">
              <FloppyDisk size={14} weight="bold" className="mr-2" />
              {busy ? "Saving…" : "Save ERN"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
