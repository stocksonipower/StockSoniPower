import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { api, formatApiError } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "../components/ui/select";
import {
  Dialog, DialogContent,
} from "../components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import {
  Plus, Trash, ArrowLeft, FloppyDisk, FileText, CaretLeft, CaretRight,
  Pencil, CheckCircle, Package, Printer,
  DownloadSimple, UploadSimple, ArrowsClockwise, MagnifyingGlass,
} from "@phosphor-icons/react";
import { useAuth } from "../lib/auth";
import AssigneeSelect, { AssigneeBadge } from "../components/AssigneeSelect";
import ExcelColumnFilter from "../components/ExcelColumnFilter";
import useExcelTableFilter from "../components/useExcelTableFilter";
import PartNoLink from "../components/PartNoLink";
import { exportToExcel } from "../lib/exportExcel";
import { buildStandardPrintHtml, openPrintWindow } from "../lib/printDocument";

const PAGE_SIZE = 100;
const NO_GODOWN = "__NO_GODOWN__";
// Stock can legitimately sit in a godown with no rack and/or no box (racking is not
// mandatory everywhere). Radix rejects an empty SelectItem value, so those levels get a
// sentinel key. `rack_sel`/`box_sel` on a row hold the chosen key, which is what tells
// "(no rack) was chosen" apart from "nothing chosen yet" — both have rack_id === "".
const NO_RACK = "__NO_RACK__";
const NO_BOX = "__NO_BOX__";

function locSelKeys(row) {
  if (!row.godown_id) return { rack_sel: "", box_sel: "" };
  return { rack_sel: row.rack_id || NO_RACK, box_sel: row.box_id || NO_BOX };
}

function fmtDate(iso) {
  if (!iso) return "—";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pickingKey(it) {
  return `${it.part_no || ""}||${it.make || ""}`;
}

// A blank Quantity on an Issue Note line is deliberate ("open"): the office user often
// cannot know how many pieces a godown package holds, so the store incharge fills the
// number in on the Picking Note. Open lines are never checked against stock up front.
function isOpenQty(it) {
  return String(it?.quantity ?? "").trim() === "";
}

// Issue Note uses the standard 3-status set (Pending / In Process / Complete);
// legacy values are recognized defensively in case a cached row predates migration.
function issueStatusLabel(status) {
  if (status === "COMPLETE" || status === "COMPLETED" || status === "FULLY_PICKED") return "Complete";
  if (status === "IN_PROCESS" || status === "PICKING_IN_PROGRESS" || status === "PARTIALLY_PICKED" || status === "PICKED") return "In Process";
  return "Pending";
}

function issueStatusClass(status) {
  const label = issueStatusLabel(status);
  if (label === "Complete") return "bg-green-100 text-green-800";
  if (label === "In Process") return "bg-blue-50 text-blue-800";
  return "bg-amber-50 text-amber-700";
}

// Locked (edit/delete) the moment picking has actually started — mirrors the backend
// rule exactly, since status only leaves Pending once a Picking Note is COMPLETED.
function issueHasProcessed(status) {
  return issueStatusLabel(status) !== "Pending";
}

// Picking Note is a secondary/operational document and keeps its own working states
// rather than the 3-status set — RECORDING is a transient lock state, folded into
// "Draft" for display.
function pickingNoteStatusLabel(status) {
  if (status === "COMPLETED" || status === "RECORDED") return "Completed";
  if (status === "PENDING") return "Pending";
  return "Draft";
}

// Row identity for matching saved picking rows back to freshly-prepared ones: the Issue
// Note LINE plus the full location. Line first, because the same part/make can appear on
// several lines (15 for one purpose, 5 for another) at the very same location — keying on
// part/make/location alone would merge them into one row and lose a line.
function pickingLocKey(it) {
  return `${it.line_no ?? ""}||${it.part_no || ""}||${it.make || ""}||${it.godown_id || ""}||${it.rack_id || ""}||${it.box_id || ""}`;
}

// Location-only key (no part/make) — `available_locations` entries are already
// scoped to one item's part/make, so this is enough to match a row's current
// selection against one of its own choices.
function locOnlyKey(L) {
  return `${L?.godown_id || ""}||${L?.rack_id || ""}||${L?.box_id || ""}`;
}

function pickingAssignedItems(pn) {
  return (pn.assigned_items || []).length ? (pn.assigned_items || []) : (pn.requested_items || []);
}

// Where stock was ACTUALLY picked from, per part/make, out of the completed Picking
// Notes. The Issue Note only ever held a suggested allocation; once the store incharge
// resolves the real godown/rack/box, that supersedes the suggestion everywhere the
// Issue Note is shown or printed.
function issueActualLocations(pickingHistory = []) {
  const m = {};
  (pickingHistory || []).forEach((pn) => {
    if (!(pn.status === "COMPLETED" || pn.status === "RECORDED")) return;
    (pn.items || []).forEach((it) => {
      const qty = parseFloat(it.quantity) || 0;
      if (qty <= 0) return;
      const k = pickingKey(it);
      (m[k] = m[k] || []).push({
        godown_name: it.godown_name || "", rack_no: it.rack_no || "",
        box_no: it.box_no || "", quantity: qty,
      });
    });
  });
  return m;
}

// Requested qty for a picking row, from the Issue Note assignment carried on the Picking
// Note. Resolved per LINE so two lines of the same part/make keep their own numbers;
// rows saved before line numbers existed fall back to the part/make total. `null` = the
// office left the quantity open, which every view renders as blank rather than 0.
function pickingRequestedLookup(pn) {
  const byLine = {};
  const byKey = {};
  // Notes saved before line numbers existed get them by position — the same fallback
  // `prepare_picking_note` applies, so both sides agree on which line is which.
  pickingAssignedItems(pn).forEach((it, i) => {
    const line = it.line_no ?? (i + 1);
    const k = pickingKey(it);
    if (it.quantity == null) {
      byLine[line] = null;
      if (!(k in byKey)) byKey[k] = null;
      return;
    }
    const q = parseFloat(it.quantity) || 0;
    byLine[line] = (byLine[line] || 0) + q;
    byKey[k] = (byKey[k] || 0) + q;
  });
  return (row) => (row?.line_no != null && row.line_no in byLine ? byLine[row.line_no] : byKey[pickingKey(row)]);
}

function pickingAssignedQty(pn) {
  return pickingAssignedItems(pn).reduce((s, it) => s + (parseInt(it.quantity) || 0), 0);
}

function pickingPickedQty(pn) {
  return (pn.items || []).reduce((s, it) => s + (parseInt(it.quantity) || 0), 0);
}

function pickingDisplayItems(pn) {
  if ((pn.items || []).length) {
    return (pn.items || []).map((it) => ({ ...it, row_status: pn.status === "COMPLETED" || pn.status === "RECORDED" ? "Picked" : "Draft Pick" }));
  }
  return pickingAssignedItems(pn).map((it) => ({ ...it, row_status: pn.status === "PENDING" ? "Pending" : "Assigned" }));
}

function pickingDisplayQty(pn) {
  return pickingAssignedQty(pn);
}

function pickingDisplayCount(pn) {
  return pickingDisplayItems(pn).length || pn.requested_items_count || (pn.requested_items || []).length || 0;
}

// Picking Note print columns: Sr, Part No, Item, Godown, Rack, Box, Requested Qty, Picked Qty, Picker
function printPickingNote(pn) {
  const requestedFor = pickingRequestedLookup(pn);
  const rows = pickingDisplayItems(pn).map((it, idx) => [
    String(idx + 1),
    htmlEscape(it.part_no),
    htmlEscape(it.description_1 || it.make || ""),
    htmlEscape(it.godown_name || "—"),
    htmlEscape(it.rack_no || "—"),
    htmlEscape(it.box_no || "—"),
    `<span style="text-align:right;display:block">${htmlEscape(requestedFor(it) ?? "")}</span>`,
    `<span style="text-align:right;display:block">${htmlEscape(it.quantity ?? "—")}</span>`,
    htmlEscape(pn.created_by || "—"),
  ]);
  const html = buildStandardPrintHtml({
    docTitle: "Picking Note",
    docNo: pn.pn_no,
    statusLabel: pickingNoteStatusLabel(pn.status),
    fieldsLeft: [
      ["Picking No", pn.pn_no],
      ["Picking Date", fmtDate(pn.pn_date)],
      ["Issue Note No", pn.issue_note_no || "—"],
      ["Issue Note Date", fmtDate(pn.issue_note_date)],
      ["Status", pickingNoteStatusLabel(pn.status)],
    ],
    fieldsRight: [
      ["Assigned To", pn.parent_assigned_to_name || pn.parent_assigned_to_email || "—"],
      ["Picker", pn.created_by || "—"],
      ["Requested Qty", pickingAssignedQty(pn) || "—"],
      ["Picked Qty", pickingPickedQty(pn)],
    ],
    columns: [
      { label: "Sr" }, { label: "Part No" }, { label: "Item" },
      { label: "Godown" }, { label: "Rack" }, { label: "Box" },
      { label: "Requested Qty", align: "right" }, { label: "Picked Qty", align: "right" },
      { label: "Picker" },
    ],
    rows,
    printedBy: pn.created_by,
  });
  if (!openPrintWindow(html)) toast.error("Popup blocked — allow popups for this site to print");
}

// Issue Note print columns: Sr, Part Number, Item Name, Make, Godown, Rack, Box, Requested Qty, Picked Qty
function printIssueNote(inn, pickingHistory = []) {
  // Picked quantity is derived live from the completed Picking Notes, so a corrected
  // pick is reflected here the next time the note is printed — nothing is snapshotted.
  const processedByKey = {};
  pickingHistory.forEach((pn) => {
    if (!(pn.status === "COMPLETED" || pn.status === "RECORDED")) return;
    (pn.items || []).forEach((it) => {
      const k = pickingKey(it);
      const cur = processedByKey[k] || { picked: 0 };
      cur.picked += parseFloat(it.quantity) || 0;
      processedByKey[k] = cur;
    });
  });
  const actualLocs = issueActualLocations(pickingHistory);
  const rows = [];
  (inn.items || []).forEach((it, idx) => {
    const p = processedByKey[pickingKey(it)] || { picked: 0 };
    // Actual pick locations win over the planned allocation once picking has happened.
    const locs = actualLocs[pickingKey(it)] || it.allocated_locations || [];
    const base = (showItem, godownCell, rackCell, boxCell) => [
      String(idx + 1),
      showItem ? htmlEscape(it.part_no) : "",
      showItem ? htmlEscape(it.description_1 || "") : "",
      showItem ? htmlEscape(it.make || "—") : "",
      godownCell, rackCell, boxCell,
      showItem ? `<span style="text-align:right;display:block">${htmlEscape(it.quantity ?? "Open")}</span>` : "",
      showItem ? `<span style="text-align:right;display:block">${htmlEscape(p.picked || "—")}</span>` : "",
    ];
    if (locs.length === 0) {
      rows.push(base(true, "—", "—", "—"));
    } else {
      locs.forEach((loc, li) => {
        rows.push(base(li === 0, htmlEscape(loc.godown_name || "—"), htmlEscape(loc.rack_no || "—"), htmlEscape(loc.box_no || "—")));
      });
    }
  });
  const html = buildStandardPrintHtml({
    docTitle: "Issue Note",
    docNo: inn.in_no,
    statusLabel: issueStatusLabel(inn.status),
    fieldsLeft: [
      ["Stock Out Type", inn.stock_out_type || "—"],
      ["Issue No", inn.in_no],
      ["Issue Date", fmtDate(inn.in_date)],
      ["Status", issueStatusLabel(inn.status)],
    ],
    fieldsRight: [
      ["Reference Doc", inn.reference_doc_name || "—"],
      ["Reference Doc No", inn.reference_doc_no || "—"],
      ["Reference Doc Date", inn.reference_doc_date ? fmtDate(inn.reference_doc_date) : "—"],
      ["Assigned To", inn.assigned_to_name || inn.assigned_to_email || "—"],
      ["Created By", inn.created_by || "—"],
    ],
    columns: [
      { label: "Sr" }, { label: "Part Number" }, { label: "Item Name" }, { label: "Make" },
      { label: "Godown" }, { label: "Rack" }, { label: "Box" },
      { label: "Requested Qty", align: "right" }, { label: "Picked Qty", align: "right" },
    ],
    rows,
    narration: inn.narration || "",
    printedBy: inn.created_by,
  });
  if (!openPrintWindow(html)) toast.error("Popup blocked — allow popups for this site to print");
}

function buildPickingEditItems(editing, preparedItems) {
  const preparedByLocKey = {};
  const availableByItemKey = {};
  const openByItemKey = {};
  (preparedItems || []).forEach((p) => {
    preparedByLocKey[pickingLocKey(p)] = p;
    const k = pickingKey(p);
    if (!availableByItemKey[k]) availableByItemKey[k] = p.available_locations || [];
    if (p.open_quantity) openByItemKey[k] = true;
  });
  const existing = editing?.items || [];
  if (existing.length) {
    return existing.map((it) => {
      const p = preparedByLocKey[pickingLocKey(it)] || {};
      const k = pickingKey(it);
      const open = !!openByItemKey[k];
      return {
      ...it,
      ...locSelKeys(it),
      row_status: editing?.status === "RECORDED" ? "Picked" : "Draft Pick",
      open_quantity: open,
      pending_qty: open ? null : (p.pending_qty ?? it.pending_qty ?? 0),
      requested_qty: open ? null : (p.requested_qty ?? it.requested_qty ?? 0),
      allocated_qty: p.allocated_qty ?? it.allocated_qty ?? it.quantity ?? 0,
      suggested: p.suggested ?? it.suggested ?? false,
      available_locations: availableByItemKey[k] || it.available_locations || [],
      };
    });
  }
  return (preparedItems || []).map((it) => ({ ...it, ...locSelKeys(it), row_status: "Assigned" }));
}

/* ==============================================================
   STOCK OUT  (Issue Note + Picking Note)
   ============================================================== */
export default function StockOutPage() {
  const [tab, setTab] = useState("issue-note");
  return (
    <div className="p-8 max-w-[1600px] mx-auto" data-testid="stock-out-page">
      <div className="mb-6">
        <h1 className="text-4xl font-black tracking-tight text-slate-900">Stock Out</h1>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="rounded-sm">
          <TabsTrigger value="issue-note" className="rounded-sm" data-testid="tab-issue-note">
            <FileText size={14} weight="bold" className="mr-2" /> Issue Note
          </TabsTrigger>
          <TabsTrigger value="picking-note" className="rounded-sm" data-testid="tab-picking-note">
            <Package size={14} weight="bold" className="mr-2" /> Picking Note
          </TabsTrigger>
        </TabsList>
        <TabsContent value="issue-note"><IssueNoteTab /></TabsContent>
        <TabsContent value="picking-note"><PickingNoteTab /></TabsContent>
      </Tabs>
    </div>
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

/* =========================== ISSUE NOTE TAB =========================== */
function IssueNoteTab() {
  const [view, setView] = useState("list");
  const [editing, setEditing] = useState(null);
  const [openIn, setOpenIn] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const goCreate = () => { setEditing(null); setView("create"); };
  const goEdit = (i) => { setEditing(i); setView("edit"); };
  const goList = () => { setEditing(null); setView("list"); setReloadKey((k) => k + 1); };

  return (
    <>
      {view === "list" && <IssueNoteList reloadKey={reloadKey} onCreate={goCreate} onEdit={goEdit} onOpen={setOpenIn} />}
      {(view === "create" || view === "edit") && <IssueNoteForm editing={editing} onCancel={goList} onSaved={goList} />}
      <IssueNoteDetailDialog inn={openIn} onClose={() => setOpenIn(null)} />
    </>
  );
}

function IssueNoteList({ reloadKey, onCreate, onEdit, onOpen }) {
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
      const res = await api.get("/issue-notes", { params: { page, page_size: PAGE_SIZE, search: search || undefined } });
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

  const handleDelete = async (inn) => {
    if (!window.confirm(`Delete ${inn.in_no}?`)) return;
    try {
      await api.delete(`/issue-notes/${inn.id}`);
      toast.success(`${inn.in_no} deleted`);
      load();
    } catch (err) { toast.error(formatApiError(err.response?.data?.detail) || "Could not delete"); }
  };

  const statusLabel = (r) => issueStatusLabel(r.status);

  const columns = useMemo(() => [
    { key: "stock_out_type", label: "STOCK OUT TYPE", value: (r) => r.stock_out_type || "" },
    { key: "in_date", label: "ISSUE NOTE DATE", value: (r) => fmtDate(r.in_date) },
    { key: "in_no", label: "ISSUE NOTE NO", value: (r) => r.in_no || "" },
    { key: "reference_doc_name", label: "REFERENCE DOCUMENT NAME", value: (r) => r.reference_doc_name || "" },
    { key: "reference_doc_date", label: "REFERENCE DOCUMENT DATE", value: (r) => (r.reference_doc_date ? fmtDate(r.reference_doc_date) : "") },
    { key: "reference_doc_no", label: "REFERENCE DOCUMENT NO", value: (r) => r.reference_doc_no || "" },
    { key: "status", label: "STATUS", value: statusLabel },
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
    exportToExcel(filteredRows, exportCols, `Issue_Notes_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="mt-4" data-testid="in-list-view">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input
            ref={searchInputRef}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search issue notes…"
            className="rounded-sm font-mono h-9 pl-10 w-full"
            data-testid="in-search-input"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleExport} variant="outline" className="rounded-sm border-slate-300" data-testid="in-export-button">
            <DownloadSimple size={14} weight="bold" className="mr-2" /> Export
          </Button>
          <Button onClick={load} variant="outline" className="rounded-sm border-slate-300" disabled={loading} data-testid="in-refresh-button">
            <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button onClick={onCreate} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="create-in-button">
            <Plus size={16} weight="bold" className="mr-2" /> Create New Issue Note
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-between mb-3 text-xs text-slate-600">
  <div>
    {total === 0 ? "No issue notes" : (
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
      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto overflow-visible">
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
              <th className="!text-left">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r, idx) => {
              // Editable only until the first quantity is picked/rejected — matches the
              // backend rule (a picking note with processed qty flips status off Pending).
              const hasPicking = issueHasProcessed(r.status);
              const lockedToOther = !!r.assigned_to_user_id && r.assigned_to_user_id !== me?.id && !isAdmin;
              const lock = hasPicking || lockedToOther;
              const editTitle = hasPicking ? "Cannot edit — picking has already started"
                : (lockedToOther ? `Locked — assigned to ${r.assigned_to_name || r.assigned_to_email}` : "Edit");
              const deleteTitle = hasPicking ? "Cannot delete — picking has already started"
                : (lockedToOther ? `Locked — assigned to ${r.assigned_to_name || r.assigned_to_email}` : "Delete");
              const label = statusLabel(r);
              const cls = issueStatusClass(r.status);
              return (
                <tr key={r.id} data-testid={`in-row-${r.in_no}`}>
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td className="text-slate-700" data-testid={`in-type-${r.in_no}`}>{r.stock_out_type || "—"}</td>
                  <td className="font-mono text-slate-700">{fmtDate(r.in_date)}</td>
                  <td>
                    <button onClick={() => onOpen(r)} className="font-mono font-semibold text-blue-700 hover:underline" data-testid={`in-open-${r.in_no}`}>
                      {r.in_no}
                    </button>
                  </td>
                  <td className="text-slate-700 max-w-[220px] truncate" title={r.reference_doc_name || ""}>{r.reference_doc_name || "—"}</td>
                  <td className="font-mono text-slate-700">{r.reference_doc_date ? fmtDate(r.reference_doc_date) : "—"}</td>
                  <td className="font-mono text-slate-700">{r.reference_doc_no || "—"}</td>
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${cls}`} data-testid={`in-status-${r.in_no}`}>{label}</span>
                  </td>
                  <td className="text-left whitespace-nowrap">
                    <button onClick={() => onEdit(r)} disabled={lock}
                      title={editTitle}
                      className={`p-1.5 rounded-sm mr-1 ${lock ? "text-slate-300 cursor-not-allowed" : "hover:bg-slate-100"}`}
                      data-testid={`in-edit-${r.in_no}`}>
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => handleDelete(r)} disabled={lock}
                      title={deleteTitle}
                      className={`p-1.5 rounded-sm ${lock ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                      data-testid={`in-delete-${r.in_no}`}>
                      <Trash size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && (
              <tr><td colSpan={columns.length + 2} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? "No issue notes. Click 'Create New Issue Note' to begin." : "No rows match the current filters.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function IssueNoteDetailDialog({ inn, onClose }) {
  const [history, setHistory] = useState([]);
  const actualLocs = useMemo(() => issueActualLocations(history), [history]);

  useEffect(() => {
    if (!inn?.id) {
      setHistory([]);
      return;
    }
    api.get("/picking-notes", { params: { issue_note_id: inn.id, page_size: 100 } })
      .then((r) => setHistory(r.data || []))
      .catch(() => setHistory([]));
  }, [inn?.id]);

  return (
    <Dialog open={!!inn} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto rounded-sm" data-testid="in-detail-dialog">
        {inn && (
          <>
            <div className="text-center text-xl font-black tracking-widest uppercase pt-1 pb-2 border-b border-slate-200">
              ISSUE NOTE
            </div>
            <div className="grid grid-cols-2 gap-6 text-sm pt-3 pb-4 border-b border-slate-200">
              <div className="space-y-2">
                <Detail k="STOCK OUT TYPE" v={inn.stock_out_type || "—"} />
                <Detail k="ISSUE NOTE DATE" v={fmtDate(inn.in_date)} />
                <Detail k="ISSUE NOTE NO" v={inn.in_no} />
                <Detail k="REFERENCE DOCUMENT NAME" v={inn.reference_doc_name || "—"} />
                <Detail k="REFERENCE DOCUMENT DATE" v={inn.reference_doc_date ? fmtDate(inn.reference_doc_date) : "—"} />
                <Detail k="REFERENCE DOCUMENT NO" v={inn.reference_doc_no || "—"} />
                <Detail k="STATUS" v={
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${issueStatusClass(inn.status)}`}>
                    {issueStatusLabel(inn.status)}
                  </span>
                } />
              </div>
              <div className="space-y-2">
                <Detail k="CREATED BY" v={inn.created_by || "—"} />
                <Detail k="CREATED AT" v={inn.created_at ? new Date(inn.created_at).toLocaleString() : "—"} />
                <div>
                  <div className="label-sm">ASSIGNED TO</div>
                  <div className="mt-1"><AssigneeBadge name={inn.assigned_to_name} email={inn.assigned_to_email} /></div>
                </div>
              </div>
            </div>
            {inn.narration && (
              <div className="pt-3 pb-1 border-b border-slate-200">
                <div className="label-sm mb-1">NARRATION</div>
                <div className="text-sm text-slate-700 whitespace-pre-wrap">{inn.narration}</div>
              </div>
            )}
            <div className="mt-2">
              <div className="label-sm mb-2">Items ({(inn.items || []).length})</div>
              <div className="overflow-x-auto">
                <table className="data-table w-full">
                  <thead>
                    <tr>
                      <th className="w-14">SL</th><th className="w-28">MODEL</th><th>PART NO</th><th>MAKE</th><th>DESCRIPTION</th>
                      <th>GODOWN</th><th>RACK</th><th>BOX</th>
                      <th className="text-center">QTY</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(inn.items || []).flatMap((it, idx) => {
                      // Same rule as the print: show where stock was actually picked
                      // from once picking is done, else the planned allocation.
                      const locs = actualLocs[pickingKey(it)] || it.allocated_locations || [];
                      if (locs.length === 0) {
                        return [(
                          <tr key={`${idx}-none`}>
                            <td className="font-mono text-slate-500">{idx + 1}</td>
                            <td className="text-slate-700">{it.model || "—"}</td>
                            <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                            <td>{it.make}</td>
                            <td className="text-slate-700">{it.description_1 || "—"}</td>
                            <td colSpan={3} className="text-slate-400 italic">
                              {it.quantity == null ? "Quantity & location decided at picking" : "No stock currently available"}
                            </td>
                            <td className="text-center font-mono font-bold">
                              {it.quantity == null ? <span className="text-blue-700">Open</span> : it.quantity}
                            </td>
                          </tr>
                        )];
                      }
                      return locs.map((loc, li) => (
                        <tr key={`${idx}-${li}`}>
                          <td className="font-mono text-slate-500">{idx + 1}{locs.length > 1 ? `.${li + 1}` : ""}</td>
                          <td className="text-slate-700">{li === 0 ? (it.model || "—") : ""}</td>
                          <td>{li === 0 ? <PartNoLink partNo={it.part_no} make={it.make} /> : ""}</td>
                          <td>{li === 0 ? it.make : ""}</td>
                          <td className="text-slate-700">{li === 0 ? (it.description_1 || "—") : ""}</td>
                          <td className="font-mono">{loc.godown_name || "—"}</td>
                          <td className="font-mono">{loc.rack_no || "—"}</td>
                          <td className="font-mono">{loc.box_no || "—"}</td>
                          <td className="text-center font-mono font-bold">{loc.quantity}</td>
                        </tr>
                      ));
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="mt-6 border-t border-slate-200 pt-4">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-700 mb-2 pb-1 border-b border-slate-200">Picking History</div>
              <table className="data-table w-full text-xs">
                <thead>
                  <tr><th>PN NO</th><th>PARENT PN</th><th className="text-center">REQUESTED</th><th className="text-center">PICKED</th><th>STATUS</th></tr>
                </thead>
                <tbody>
                  {[...history].sort((a, b) => (a.serial || 0) - (b.serial || 0)).map((pn) => {
                    const label = pickingNoteStatusLabel(pn.status);
                    const parent = history.find((h) => h.id === pn.parent_picking_note_id);
                    return (
                      <tr key={pn.id}>
                        <td className="font-mono font-semibold">{pn.pn_no}</td>
                        <td className="font-mono">{parent?.pn_no || "—"}</td>
                        <td className="text-center font-mono font-bold">{pickingAssignedQty(pn) || "—"}</td>
                        <td className="text-center font-mono font-bold">{pickingPickedQty(pn)}</td>
                        <td>
                          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${label === "Completed" ? "bg-green-100 text-green-800" : (label === "Pending" ? "bg-blue-50 text-blue-800" : "bg-amber-50 text-amber-700")}`}>
                            {label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {history.length === 0 && (
                    <tr><td colSpan={5} className="text-center py-6 text-slate-500">No picking notes yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-2 pt-4 border-t border-slate-200 mt-6">
              <Button variant="outline" size="sm" className="rounded-sm" onClick={() => printIssueNote(inn, history)} data-testid="in-detail-print">
                <Printer size={14} weight="bold" className="mr-1.5" /> Print
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const emptyIssueItem = () => ({
  part_no: "",
  make: "",
  quantity: "",
  description_1: "",
  model: "",
  selected_godown_id: null,
  selected_godown_name: null,
  godowns: [],
  makes: [],
  partLooked: false,
  available_qty: 0,
});

function IssueNoteForm({ editing, onCancel, onSaved }) {
  const isEdit = !!editing;
  const isDraftEdit = isEdit && editing.status === "DRAFT";
  const isFinalEdit = isEdit && !isDraftEdit;
  const [inNo, setInNo] = useState("");
  const [inDate, setInDate] = useState("");
  const [stockOutType, setStockOutType] = useState("");
  const [stockOutTypes, setStockOutTypes] = useState([]);
  const [newTypeOpen, setNewTypeOpen] = useState(false);
  const [newTypeName, setNewTypeName] = useState("");
  const [creatingType, setCreatingType] = useState(false);
  const [refDocName, setRefDocName] = useState("");
  const [refDocDate, setRefDocDate] = useState("");
  const [refDocNo, setRefDocNo] = useState("");
  const [items, setItems] = useState([emptyIssueItem()]);
  const [narration, setNarration] = useState("");
  const [addCount, setAddCount] = useState("");
  const [savingDraft, setSavingDraft] = useState(false);
  const [savingFinal, setSavingFinal] = useState(false);
  const [assignedToUserId, setAssignedToUserId] = useState("");
  const fileInputRef = useRef(null);

  const loadStockOutTypes = useCallback(async () => {
    try {
      const { data } = await api.get("/stock-out-types");
      setStockOutTypes(data || []);
    } catch { /* dropdown just stays empty */ }
  }, []);
  useEffect(() => { loadStockOutTypes(); }, [loadStockOutTypes]);

  const createStockOutType = async () => {
    const name = newTypeName.trim();
    if (!name) { toast.error("Enter a type name"); return; }
    setCreatingType(true);
    try {
      const { data } = await api.post("/stock-out-types", { name });
      await loadStockOutTypes();
      setStockOutType(data.name);
      setNewTypeName("");
      setNewTypeOpen(false);
      toast.success(`Stock Out Type '${data.name}' created`);
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not create type");
    } finally { setCreatingType(false); }
  };

  useEffect(() => {
    if (isEdit) {
      setInNo(editing.in_no || "");
      setInDate(editing.in_date || "");
      setStockOutType(editing.stock_out_type || "");
      setRefDocName(editing.reference_doc_name || "");
      setRefDocDate(editing.reference_doc_date || "");
      setRefDocNo(editing.reference_doc_no || "");
      setAssignedToUserId(editing.assigned_to_user_id || "");
      setNarration(editing.narration || "");
      const initial = (editing.items || []).map((it) => ({
        part_no: it.part_no || "", make: it.make || "", quantity: it.quantity ?? "",
        description_1: it.description_1 || "",
        model: it.model || "",
        selected_godown_id: it.selected_godown_id || null,
        selected_godown_name: it.selected_godown_name || null,
        godowns: it.selected_godown_id ? [{
          godown_id: it.selected_godown_id,
          godown_name: it.selected_godown_name || "",
          available_qty: 0,
        }] : [],
        makes: it.make ? [{ make: it.make, available_qty: 0 }] : [], partLooked: !!it.part_no, available_qty: 0,
      }));
      setItems(initial.length ? initial : [emptyIssueItem()]);
      // Refresh stock-aware makes list per row
      initial.forEach((row, idx) => {
        if (!row.part_no) return;
        api.get(`/issue-notes/lookup/${encodeURIComponent(row.part_no)}`)
          .then(({ data }) => {
            const makesArr = data.makes || [];
            const found = makesArr.find((m) => m.make === row.make);
            setItems((prev) => prev.map((r, i) => i === idx ? {
              ...r, makes: makesArr, available_qty: found?.available_qty || 0,
              description_1: r.description_1 || found?.description_1 || "",
              model: r.model || found?.model || "",
            } : r));
            if (row.make) loadIssueGodowns(idx, row.part_no, row.make, row.selected_godown_id);
          })
          .catch(() => {});
      });
    } else {
      api.get("/issue-notes/next-no").then((r) => { setInNo(r.data.next_in_no); setInDate(r.data.in_date); })
        .catch(() => toast.error("Could not preview issue-note number"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, editing]);

  // Same semantics as Receipt Note's Add Row: the count box means "I want N rows in
  // total from here", so one row already on screen counts toward N.
  const addItems = () => {
    let n = Math.max(1, Math.min(500, parseInt(addCount, 10) || 1));
    if (addCount && parseInt(addCount, 10) > 0) {
      n = Math.max(1, n - 1);
    }
    setItems((p) => [...p, ...Array.from({ length: n }, emptyIssueItem)]);
    setAddCount("");
  };
  const insertItemAfter = (i) => setItems((p) => {
    const next = [...p];
    next.splice(i + 1, 0, emptyIssueItem());
    return next;
  });
  const removeItem = (i) => setItems((p) => (p.length === 1 ? p : p.filter((_, idx) => idx !== i)));
  const updateItem = (i, patch) => setItems((p) => p.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  const loadIssueGodowns = async (i, partNo, makeVal, keepGodownId = null) => {
    const p = (partNo || "").trim();
    const m = (makeVal || "").trim();
    if (!p || !m) {
      updateItem(i, { godowns: [], selected_godown_id: null, selected_godown_name: null });
      return;
    }
    try {
      const { data } = await api.get(`/issue-notes/lookup/${encodeURIComponent(p)}/godowns`, { params: { make: m } });
      const list = data.godowns || [];
      const kept = keepGodownId ? list.find((g) => g.godown_id === keepGodownId) : null;
      const auto = kept || (list.length === 1 ? list[0] : null);
      updateItem(i, {
        godowns: list,
        selected_godown_id: auto ? auto.godown_id : null,
        selected_godown_name: auto ? auto.godown_name : null,
      });
    } catch {
      updateItem(i, { godowns: [], selected_godown_id: null, selected_godown_name: null });
    }
  };

  const lookupMakes = async (i, partNo) => {
    const v = (partNo || "").trim();
    if (!v) { updateItem(i, { makes: [], make: "", description_1: "", model: "", partLooked: false, available_qty: 0, godowns: [], selected_godown_id: null, selected_godown_name: null }); return; }
    try {
      const { data } = await api.get(`/issue-notes/lookup/${encodeURIComponent(v)}`);
      const list = data.makes || [];
      const auto = list.length === 1 ? list[0] : null;
      updateItem(i, {
        makes: list, partLooked: true,
        make: auto ? auto.make : "",
        available_qty: auto ? auto.available_qty : 0,
        description_1: auto ? (auto.description_1 || "") : "",
        model: auto ? (auto.model || "") : "",
        godowns: [],
        selected_godown_id: null,
        selected_godown_name: null,
      });
      if (auto) loadIssueGodowns(i, v, auto.make);
    } catch { updateItem(i, { makes: [], partLooked: true, make: "", description_1: "", model: "", available_qty: 0 }); }
  };

  const onMakeChange = (i, makeVal) => {
    const row = items[i];
    const found = (row.makes || []).find((m) => m.make === makeVal);
    updateItem(i, {
      make: makeVal, available_qty: found?.available_qty || 0,
      description_1: found?.description_1 || "",
      model: found?.model || "",
      godowns: [], selected_godown_id: null, selected_godown_name: null,
    });
    loadIssueGodowns(i, row.part_no, makeVal);
  };

  const onIssueGodownChange = (i, gid) => {
    if (gid === NO_GODOWN) {
      updateItem(i, { selected_godown_id: null, selected_godown_name: null });
      return;
    }
    const row = items[i];
    const found = (row.godowns || []).find((g) => g.godown_id === gid);
    // Narrowing to a godown can shrink the pool below what's already typed — pull the
    // quantity down with it rather than leaving an unsavable number on screen.
    const cap = found?.available_qty ?? 0;
    const typed = parseInt(row.quantity);
    updateItem(i, {
      selected_godown_id: found?.godown_id || null,
      selected_godown_name: found?.godown_name || null,
      ...(found && !isNaN(typed) && typed > cap ? { quantity: String(cap) } : {}),
    });
  };

  // Sum requested qty per (part_no, make) across all rows so multiple rows of the same part/make
  // are validated together (mirrors backend aggregation).
  const requestedByKey = useMemo(() => {
    const m = {};
    items.forEach((r) => {
      if (!r.part_no || !r.make || isOpenQty(r)) return;
      const k = `${r.part_no}||${r.make}`;
      m[k] = (m[k] || 0) + (parseInt(r.quantity) || 0);
    });
    return m;
  }, [items]);

  const requestedByGodownKey = useMemo(() => {
    const m = {};
    items.forEach((r) => {
      if (!r.part_no || !r.make || !r.selected_godown_id || isOpenQty(r)) return;
      const k = `${r.part_no}||${r.make}||${r.selected_godown_id}`;
      m[k] = (m[k] || 0) + (parseInt(r.quantity) || 0);
    });
    return m;
  }, [items]);

  // Hard ceiling for a row's Quantity: live stock for that part/make — narrowed to the
  // selected godown when one is chosen — minus whatever the other rows already claim
  // from the same pool. Mirrors the backend's aggregate check, applied as you type so
  // an impossible number can never be entered in the first place.
  const maxQtyForRow = (idx) => {
    const row = items[idx];
    if (!row?.part_no || !row?.make) return 0;
    const selected = (row.godowns || []).find((g) => g.godown_id === row.selected_godown_id);
    const pool = row.selected_godown_id && selected ? (selected.available_qty || 0) : (row.available_qty || 0);
    const claimedByOthers = items.reduce((sum, r, i) => {
      if (i === idx || r.part_no !== row.part_no || r.make !== row.make) return sum;
      // A row scoped to a godown only competes with other rows on that same godown.
      if (row.selected_godown_id && r.selected_godown_id !== row.selected_godown_id) return sum;
      return sum + (parseInt(r.quantity) || 0);
    }, 0);
    return Math.max(0, pool - claimedByOthers);
  };

  const onQtyChange = (idx, raw) => {
    if (raw === "") { updateItem(idx, { quantity: "" }); return; }   // blank = open line
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 0) return;
    const cap = maxQtyForRow(idx);
    updateItem(idx, { quantity: String(Math.min(n, cap)) });
  };

  const validateRows = () => {
    if (items.length === 0) { toast.error("Add at least one item"); return false; }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.part_no.trim()) { toast.error(`Row ${i + 1}: Part No required`); return false; }
      if (!it.make.trim()) { toast.error(`Row ${i + 1}: Make required`); return false; }
      // Quantity is optional — a blank means "store incharge decides at picking time".
      if (isOpenQty(it)) continue;
      const q = parseInt(it.quantity);
      if (isNaN(q) || q <= 0) { toast.error(`Row ${i + 1}: Quantity must be > 0, or leave it blank for the store incharge`); return false; }
      if (q > (it.available_qty || 0) + 1e-6) {
        toast.error(`Row ${i + 1}: ${it.part_no}/${it.make} — only ${it.available_qty} in stock, cannot issue ${q}`);
        return false;
      }
      if (it.selected_godown_id) {
        const selected = (it.godowns || []).find((g) => g.godown_id === it.selected_godown_id);
        if (selected && q > (selected.available_qty || 0) + 1e-6) {
          toast.error(`Row ${i + 1}: ${it.part_no}/${it.make} — only ${selected.available_qty || 0} in ${it.selected_godown_name || "selected godown"}, cannot issue ${q}`);
          return false;
        }
      }
    }
    // Cross-row aggregation: sum of qty across rows for same (part,make) must not exceed available
    for (const [k, total] of Object.entries(requestedByKey)) {
      const [p, m] = k.split("||");
      const row = items.find((r) => r.part_no === p && r.make === m);
      const avail = row?.available_qty || 0;
      if (total > avail + 1e-6) {
        toast.error(`${p}/${m}: total requested across rows is ${total} but only ${avail} in stock`);
        return false;
      }
    }
    for (const [k, total] of Object.entries(requestedByGodownKey)) {
      const [p, m, gid] = k.split("||");
      const row = items.find((r) => r.part_no === p && r.make === m && r.selected_godown_id === gid);
      const selected = (row?.godowns || []).find((g) => g.godown_id === gid);
      if (selected && total > (selected.available_qty || 0) + 1e-6) {
        toast.error(`${p}/${m}: total requested from ${selected.godown_name || "selected godown"} is ${total} but only ${selected.available_qty || 0} is available there`);
        return false;
      }
    }
    return true;
  };

  // Mirrors Receipt Note: Final Save needs an identified item on every row; Quantity is
  // explicitly not part of this — a blank quantity is a valid, intentional state.
  const canFinalize = items.length > 0 && items.every((it) => it.part_no.trim() && it.make.trim());

  const buildPayload = (asDraft) => ({
    stock_out_type: stockOutType || "",
    reference_doc_name: refDocName.trim(),
    reference_doc_date: refDocDate || "",
    reference_doc_no: refDocNo.trim(),
    assigned_to_user_id: assignedToUserId || null,
    narration: narration.trim(),
    save_as_draft: asDraft,
    items: items.map((it) => ({
      part_no: it.part_no.trim(),
      make: it.make.trim(),
      // null (not 0) marks an open quantity for the store incharge to fill in.
      quantity: isOpenQty(it) ? null : parseInt(it.quantity),
      description_1: it.description_1 || "",
      selected_godown_id: it.selected_godown_id || null,
      selected_godown_name: it.selected_godown_name || null,
    })),
  });

  const saveDraft = async () => {
    if (!validateRows()) return;
    setSavingDraft(true);
    try {
      const payload = buildPayload(true);
      const { data } = isEdit
        ? await api.put(`/issue-notes/${editing.id}`, payload)
        : await api.post("/issue-notes", payload);
      toast.success(`Draft saved · ${data.in_no}`);
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save draft");
    } finally { setSavingDraft(false); }
  };

  const saveFinal = async () => {
    if (!validateRows()) return;
    setSavingFinal(true);
    try {
      const payload = buildPayload(false);
      let inId, inNoDisplay;
      if (isEdit) {
        const { data } = await api.put(`/issue-notes/${editing.id}`, payload);
        inId = data.id; inNoDisplay = data.in_no;
        if (isDraftEdit) {
          await api.post(`/issue-notes/${inId}/finalize`);
          toast.success(`Issue Note ${inNoDisplay} finalized — picking pending`);
        } else {
          toast.success(`Issue Note ${inNoDisplay} updated`);
        }
      } else {
        const { data } = await api.post("/issue-notes", payload);
        inNoDisplay = data.in_no;
        toast.success(`Issue Note ${inNoDisplay} saved — picking pending`);
      }
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save");
    } finally { setSavingFinal(false); }
  };

  const handleDownloadTemplate = () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Part No", "Make", "Quantity", "Godown Preference"],
      ["EXAMPLE-001", "ACME", 5, ""],
      // Blank Quantity is valid — imports as an open line for the store incharge.
      ["EXAMPLE-002", "ACME", "", ""],
      ["", "", "", ""],
    ]);
    ws["!cols"] = [{ wch: 18 }, { wch: 16 }, { wch: 12 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Issue Note Template");
    XLSX.writeFile(wb, "Issue_Note_Template.xlsx");
    toast.success("Template downloaded");
  };

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
        const make = String(pickCol(row, ["make"]) || "").trim();
        const qtyRaw = pickCol(row, ["quantity", "qty", "requested quantity", "requested_qty"]);
        const godownPref = String(pickCol(row, ["godown preference", "godown", "godown_preference"]) || "").trim();
        if (!part_no && (qtyRaw === "" || qtyRaw == null)) continue;
        if (!part_no) { toast.error("Skipped row — Part No missing"); continue; }
        // Blank Quantity is imported as an open line (store incharge fills it in).
        const blankQty = qtyRaw === "" || qtyRaw == null;
        const qty = blankQty ? "" : parseInt(qtyRaw);
        if (!blankQty && (isNaN(qty) || qty <= 0)) { toast.error(`Row for ${part_no} skipped — Quantity must be > 0 or blank`); continue; }
        newRows.push({
          ...emptyIssueItem(),
          part_no, make, quantity: qty, _godownPrefName: godownPref,
          // Stable id to re-find this exact row across the two chained async lookups
          // below — matching by object reference breaks once the first lookup's
          // setItems() has already replaced the row with a new object (which is
          // what was happening: the godown lookup's setItems could never find its
          // row again, so `godowns` never got populated and the Godown Preference
          // dropdown stayed permanently disabled after an import).
          _importId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        });
      }
      if (!newRows.length) { toast.error("No valid rows found in file"); return; }
      setItems((prev) => {
        const onlyEmpty = prev.length === 1 && !prev[0].part_no && !prev[0].quantity;
        return onlyEmpty ? newRows : [...prev, ...newRows];
      });
      newRows.forEach((row) => {
        const importId = row._importId;
        setTimeout(() => {
          api.get(`/issue-notes/lookup/${encodeURIComponent(row.part_no)}`)
            .then(({ data }) => {
              const list = data.makes || [];
              const matched = row.make ? list.find((m) => m.make === row.make) : (list.length === 1 ? list[0] : null);
              setItems((prev) => prev.map((r) => {
                if (r._importId !== importId) return r;
                const avail = matched ? matched.available_qty : 0;
                const typed = parseInt(r.quantity);
                return {
                  ...r, makes: list, partLooked: true,
                  make: matched ? matched.make : row.make,
                  available_qty: avail,
                  // A spreadsheet can ask for more than exists — cap it on arrival so the
                  // grid never holds a quantity the user could not have typed by hand.
                  quantity: !isNaN(typed) && typed > avail ? String(avail) : r.quantity,
                  description_1: matched ? (matched.description_1 || "") : "",
                  model: matched ? (matched.model || "") : "",
                };
              }));
              if (matched) {
                api.get(`/issue-notes/lookup/${encodeURIComponent(row.part_no)}/godowns`, { params: { make: matched.make } })
                  .then(({ data: gd }) => {
                    const glist = gd.godowns || [];
                    const gmatch = row._godownPrefName
                      ? glist.find((g) => g.godown_name.toLowerCase() === row._godownPrefName.toLowerCase())
                      : (glist.length === 1 ? glist[0] : null);
                    setItems((prev) => prev.map((r) => r._importId !== importId ? r : {
                      ...r, godowns: glist,
                      selected_godown_id: gmatch ? gmatch.godown_id : null,
                      selected_godown_name: gmatch ? gmatch.godown_name : null,
                    }));
                  }).catch(() => {});
              }
            })
            .catch(() => {
              setItems((prev) => prev.map((r) => r._importId !== importId ? r : { ...r, partLooked: true }));
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

  return (
    <div className="mt-4 space-y-6" data-testid="in-create-view">
      <div className="flex items-center justify-between">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="in-back-button">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
        {isDraftEdit && (
          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm bg-slate-100 text-slate-600">Draft</span>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-sm p-6 grid grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <Label className="label-sm">Stock Out Type</Label>
          <div className="flex items-center gap-2 mt-2">
            <Select value={stockOutType || undefined} onValueChange={setStockOutType}>
              <SelectTrigger className="rounded-sm min-w-0 flex-1" data-testid="in-stock-out-type">
                <SelectValue placeholder={stockOutTypes.length === 0 ? "No types yet — create one" : "Select type"} />
              </SelectTrigger>
              <SelectContent>
                {stockOutTypes.map((t) => (
                  <SelectItem key={t.id} value={t.name} data-testid={`in-stock-out-type-option-${t.name}`}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              className="rounded-sm border-slate-300 shrink-0 px-2"
              onClick={() => setNewTypeOpen(true)}
              title="Create a new Stock Out Type"
              data-testid="in-stock-out-type-new"
            >
              <Plus size={14} weight="bold" />
            </Button>
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Shared list · reused on every Issue Note</div>
        </div>
        <div>
          <Label className="label-sm">Issue Note Date</Label>
          <Input value={inDate} disabled className="mt-2 rounded-sm font-mono bg-slate-50" data-testid="in-date-input" />
          <div className="text-[11px] text-slate-500 mt-1">Auto · today's date</div>
        </div>
        <div>
          <Label className="label-sm">Issue Note No</Label>
          <Input value={inNo} disabled className="mt-2 rounded-sm font-mono font-semibold bg-blue-50 text-blue-900" data-testid="in-no-input" />
          <div className="text-[11px] text-slate-500 mt-1">Auto · resets each FY</div>
        </div>
        <div>
          <Label className="label-sm">Reference Document Name</Label>
          <Input
            value={refDocName}
            onChange={(e) => setRefDocName(e.target.value)}
            placeholder="e.g. Sales Order"
            className="mt-2 rounded-sm font-mono"
            data-testid="in-ref-doc-name"
          />
          <div className="text-[11px] text-slate-500 mt-1">Optional</div>
        </div>
        <div>
          <Label className="label-sm">Reference Document Date</Label>
          <Input
            type="date"
            value={refDocDate}
            onChange={(e) => setRefDocDate(e.target.value)}
            className="mt-2 rounded-sm font-mono"
            data-testid="in-ref-doc-date"
          />
          <div className="text-[11px] text-slate-500 mt-1">Optional</div>
        </div>
        <div>
          <Label className="label-sm">Reference Document No</Label>
          <Input
            value={refDocNo}
            onChange={(e) => setRefDocNo(e.target.value)}
            placeholder="e.g. SO-1024"
            className="mt-2 rounded-sm font-mono"
            data-testid="in-ref-doc-no"
          />
          <div className="text-[11px] text-slate-500 mt-1">Optional</div>
        </div>
        <div className="col-span-2 lg:col-span-3">
          <AssigneeSelect
            value={assignedToUserId}
            onChange={setAssignedToUserId}
            module="stock_out"
            testid="in-assignee"
          />
        </div>
      </div>

      {/* CREATE STOCK OUT TYPE */}
      <Dialog open={newTypeOpen} onOpenChange={(o) => { if (!o) { setNewTypeOpen(false); setNewTypeName(""); } }}>
        <DialogContent className="max-w-md rounded-sm" data-testid="in-new-type-dialog">
          <div className="text-lg font-black tracking-tight text-slate-900">New Stock Out Type</div>
          <div className="text-xs text-slate-500 -mt-2">
            Created once and reused everywhere, so the same classification is always spelled the same way.
          </div>
          <div className="mt-2">
            <Label className="label-sm">Type Name</Label>
            <Input
              autoFocus
              value={newTypeName}
              onChange={(e) => setNewTypeName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); createStockOutType(); } }}
              placeholder="e.g. Sample, Warranty Replacement"
              className="mt-2 rounded-sm font-mono"
              data-testid="in-new-type-name"
            />
          </div>
          <div className="flex items-center justify-end gap-2 pt-4">
            <Button variant="outline" className="rounded-sm" onClick={() => { setNewTypeOpen(false); setNewTypeName(""); }}>
              Cancel
            </Button>
            <Button
              className="rounded-sm bg-blue-700 hover:bg-blue-800"
              onClick={createStockOutType}
              disabled={creatingType}
              data-testid="in-new-type-save"
            >
              {creatingType ? "Creating…" : "Create Type"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div className="bg-white border border-slate-200 rounded-sm">
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <div>
            <div className="label-sm">Items Requested</div>
            <div className="text-xs text-slate-500 mt-0.5">{items.length} row{items.length !== 1 ? "s" : ""}</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => handleExcelImport(e.target.files?.[0])}
              className="hidden"
              data-testid="in-excel-input"
            />
            <Button
              onClick={handleDownloadTemplate}
              variant="outline"
              className="rounded-sm border-slate-300"
              data-testid="in-excel-template-button"
              title="Download an empty Excel template (Part No, Make, Quantity, Godown Preference)"
            >
              <DownloadSimple size={16} weight="bold" className="mr-2" /> Download Template
            </Button>
            <Button
              onClick={() => fileInputRef.current?.click()}
              variant="outline"
              className="rounded-sm border-slate-300"
              data-testid="in-excel-import-button"
              title="Columns: Part No, Make, Quantity, Godown Preference"
            >
              <UploadSimple size={16} weight="bold" className="mr-2" /> Import Excel
            </Button>
            <Input
              type="number"
              min="1"
              max="500"
              value={addCount}
              onChange={(e) => setAddCount(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addItems(); } }}
              placeholder="Qty"
              className="rounded-sm font-mono h-9 w-24 text-center"
              data-testid="in-add-row-count"
              title="Number of rows to add at once (default 1)"
            />
            <Button onClick={addItems} variant="outline" className="rounded-sm border-slate-300" data-testid="in-add-row-button">
              <Plus size={16} weight="bold" className="mr-2" /> Add Row{addCount && parseInt(addCount, 10) > 1 ? "s" : ""}
            </Button>
          </div>
        </div>

        {/* Fixed column widths (table-layout:fixed + colgroup): every control keeps the
            same footprint whether or not it holds a value, so rows never reflow as the
            user types. Description takes whatever width is left over. */}
        <div className="overflow-x-auto">
        <table className="data-table data-table-fixed w-full min-w-[1100px]">
          <colgroup>
            <col style={{ width: "56px" }} />
            <col style={{ width: "120px" }} />
            <col style={{ width: "180px" }} />
            <col />
            <col style={{ width: "160px" }} />
            <col style={{ width: "130px" }} />
            <col style={{ width: "180px" }} />
            <col style={{ width: "84px" }} />
          </colgroup>
          <thead>
            <tr><th>SL NO</th><th>MODEL</th><th>PART NO</th><th>DESCRIPTION</th><th>MAKE</th><th className="!text-center">QUANTITY</th><th>GODOWN PREFERENCE</th><th></th></tr>
          </thead>
          <tbody>
            {items.map((it, idx) => {
              const openQty = isOpenQty(it);
              const overStock = !openQty && it.available_qty !== undefined && (parseInt(it.quantity) || 0) > (it.available_qty || 0) + 1e-6;
              const selectedGodown = (it.godowns || []).find((g) => g.godown_id === it.selected_godown_id);
              const overGodown = !openQty && !!it.selected_godown_id && selectedGodown && (parseInt(it.quantity) || 0) > (selectedGodown.available_qty || 0) + 1e-6;
              const rowCap = maxQtyForRow(idx);
              const atCap = !openQty && rowCap > 0 && (parseInt(it.quantity) || 0) === rowCap;
              return (
              <tr key={idx} data-testid={`in-item-row-${idx}`} className={(overStock || overGodown) ? "bg-red-50" : ""}>
                <td className="font-mono text-slate-500 align-middle">{idx + 1}</td>
                <td className="align-middle">
                  <div
                    className="h-8 flex items-center text-xs text-slate-700 px-2 bg-slate-50 rounded-sm border border-slate-200 overflow-hidden whitespace-nowrap text-ellipsis"
                    title={it.model || "—"}
                    data-testid={`in-model-${idx}`}
                  >
                    <span className="truncate">{it.model || <span className="text-slate-400 italic">(auto)</span>}</span>
                  </div>
                </td>
                <td>
                  <Input value={it.part_no}
                    onChange={(e) => updateItem(idx, {
                      part_no: e.target.value,
                      partLooked: false,
                      makes: [],
                      make: "",
                      available_qty: 0,
                      godowns: [],
                      selected_godown_id: null,
                      selected_godown_name: null,
                    })}
                    onBlur={(e) => lookupMakes(idx, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Tab" || e.shiftKey) return;
                      // The Make dropdown is disabled until the lookup resolves, so a
                      // plain Tab would land nowhere. Hold focus, run the lookup, then
                      // hand focus to Make once its options exist.
                      e.preventDefault();
                      const val = e.target.value;
                      lookupMakes(idx, val).then(() => {
                        setTimeout(() => document.querySelector(`[data-testid="in-make-${idx}"]`)?.focus(), 0);
                      });
                    }}
                    placeholder="Enter part no"
                    className="rounded-sm font-mono font-semibold text-sm h-8 w-full px-2 text-slate-900"
                    data-testid={`in-part-no-${idx}`} />
                </td>
                <td className="align-middle" data-testid={`in-description-${idx}`}>
                  <div className="h-8 flex items-center text-xs text-slate-600 overflow-hidden" title={it.description_1 || ""}>
                    <span className="truncate">{it.description_1 || "—"}</span>
                  </div>
                </td>
                <td className="align-middle">
                  <Select disabled={!it.partLooked || it.makes.length === 0}
                    value={it.make || undefined} onValueChange={(v) => onMakeChange(idx, v)}>
                    <SelectTrigger className="rounded-sm h-8 w-full text-xs [&>span]:truncate" data-testid={`in-make-${idx}`}>
                      <SelectValue placeholder={!it.partLooked ? "Part No first" : (it.makes.length === 0 ? "No stock" : "Select make")} />
                    </SelectTrigger>
                    <SelectContent>
                      {it.makes.map((m) => (
                        <SelectItem key={m.make} value={m.make} data-testid={`in-make-${idx}-option-${m.make}`}>
                          <span className="font-mono">{m.make}</span>
                          <span className="ml-3 text-xs text-slate-500">avail {m.available_qty}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="align-middle">
                  <Input type="number" min="1" step="1" max={rowCap || undefined} value={it.quantity}
                    disabled={!it.make}
                    onChange={(e) => onQtyChange(idx, e.target.value)}
                    placeholder="Optional"
                    title={it.make
                      ? `Up to ${rowCap} available. Leave blank to let the store incharge decide.`
                      : "Leave blank to let the store incharge decide the quantity while picking"}
                    className={`rounded-sm font-mono h-8 w-full text-center px-1 ${overStock || overGodown ? "border-red-400" : ""}`}
                    data-testid={`in-qty-${idx}`} />
                  {/* Always rendered (invisible when there's nothing to say) so the row
                      height never changes as makes/quantities are filled in. */}
                  <div
                    className={`h-[14px] leading-[14px] text-[10px] mt-0.5 text-center overflow-hidden whitespace-nowrap text-ellipsis ${
                      !it.make ? "invisible"
                        : (overStock || overGodown ? "text-red-600 font-bold"
                          : (atCap ? "text-amber-600 font-bold" : "text-slate-500"))
                    }`}
                    title={it.make && openQty ? `Open — the store incharge decides (available ${it.available_qty})` : undefined}
                    data-testid={`in-avail-hint-${idx}`}
                  >
                    {openQty ? `Open · avail ${rowCap}`
                      : (overGodown ? `Over ${it.quantity}/${selectedGodown?.available_qty || 0}`
                        : (overStock ? `Over ${it.quantity}/${it.available_qty}`
                          : (atCap ? `Max ${rowCap}` : `Avail ${rowCap}`)))}
                  </div>
                </td>
                <td className="align-middle">
                  <Select
                    disabled={!it.make || (it.godowns || []).length === 0}
                    value={it.selected_godown_id || NO_GODOWN}
                    onValueChange={(v) => onIssueGodownChange(idx, v)}
                  >
                    <SelectTrigger className="rounded-sm h-8 w-full text-xs [&>span]:truncate" data-testid={`in-godown-${idx}`}>
                      <SelectValue placeholder={!it.make ? "Select make first" : "No godown preference"} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_GODOWN}>No godown preference</SelectItem>
                      {(it.godowns || []).map((g) => (
                        <SelectItem key={g.godown_id} value={g.godown_id} data-testid={`in-godown-${idx}-option-${g.godown_id}`}>
                          <span className="font-mono">{g.godown_name}</span>
                          <span className="ml-3 text-xs text-slate-500">avail {g.available_qty}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="align-middle">
                  <div className="flex items-center gap-1 h-8">
                    <button onClick={() => insertItemAfter(idx)}
                      className="p-1.5 rounded-sm hover:bg-blue-50 text-blue-700"
                      title="Add row below"
                      data-testid={`in-add-row-${idx}`}><Plus size={14} /></button>
                    <button onClick={() => removeItem(idx)} disabled={items.length === 1}
                      onKeyDown={(e) => {
                        if (e.key === "Tab" && !e.shiftKey && idx === items.length - 1 && items.length > 1) {
                          e.preventDefault();
                          document.querySelector('[data-testid="in-narration"]')?.focus();
                        }
                      }}
                      className={`p-1.5 rounded-sm ${items.length === 1 ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                      data-testid={`in-remove-row-${idx}`}><Trash size={14} /></button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        </div>

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
                  const draftBtn = document.querySelector('[data-testid="in-save-draft-button"]');
                  if (draftBtn && !draftBtn.disabled) {
                    draftBtn.focus();
                  } else {
                    document.querySelector('[data-testid="in-save-final-button"]')?.focus();
                  }
                }
              }}
              placeholder="Optional narration…"
              rows={2}
              className="w-full rounded-sm border border-slate-300 bg-white px-3 py-1.5 text-sm font-mono resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
              data-testid="in-narration"
            />
          </div>
          <div className="flex items-center gap-2 pt-7">
            {!isFinalEdit && (
              <Button
                onClick={saveDraft}
                disabled={savingDraft || savingFinal}
                variant="outline"
                className="rounded-sm border-blue-700 text-blue-700 hover:bg-blue-50"
                data-testid="in-save-draft-button"
              >
                <FloppyDisk size={14} weight="bold" className="mr-2" />
                {savingDraft ? "Saving…" : "Save as Draft"}
              </Button>
            )}
            <Button
              onClick={saveFinal}
              disabled={savingDraft || savingFinal || (!canFinalize && !isFinalEdit)}
              className="rounded-sm bg-blue-700 hover:bg-blue-800 disabled:bg-slate-300 disabled:cursor-not-allowed"
              data-testid="in-save-final-button"
              title={!canFinalize && !isFinalEdit
                ? "Fill Part No and Make on every row to enable Final Save (Quantity may be left blank)"
                : (isFinalEdit ? "Update Issue Note" : "Final Save — releases for picking")}
            >
              <CheckCircle size={14} weight="bold" className="mr-2" />
              {savingFinal ? "Saving…" : (isFinalEdit ? "Update Issue Note" : "Save Final")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================== PICKING NOTE TAB =========================== */
function PickingNoteTab() {
  const [view, setView] = useState("list");
  const [editing, setEditing] = useState(null);
  const [openPn, setOpenPn] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const goEdit = (p) => { setEditing(p); setView("edit"); };
  const goList = () => { setEditing(null); setView("list"); setReloadKey((k) => k + 1); };

  return (
    <>
      {view === "list" && <PickingNoteList reloadKey={reloadKey} onEdit={goEdit} onOpen={setOpenPn} onRecorded={() => setReloadKey((k) => k + 1)} />}
      {view === "edit" && <PickingNoteForm editing={editing} onCancel={goList} onSaved={goList} />}
      <PickingNoteDetailDialog pn={openPn} onClose={() => setOpenPn(null)} />
    </>
  );
}

function PickingNoteList({ reloadKey, onEdit, onOpen, onRecorded }) {
  const { user: me, isAdmin } = useAuth();
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [recordingId, setRecordingId] = useState(null);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/picking-notes", { params: { page, page_size: PAGE_SIZE, search: search || undefined } });
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

  const handleRecord = async (pn) => {
    if (!window.confirm(`Record ${pn.pn_no} as Stock Out?\n\n${pn.items.length} OUT transaction(s) will be created.`)) return;
    setRecordingId(pn.id);
    try {
      const { data } = await api.post(`/picking-notes/${pn.id}/record`);
      toast.success(`Recorded · ${data.transactions_created} stock-out transaction(s) created`);
      if (data.remaining_picking_note?.pn_no) {
        toast.info(`Remaining quantity moved to ${data.remaining_picking_note.pn_no}`);
      }
      load(); onRecorded?.();
    } catch (err) { toast.error(formatApiError(err.response?.data?.detail) || "Could not record"); }
    finally { setRecordingId(null); }
  };

  // Header labels stay in full form — the column widths below are sized to fit them on
  // one line rather than the labels being shortened to fit the columns.
  const columns = useMemo(() => [
    { key: "pn_date", label: "PICKING NOTE DATE", value: (r) => fmtDate(r.pn_date) },
    { key: "pn_no", label: "PICKING NOTE NO", value: (r) => r.pn_no || "" },
    { key: "in_date", label: "ISSUE NOTE DATE", value: (r) => fmtDate(r.issue_note_date) },
    { key: "in_no", label: "ISSUE NOTE NO", value: (r) => r.issue_note_no || "" },
    { key: "parent_assigned_to_name", label: "ASSIGNED TO", value: (r) => r.parent_assigned_to_name || "" },
    { key: "items_count", label: "ITEMS", value: (r) => pickingDisplayCount(r), isQty: true, isNumeric: true },
    { key: "assigned_qty", label: "ASSIGNED", value: (r) => pickingAssignedQty(r), isQty: true, isNumeric: true },
    { key: "picked_qty", label: "PICKED", value: (r) => pickingPickedQty(r), isQty: true, isNumeric: true },
    { key: "status", label: "STATUS", value: (r) => pickingNoteStatusLabel(r.status) },
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
    exportToExcel(filteredRows, exportCols, `Picking_Notes_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="mt-4" data-testid="pn-list-view">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input
            ref={searchInputRef}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search picking notes…"
            className="rounded-sm font-mono h-9 pl-10 w-full"
            data-testid="pn-search-input"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleExport} variant="outline" className="rounded-sm border-slate-300" data-testid="pn-export-button">
            <DownloadSimple size={14} weight="bold" className="mr-2" /> Export
          </Button>
          <Button onClick={load} variant="outline" className="rounded-sm border-slate-300" disabled={loading} data-testid="pn-refresh-button">
            <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button disabled variant="outline" className="rounded-sm border-slate-300 text-slate-400" title="Picking Notes are auto-generated when Issue Notes are saved" data-testid="create-pn-button">
            <Package size={16} weight="bold" className="mr-2" /> Auto Generated
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-between mb-3 text-xs text-slate-600">
  <div>
    {total === 0 ? "No picking notes" : (
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
      {/* Column widths are cut to fit each full header label on one line — nothing is
          clipped or abbreviated. The page scrolls normally; only the horizontal
          overflow is handled here. */}
      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto" data-testid="pn-scroller">
        <table className="data-table data-table-fixed w-full min-w-[1400px]">
          <colgroup>
            <col style={{ width: "70px" }} />
            <col style={{ width: "176px" }} />
            <col style={{ width: "160px" }} />
            <col style={{ width: "160px" }} />
            <col style={{ width: "144px" }} />
            <col />
            <col style={{ width: "84px" }} />
            <col style={{ width: "110px" }} />
            <col style={{ width: "94px" }} />
            <col style={{ width: "94px" }} />
            <col style={{ width: "132px" }} />
          </colgroup>
          <thead>
            <tr>
              <th>SL NO</th>
              {columns.map((c) => (
                <th key={c.key} className={c.isQty ? "!text-center" : ""}>
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
              const totalQty = pickingAssignedQty(r);
              const pickedQty = pickingPickedQty(r);
              const recorded = r.status === "RECORDED" || r.status === "COMPLETED";
              const pending = r.status === "PENDING";
              const aId = r.parent_assigned_to_user_id;
              const aName = r.parent_assigned_to_name;
              const aEmail = r.parent_assigned_to_email;
              const lockedToOther = !!aId && aId !== me?.id && !isAdmin;
              const lock = recorded || lockedToOther;
              const editTitle = recorded ? "Cannot edit — already recorded"
                : (lockedToOther ? `Locked — assigned to ${aName || aEmail}` : (pending ? "Open Picking" : "Edit"));
              const recordTitle = recorded ? "Already recorded"
                : (pending ? "Open Picking and save a draft first" : (lockedToOther ? `Locked — assigned to ${aName || aEmail}` : "Record as Stock Out"));
              const recordDisabled = lock || pending || recordingId === r.id;
              return (
                <tr key={r.id} data-testid={`pn-row-${r.pn_no}`} className="transition-colors duration-100">
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td className="font-mono text-slate-700">{fmtDate(r.pn_date)}</td>
                  <td>
                    <button onClick={() => onOpen(r)} className="font-mono font-semibold text-blue-700 hover:underline" data-testid={`pn-open-${r.pn_no}`}>{r.pn_no}</button>
                  </td>
                  <td className="font-mono text-slate-700">{fmtDate(r.issue_note_date)}</td>
                  <td className="font-mono text-slate-700">{r.issue_note_no || "—"}</td>
                  <td className="text-slate-700 truncate" title={r.parent_assigned_to_name || ""}>{r.parent_assigned_to_name || "—"}</td>
                  <td className="font-mono text-slate-600 tabular-nums text-center">{pickingDisplayCount(r)}</td>
                  <td className="font-mono font-bold text-slate-900 tabular-nums text-center">{totalQty || "—"}</td>
                  <td className="font-mono font-bold text-slate-900 tabular-nums text-center">{pickedQty}</td>
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${recorded ? "bg-green-100 text-green-800" : (pending ? "bg-blue-50 text-blue-800" : "bg-amber-50 text-amber-700")}`} data-testid={`pn-status-${r.pn_no}`}>
                      {recorded ? "Completed" : (pending ? "Pending" : "Draft")}
                    </span>
                  </td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button onClick={() => onEdit(r)} disabled={lock}
                        title={editTitle}
                        className={`p-1.5 rounded-sm shrink-0 ${lock ? "text-slate-300 cursor-not-allowed" : "hover:bg-slate-100"}`}
                        data-testid={`pn-edit-${r.pn_no}`}>
                        <Pencil size={14} />
                      </button>
                      <Button onClick={() => handleRecord(r)} disabled={recordDisabled} size="sm"
                        title={recordTitle}
                        className={`rounded-sm h-7 text-[11px] px-2 shrink-0 ${lock ? "bg-slate-200 text-slate-500 cursor-not-allowed hover:bg-slate-200" : "bg-emerald-700 hover:bg-emerald-800 text-white"}`}
                        data-testid={`pn-record-${r.pn_no}`}>
                        <CheckCircle size={12} weight="bold" className="mr-1" />
                        {recorded ? "Recorded" : (recordingId === r.id ? "Recording…" : "Record")}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && (
              <tr><td colSpan={columns.length + 2} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? "No pending picking notes." : "No rows match the current filters.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PickingNoteDetailDialog({ pn, onClose }) {
  const requestedFor = pn ? pickingRequestedLookup(pn) : () => null;
  return (
    <Dialog open={!!pn} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl max-h-[92vh] overflow-y-auto rounded-sm" data-testid="pn-detail-dialog">
        {pn && (
          <>
            <div className="text-center text-xl font-black tracking-widest uppercase pt-1 pb-2 border-b border-slate-200">
              PICKING NOTE
            </div>
            <div className="grid grid-cols-2 gap-6 text-sm pt-3 pb-4 border-b border-slate-200">
              <div className="space-y-2">
                <Detail k="PICKING NOTE DATE" v={fmtDate(pn.pn_date)} />
                <Detail k="PICKING NOTE NO" v={pn.pn_no} />
                <Detail k="ISSUE NOTE NO" v={pn.issue_note_no || "—"} />
                <Detail k="STATUS" v={
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${pickingNoteStatusLabel(pn.status) === "Completed" ? "bg-green-100 text-green-800" : (pickingNoteStatusLabel(pn.status) === "Pending" ? "bg-blue-50 text-blue-800" : "bg-amber-50 text-amber-700")}`}>
                    {pickingNoteStatusLabel(pn.status)}
                  </span>
                } />
              </div>
              <div className="space-y-2">
                <Detail k="CREATED BY (PICKER)" v={pn.created_by || "—"} />
                <Detail k="CREATED AT" v={new Date(pn.created_at).toLocaleString()} />
                <div>
                  <div className="label-sm">ASSIGNED TO (FROM ISSUE NOTE)</div>
                  <div className="mt-1"><AssigneeBadge name={pn.parent_assigned_to_name} email={pn.parent_assigned_to_email} /></div>
                </div>
              </div>
            </div>
            <div className="mt-2">
              <div className="label-sm mb-2">Items ({pickingDisplayItems(pn).length})</div>
              <div className="overflow-x-auto">
                <table className="data-table w-full text-xs">
                  <thead><tr><th>SL</th><th>PART NO</th><th>MAKE</th><th>DESCRIPTION</th><th>STATUS</th><th className="text-center">REQUESTED QTY</th><th className="text-center">PICKED QTY</th><th>GODOWN</th><th>RACK</th><th>BOX</th></tr></thead>
                  <tbody>
                    {pickingDisplayItems(pn).map((it, idx) => (
                      <tr key={idx}>
                        <td className="font-mono text-slate-500">{idx + 1}</td>
                        <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                        <td>{it.make}</td>
                        <td className="text-slate-700 max-w-[260px] truncate">{it.description_1 || "—"}</td>
                        <td className="font-mono text-slate-600">{it.row_status || "—"}</td>
                        <td className="text-center font-mono font-bold text-slate-600">{requestedFor(it) ?? ""}</td>
                        <td className="text-center font-mono font-bold">{it.quantity}</td>
                        <td className="font-mono">{it.godown_name || "—"}</td>
                        <td className="font-mono">{it.rack_no || "—"}</td>
                        <td className="font-mono">{it.box_no || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="flex items-center gap-2 pt-4 border-t border-slate-200 mt-6">
              <Button onClick={() => printPickingNote(pn)} variant="outline" size="sm" className="rounded-sm" data-testid="pn-print-button">
                <Printer size={14} weight="bold" className="mr-1.5" /> Print
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PickingNoteForm({ editing, onCancel, onSaved }) {
  const isEdit = !!editing;
  const [pnNo, setPnNo] = useState("");
  const [pnDate, setPnDate] = useState("");
  const [pendingIns, setPendingIns] = useState([]);
  const [selectedInId, setSelectedInId] = useState("");
  const [assignedToName, setAssignedToName] = useState("");
  const [items, setItems] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isEdit) {
      setPnNo(editing.pn_no);
      setPnDate(editing.pn_date);
      setSelectedInId(editing.issue_note_id);
      setAssignedToName(editing.parent_assigned_to_name || "");
      setPendingIns([{ id: editing.issue_note_id, in_no: editing.issue_note_no, in_date: editing.issue_note_date, assigned_to_name: editing.parent_assigned_to_name }]);
      api.get(`/picking-notes/prepare/${editing.issue_note_id}`, { params: { exclude_pn_id: editing.id } })
        .then((r) => {
          setItems(buildPickingEditItems(editing, r.data.items || []));
        }).catch(() => setItems((editing.items || []).map((it) => ({
          ...it, ...locSelKeys(it), pending_qty: 0, requested_qty: 0, allocated_qty: it.quantity || 0,
          // Prepare failed — fall back to a single-option location list so the
          // dropdown/qty editing still works using the row's already-stored location.
          available_locations: it.godown_id ? [{
            godown_id: it.godown_id, godown_name: it.godown_name, rack_id: it.rack_id, rack_no: it.rack_no,
            box_id: it.box_id, box_no: it.box_no, box_category: it.box_category, current_qty: it.quantity || 0,
          }] : [],
        }))));
    } else {
      api.get("/picking-notes/next-no").then((r) => { setPnNo(r.data.next_pn_no); setPnDate(r.data.pn_date); })
        .catch(() => toast.error("Could not preview picking-note number"));
      api.get("/issue-notes", { params: { not_status: "COMPLETE", page_size: 100 } })
        .then((r) => setPendingIns(r.data || []));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, editing]);

  const handleInChange = async (id) => {
    setSelectedInId(id);
    if (!id) { setItems([]); setAssignedToName(""); return; }
    const inn = pendingIns.find((x) => x.id === id);
    setAssignedToName(inn?.assigned_to_name || "");
    try {
      const { data } = await api.get(`/picking-notes/prepare/${id}`);
      setItems((data.items || []).map((it) => ({ ...it, ...locSelKeys(it), row_status: "Assigned" })));
    } catch (err) { toast.error(formatApiError(err.response?.data?.detail) || "Could not prepare items"); }
  };

  const updateItem = (i, patch) => setItems((p) => p.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  // The Issue Note's godown preference is a SUGGESTION, not a lock: the picker resolves
  // the real location here, one level at a time, from whatever currently holds stock for
  // this part/make. Whatever is chosen is what gets recorded, printed and previewed.
  const godownOptions = (row) => {
    const seen = new Set();
    return (row.available_locations || []).filter((L) => {
      const id = L.godown_id || "";
      if (!id || seen.has(id)) return false;   // stock with no godown can't be picked
      seen.add(id);
      return true;
    });
  };
  const rackOptions = (row) => {
    const seen = new Set();
    return (row.available_locations || [])
      .filter((L) => (L.godown_id || "") === (row.godown_id || ""))
      .filter((L) => {
        const id = L.rack_id || "";
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
  };
  const boxOptions = (row) => (row.available_locations || []).filter(
    (L) => (L.godown_id || "") === (row.godown_id || "") && (L.rack_id || "") === (row.rack_id || ""),
  );

  // There is nothing to choose when the only thing on offer is "none" — a godown with no
  // racking, or a rack with no boxes. Those cells render as a plain "—" instead of a
  // dropdown that demands an answer the warehouse cannot give.
  const rackChoiceExists = (row) => {
    const opts = rackOptions(row);
    return opts.length > 1 || opts.some((L) => L.rack_id);
  };
  const boxChoiceExists = (row) => {
    const opts = boxOptions(row);
    return opts.length > 1 || opts.some((L) => L.box_id);
  };

  // Picking a level clears everything below it, then auto-resolves any level that has
  // only one possible answer — so a single-rack/single-box godown needs just one click.
  const onGodownSelect = (i, godownId) => {
    const row = items[i];
    const patch = {
      godown_id: godownId,
      godown_name: (row.available_locations || []).find((L) => L.godown_id === godownId)?.godown_name || "",
      rack_id: "", rack_no: "", box_id: "", box_no: "", box_category: "",
      rack_sel: "", box_sel: "", quantity: "",
    };
    const racks = rackOptions({ ...row, godown_id: godownId });
    if (racks.length === 1) {
      patch.rack_id = racks[0].rack_id || "";
      patch.rack_no = racks[0].rack_no || "";
      patch.rack_sel = racks[0].rack_id || NO_RACK;
      const boxes = boxOptions({ ...row, godown_id: godownId, rack_id: racks[0].rack_id });
      if (boxes.length === 1) {
        patch.box_id = boxes[0].box_id || "";
        patch.box_no = boxes[0].box_no || "";
        patch.box_category = boxes[0].box_category || "";
        patch.box_sel = boxes[0].box_id || NO_BOX;
      }
    }
    updateItem(i, patch);
  };
  const onRackSelect = (i, rackKey) => {
    const row = items[i];
    const rack = rackOptions(row).find((L) => (L.rack_id || NO_RACK) === rackKey);
    if (!rack) return;
    const patch = {
      rack_id: rack.rack_id || "", rack_no: rack.rack_no || "", rack_sel: rackKey,
      box_id: "", box_no: "", box_category: "", box_sel: "", quantity: "",
    };
    const boxes = boxOptions({ ...row, rack_id: rack.rack_id || "" });
    if (boxes.length === 1) {
      patch.box_id = boxes[0].box_id || "";
      patch.box_no = boxes[0].box_no || "";
      patch.box_category = boxes[0].box_category || "";
      patch.box_sel = boxes[0].box_id || NO_BOX;
    }
    updateItem(i, patch);
  };
  const onBoxSelect = (i, boxKey) => {
    const row = items[i];
    const box = boxOptions(row).find((L) => (L.box_id || NO_BOX) === boxKey);
    if (!box) return;
    updateItem(i, {
      box_id: box.box_id || "", box_no: box.box_no || "",
      box_category: box.box_category || "", box_sel: boxKey,
    });
  };

  // A row is pickable only once all three levels have been chosen AND they resolve to a
  // real stock location.
  const locationResolved = (row) => (
    !!row.godown_id && !!row.rack_sel && !!row.box_sel
    && (row.available_locations || []).some((L) => locOnlyKey(L) === locOnlyKey(row))
  );

  // Split an item across another location: append a fresh row for the same part/make
  // (qty starts blank) so the picker can partially pick the suggestion and take the
  // remainder from somewhere else, without being forced to choose just one location.
  const addLocationRow = (i) => {
    const row = items[i];
    setItems((prev) => {
      const copy = [...prev];
      copy.splice(i + 1, 0, {
        ...row, quantity: "",
        godown_id: "", godown_name: "", rack_id: "", rack_no: "", box_id: "", box_no: "", box_category: "",
        rack_sel: "", box_sel: "",
        row_status: "Assigned", allocated_qty: 0, suggested: false, manual: true,
      });
      return copy;
    });
  };
  const removeLocationRow = (i) => setItems((prev) => prev.filter((_, idx) => idx !== i));

  // What the Issue Note asked for on THIS row's line — reference only, and per line so
  // two lines of the same part keep their own 15 and 5 instead of sharing one number. It
  // is a target, not a limit: the picker may take more or less. `null` = open line (the
  // office left the quantity to the store incharge), displayed blank.
  const rowRequested = (row) => (row.open_quantity ? null : (row.requested_qty ?? null));
  // Live "available here" per row, netting out what other rows in this same form
  // already claim at the identical location (server does the authoritative check).
  const availableAtRow = (row, idx) => {
    const loc = (row.available_locations || []).find((L) => locOnlyKey(L) === locOnlyKey(row));
    if (!loc) return 0;
    const claimedElsewhere = items.reduce((sum, r, ri) => {
      if (ri === idx || r.part_no !== row.part_no || r.make !== row.make) return sum;
      return locOnlyKey(r) === locOnlyKey(row) ? sum + (parseInt(r.quantity) || 0) : sum;
    }, 0);
    return Math.max(0, (loc.current_qty || 0) - claimedElsewhere);
  };

  // Picked Qty is clamped to what is physically at the chosen location — the picker may
  // freely go above or below the requested quantity, but never above real stock.
  const onPickedQtyChange = (idx, raw) => {
    if (raw === "") { updateItem(idx, { quantity: "" }); return; }
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 0) return;
    const cap = availableAtRow(items[idx], idx);
    updateItem(idx, { quantity: String(Math.min(n, cap)) });
  };

  const save = async () => {
    if (!selectedInId) { toast.error("Select an Issue Note"); return; }
    if (items.length === 0) { toast.error("No items to pick"); return; }
    // Every Issue Note line is sent, including any picked as 0 — a 0 is a real answer
    // ("this line was covered elsewhere / not taken") and the row must survive the save
    // instead of collapsing away. Only empty manual split rows are dropped as noise.
    const pickRows = items.filter((it) => (parseInt(it.quantity) || 0) > 0 || !it.manual);
    if (!items.some((it) => (parseInt(it.quantity) || 0) > 0)) { toast.error("Enter at least one Picked Qty"); return; }
    for (let i = 0; i < pickRows.length; i++) {
      const rowNo = items.indexOf(pickRows[i]) + 1;
      const it = pickRows[i];
      const q = parseInt(it.quantity) || 0;
      if (q < 0) { toast.error(`Row ${rowNo}: quantity cannot be negative`); return; }
      if (q === 0) continue;   // nothing leaves the shelf — no location needed
      // All three levels must be settled, but "settled" means chosen from what actually
      // exists: a godown with no racking settles its rack/box as "none", which is a valid
      // answer — hence the *_sel keys rather than the raw ids.
      if (!it.godown_id) { toast.error(`Row ${rowNo}: Godown is required`); return; }
      if (!it.rack_sel) { toast.error(`Row ${rowNo}: Rack is required`); return; }
      if (!it.box_sel) { toast.error(`Row ${rowNo}: Box is required`); return; }
      if (!locationResolved(it)) { toast.error(`Row ${rowNo}: choose a location that holds stock`); return; }
      // Real stock is the only ceiling — picking more or less than requested is fine.
      const availHere = availableAtRow(it, items.indexOf(it));
      if (q > availHere + 1e-6) {
        toast.error(`Row ${rowNo}: only ${availHere} available at ${it.godown_name || "—"}/${it.rack_no || "—"}/${it.box_no || "—"}`);
        return;
      }
    }

    setSaving(true);
    try {
      const payload = {
        issue_note_id: selectedInId,
          items: pickRows.map((it) => ({
          part_no: it.part_no, make: it.make, line_no: it.line_no ?? null,
          quantity: parseInt(it.quantity) || 0,
          model: it.model || "", old_part_no: it.old_part_no || "", make_part_no: it.make_part_no || "",
          description_1: it.description_1 || "", description_2: it.description_2 || "",
          remarks_oem: it.remarks_oem || "", remarks_others: it.remarks_others || "",
          item_category: it.item_category || "",
          godown_id: it.godown_id || "", godown_name: it.godown_name || "",
          rack_id: it.rack_id || "", rack_no: it.rack_no || "",
          box_id: it.box_id || "", box_no: it.box_no || "", box_category: it.box_category || "",
        })),
      };
      const { data } = isEdit
        ? await api.put(`/picking-notes/${editing.id}`, payload)
        : await api.post("/picking-notes", payload);
      toast.success(`Picking Note ${data.pn_no} ${isEdit ? "updated" : "saved"}`);
      onSaved();
    } catch (err) { toast.error(formatApiError(err.response?.data?.detail) || "Could not save"); }
    finally { setSaving(false); }
  };

  return (
    <div className="mt-4 space-y-6" data-testid="pn-create-view">
      <div className="flex items-center justify-between">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="pn-back-button">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
        <Button onClick={save} disabled={saving} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="pn-save-button">
          <FloppyDisk size={14} weight="bold" className="mr-2" /> {saving ? "Saving…" : (isEdit ? "Update Picking Note" : "Save Picking Note")}
        </Button>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm p-6 grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div>
          <Label className="label-sm">Picking Note Date</Label>
          <Input value={pnDate} disabled className="mt-2 rounded-sm font-mono bg-slate-50" data-testid="pn-date-input" />
        </div>
        <div>
          <Label className="label-sm">Picking Note No</Label>
          <Input value={pnNo} disabled className="mt-2 rounded-sm font-mono font-semibold bg-blue-50 text-blue-900" data-testid="pn-no-input" />
        </div>
        <div>
          <Label className="label-sm">Issue Note *</Label>
          <Select value={selectedInId || undefined} onValueChange={handleInChange} disabled={isEdit}>
            <SelectTrigger className="mt-2 rounded-sm" data-testid="pn-in-select">
              <SelectValue placeholder={pendingIns.length === 0 ? "No issue notes pending" : "Select issue note"} />
            </SelectTrigger>
            <SelectContent>
              {pendingIns.map((inn) => (
                <SelectItem key={inn.id} value={inn.id} data-testid={`pn-in-option-${inn.in_no}`}>
                  <span className="font-mono">{inn.in_no}</span><span className="ml-3 text-slate-500 text-xs">{fmtDate(inn.in_date)} · {inn.assigned_to_name || "—"}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="label-sm">Assigned To</Label>
          <Input value={assignedToName} disabled className="mt-2 rounded-sm bg-slate-50" data-testid="pn-assigned-to" />
        </div>
      </div>

      {items.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto">
          <div className="px-4 pt-3 text-xs text-slate-500">
            Godown, Rack and Box are pre-filled with the Issue Note's suggested location (marked <span className="font-bold text-blue-700">Suggested</span>) —
            all three are required, and all three can be changed to any location currently holding stock.
            Use <span className="font-bold">+ Split</span> to take the remainder from another location.
            Requested Qty is what the office asked for; pick more or less as the shelf actually allows.
          </div>
          <table className="data-table data-table-fixed w-full text-xs min-w-[1360px]">
            <colgroup>
              <col style={{ width: "56px" }} />
              <col style={{ width: "100px" }} />
              <col style={{ width: "118px" }} />
              <col style={{ width: "92px" }} />
              <col />
              <col style={{ width: "112px" }} />
              <col style={{ width: "130px" }} />
              <col style={{ width: "100px" }} />
              <col style={{ width: "100px" }} />
              <col style={{ width: "142px" }} />
              <col style={{ width: "112px" }} />
              <col style={{ width: "64px" }} />
            </colgroup>
            <thead>
              <tr>
                <th>SL NO</th>
                <th>MODEL</th>
                <th>PART NO</th>
                <th>MAKE</th>
                <th>DESCRIPTION</th>
                <th>CATEGORY</th>
                <th>GODOWN</th>
                <th>RACK</th>
                <th>BOX</th>
                <th className="!text-center">REQUESTED QTY</th>
                <th className="!text-center">PICKED QTY</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => {
                const requested = rowRequested(it);
                const noStockAtAll = (it.available_locations || []).length === 0;
                const resolved = locationResolved(it);
                const availHere = availableAtRow(it, idx);
                const q = parseInt(it.quantity) || 0;
                return (
                  <tr key={idx} data-testid={`pn-item-row-${idx}`} className={noStockAtAll ? "bg-amber-50" : ""}>
                    <td className="font-mono text-slate-500 align-middle">{idx + 1}</td>
                    <td className="font-mono text-slate-600 align-middle truncate" title={it.model || ""}>{it.model || "—"}</td>
                    <td className="align-middle"><PartNoLink partNo={it.part_no} make={it.make} /></td>
                    <td className="align-middle truncate" title={it.make}>{it.make}</td>
                    <td className="text-slate-700 align-middle truncate" title={it.description_1}>{it.description_1 || "—"}</td>
                    <td className="text-slate-600 align-middle truncate" title={it.item_category || ""}>{it.item_category || "—"}</td>
                    <td className="align-middle">
                      {noStockAtAll ? (
                        <span className="text-[11px] text-amber-700 italic">
                          No stock{it.unallocated_shortfall ? ` (short ${it.unallocated_shortfall})` : ""}
                        </span>
                      ) : (
                        <>
                          <Select value={it.godown_id || undefined} onValueChange={(v) => onGodownSelect(idx, v)}>
                            <SelectTrigger className="rounded-sm h-8 w-full text-xs [&>span]:truncate" data-testid={`pn-godown-${idx}`}>
                              <SelectValue placeholder="Godown *" />
                            </SelectTrigger>
                            <SelectContent>
                              {godownOptions(it).map((L) => (
                                <SelectItem key={L.godown_id} value={L.godown_id} data-testid={`pn-godown-${idx}-option-${L.godown_id}`}>
                                  <span className="font-mono">{L.godown_name}</span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {it.suggested && <div className="text-[10px] font-bold text-blue-700 mt-0.5 leading-tight">Suggested</div>}
                        </>
                      )}
                    </td>
                    <td className="align-middle">
                      {!noStockAtAll && it.godown_id && !rackChoiceExists(it) ? (
                        <span className="text-slate-400 font-mono" title="This godown has no racking" data-testid={`pn-rack-${idx}-none`}>—</span>
                      ) : !noStockAtAll && (
                        <Select value={it.rack_sel || undefined} disabled={!it.godown_id}
                          onValueChange={(v) => onRackSelect(idx, v)}>
                          <SelectTrigger className="rounded-sm h-8 w-full text-xs [&>span]:truncate" data-testid={`pn-rack-${idx}`}>
                            <SelectValue placeholder={it.godown_id ? "Rack *" : "—"} />
                          </SelectTrigger>
                          <SelectContent>
                            {rackOptions(it).map((L) => (
                              <SelectItem key={L.rack_id || NO_RACK} value={L.rack_id || NO_RACK} data-testid={`pn-rack-${idx}-option-${L.rack_id || NO_RACK}`}>
                                <span className="font-mono">{L.rack_no || "(no rack)"}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </td>
                    <td className="align-middle">
                      {!noStockAtAll && it.rack_sel && !boxChoiceExists(it) ? (
                        <span className="text-slate-400 font-mono" title="This location has no boxes" data-testid={`pn-box-${idx}-none`}>—</span>
                      ) : !noStockAtAll && (
                        <Select value={it.box_sel || undefined}
                          disabled={!it.rack_sel}
                          onValueChange={(v) => onBoxSelect(idx, v)}>
                          <SelectTrigger className="rounded-sm h-8 w-full text-xs [&>span]:truncate" data-testid={`pn-box-${idx}`}>
                            <SelectValue placeholder={it.rack_sel ? "Box *" : "—"} />
                          </SelectTrigger>
                          <SelectContent>
                            {boxOptions(it).map((L) => (
                              <SelectItem key={L.box_id || NO_BOX} value={L.box_id || NO_BOX} data-testid={`pn-box-${idx}-option-${L.box_id || NO_BOX}`}>
                                <span className="font-mono">{L.box_no || "(no box)"}</span>
                                <span className="ml-2 text-xs text-slate-500">avail {L.current_qty}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </td>
                    {/* Requested is reference only — blank when the office left it open. */}
                    <td className="text-center font-mono font-bold text-slate-700 align-middle" data-testid={`pn-requested-${idx}`}>
                      {requested == null || requested === 0 ? "" : requested}
                    </td>
                    <td className="align-middle">
                      <Input type="number" min="0" step="1" max={availHere || undefined} value={it.quantity}
                        disabled={noStockAtAll || !resolved}
                        onChange={(e) => onPickedQtyChange(idx, e.target.value)}
                        title={noStockAtAll ? "Nothing on the shelf for this item"
                          : (!resolved ? "Select Godown, Rack and Box first" : `Up to ${availHere} available at this location`)}
                        className="rounded-sm font-mono h-8 text-center w-full px-1"
                        data-testid={`pn-qty-${idx}`} />
                      {/* Fixed-height hint so rows never change height as quantities change. */}
                      <div className={`h-[14px] leading-[14px] text-[10px] mt-0.5 text-center overflow-hidden whitespace-nowrap text-ellipsis ${
                        noStockAtAll ? "invisible" : (!resolved ? "text-slate-400" : (q === availHere && availHere > 0 ? "text-amber-600 font-bold" : "text-slate-500"))
                      }`} data-testid={`pn-avail-hint-${idx}`}>
                        {!resolved ? "Pick location" : (q === availHere && availHere > 0 ? `Max ${availHere}` : `Avail ${availHere}`)}
                      </div>
                    </td>
                    <td className="align-middle">
                      <div className="flex items-center h-8">
                        <button type="button" onClick={() => addLocationRow(idx)} title="Split — pick the remainder from another location"
                          className="p-1.5 rounded-sm hover:bg-blue-50 text-blue-700" data-testid={`pn-split-row-${idx}`}>
                          <Plus size={14} />
                        </button>
                        {it.manual && (
                          <button type="button" onClick={() => removeLocationRow(idx)} title="Remove this split row"
                            className="p-1.5 rounded-sm hover:bg-red-50 text-red-700" data-testid={`pn-remove-row-${idx}`}>
                            <Trash size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!selectedInId && !isEdit && (
        <div className="bg-amber-50 border border-amber-200 rounded-sm p-6 text-sm text-amber-800">
          Pick an Issue Note above to load its items for picking.
        </div>
      )}
    </div>
  );
}
