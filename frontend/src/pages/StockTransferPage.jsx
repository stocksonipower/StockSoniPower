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
import {
  Plus, Trash, ArrowLeft, FloppyDisk, FileText, CaretLeft, CaretRight,
  Pencil, CheckCircle, ArrowsLeftRight, Package, MapPin, Printer,
  DownloadSimple, ArrowsClockwise, MagnifyingGlass,
} from "@phosphor-icons/react";
import { useAuth } from "../lib/auth";
import AssigneeSelect, { AssigneeBadge } from "../components/AssigneeSelect";
import { assigneeLabel, actorLabel } from "../lib/assignee";
import ExcelColumnFilter from "../components/ExcelColumnFilter";
import useExcelTableFilter from "../components/useExcelTableFilter";
import PartNoLink from "../components/PartNoLink";
import { exportToExcel } from "../lib/exportExcel";
import { buildStandardPrintHtml, openPrintWindow, htmlEscape, formatLocationText } from "../lib/printDocument";
import { noteQtys, varianceLabel, varianceValue, varianceClass, varianceTitle } from "../lib/noteQtys";

const PAGE_SIZE = 50;
const NO_LOCATION = "__NO_LOCATION__";

function fmtDate(iso) {
  if (!iso) return "—";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}

function Detail({ k, v }) {
  return (
    <div>
      <div className="label-sm">{k}</div>
      <div className="font-mono mt-1 text-slate-900">{v}</div>
    </div>
  );
}

function qtySum(items) {
  return (items || []).reduce((s, it) => s + (parseInt(it.quantity) || 0), 0);
}

/* ---------------------------------------------------------------------------
   The five Transfer quantities. Only two are ever entered — Transferred and
   Rejected — and the other three follow by arithmetic that is identical
   everywhere: the form, the lists, the detail dialogs, the print previews, the
   printed sheets and the backend (`_transfer_totals` in routes/transfer.py, over
   the shared `note_qty_totals`).

       Pending = max(0, Requested − Transferred − Rejected)
       Extra   = max(0, Transferred − Requested)

   There is deliberately no Short field: a shortfall IS the Pending quantity, and
   it is carried by an automatically-raised follow-up Transfer Note rather than
   recorded as a separate number.

   The requested quantity is a TARGET, not a ceiling — the operator may move more
   than was asked for (an Extra) or less (a Pending). The only hard limit is what
   is physically on the shelf. Reject is legal only while Extra is 0.
   --------------------------------------------------------------------------- */

// Null-safe: the detail dialogs stay mounted with a null note until a row is opened.
function transferAssignedItems(stn) {
  return (stn?.assigned_items || []).length ? (stn?.assigned_items || []) : (stn?.requested_items || []);
}

// Note-level totals. The server sends all five (`_enrich_transfer_note_totals`); they are
// recomputed here from the note's own items only when a caller passes a row that has not
// been through that enrichment, so a stale/partial row still shows consistent numbers.
function transferTotals(stn) {
  if (stn && stn.pending_qty_total !== undefined) {
    return {
      requested: parseFloat(stn.requested_qty_total) || 0,
      transferred: parseFloat(stn.transferred_qty_total) || 0,
      rejected: parseFloat(stn.rejected_qty_total) || 0,
      pending: parseFloat(stn.pending_qty_total) || 0,
      extra: parseFloat(stn.extra_qty_total) || 0,
    };
  }
  const requestedByKey = {}, movedByKey = {}, rejectedByKey = {};
  transferAssignedItems(stn).forEach((it) => {
    const k = transferKey(it);
    requestedByKey[k] = (requestedByKey[k] || 0) + (parseFloat(it.quantity) || 0);
  });
  (stn?.items || []).forEach((it) => {
    const k = transferKey(it);
    movedByKey[k] = (movedByKey[k] || 0) + (parseFloat(it.quantity) || 0);
    rejectedByKey[k] = (rejectedByKey[k] || 0) + (parseFloat(it.rejected_qty) || 0);
  });
  // Pending and Extra are floored per part/make and only then summed, exactly as the
  // backend does, so a surplus on one item can never mask a shortfall on another.
  let pending = 0, extra = 0;
  new Set([...Object.keys(requestedByKey), ...Object.keys(movedByKey), ...Object.keys(rejectedByKey)]).forEach((k) => {
    const q = noteQtys(requestedByKey[k] || 0, movedByKey[k] || 0, rejectedByKey[k] || 0);
    pending += q.pending;
    extra += q.extra;
  });
  const sum = (m) => Object.values(m).reduce((s, v) => s + v, 0);
  return { requested: sum(requestedByKey), transferred: sum(movedByKey), rejected: sum(rejectedByKey), pending, extra };
}

// Single-value accessors for the list columns. Anything needing more than one number
// calls `transferTotals` once instead, so Pending and Extra have no accessors of their
// own — the views that show them (form, detail, print) take the whole set.
function transferRequestedQty(stn) { return transferTotals(stn).requested; }
function transferMovedQty(stn)     { return transferTotals(stn).transferred; }
// Rejected qty never moves stock — it records the part of the request the operator
// closed out as "will not be transferred", which is why it resolves the request without
// ever counting toward the transferred total.
function transferRejectedQty(stn)  { return transferTotals(stn).rejected; }

// Requested qty for one row of a Transfer Note, from the request assignment carried on
// the note. Pooled per part/make — a line split across several source locations shares
// one requested quantity, which is exactly the level the backend validates at.
function transferRequestedLookup(stn) {
  const byKey = {};
  transferAssignedItems(stn).forEach((it) => {
    const k = transferKey(it);
    byKey[k] = (byKey[k] || 0) + (parseFloat(it.quantity) || 0);
  });
  return (row) => byKey[transferKey(row)];
}

// Live Available Qty per part/make, as served alongside the note
// (`_enrich_transfer_note_totals`). Keyed the same way the rows are, so a print never has
// to go back to the API for it.
function transferAvailableLookup(stn) {
  const byKey = {};
  (stn?.available_by_item || []).forEach((a) => { byKey[transferKey(a)] = a.available_qty; });
  return (row) => byKey[transferKey(row)];
}

// One normalized row per line of the note, whichever stage it is at. A note with no
// movement rows yet is shown through its ASSIGNED items — and on those rows `quantity` is
// the requested quantity, not a transfer, so transferred/rejected are pinned to 0.
// Without that, a freshly raised note would print "Transferred 10" before anything moved.
function transferDisplayItems(stn) {
  if ((stn?.items || []).length) {
    return (stn?.items || []).map((it) => ({
      ...it,
      moved_qty: parseFloat(it.quantity) || 0,
      rejected_qty: parseFloat(it.rejected_qty) || 0,
      row_status: transferNoteDone(stn) ? "Transferred" : "Draft",
    }));
  }
  return transferAssignedItems(stn).map((it) => ({
    ...it,
    moved_qty: 0,
    rejected_qty: 0,
    row_status: stn?.status === "PENDING" ? "Pending" : "Assigned",
  }));
}

// Live Available Qty for the note, supplied by the server. Transfer Note only — the
// Transfer Request is an office document and never shows availability.
function transferAvailableQty(stn) {
  return stn?.available_qty_total ?? null;
}

function transferNoteDone(stn) {
  return stn.status === "COMPLETED" || stn.status === "RECORDED";
}

// Transfer Request uses the standard 3-status set (Pending / In Process / Complete);
// legacy values are recognized defensively in case a cached row predates migration.
function transferRequestStatusLabel(status) {
  if (status === "COMPLETE" || status === "COMPLETED" || status === "FULLY_TRANSFERRED") return "Complete";
  if (status === "IN_PROCESS" || status === "IN_PROGRESS" || status === "PARTIALLY_TRANSFERRED") return "In Process";
  return "Pending";
}

function transferRequestStatusClass(status) {
  const label = transferRequestStatusLabel(status);
  if (label === "Complete") return "bg-green-100 text-green-800";
  if (label === "In Process") return "bg-blue-50 text-blue-800";
  return "bg-amber-50 text-amber-700";
}

// Locked (edit/delete) the moment transfer has actually started — mirrors the backend
// rule exactly, since status only leaves Pending once a Transfer Note is COMPLETED.
function transferRequestHasProcessed(status) {
  return transferRequestStatusLabel(status) !== "Pending";
}

// Transfer Note is a secondary/operational document (like Picking Note) and keeps its
// own working states rather than the 3-status set — PROCESSING is a transient lock
// state, folded into "Draft" for display, mirroring how Picking Note treats RECORDING.
function transferNoteStatusLabel(status) {
  if (status === "COMPLETED" || status === "RECORDED") return "Completed";
  if (status === "PENDING") return "Pending";
  return "Draft";
}

function transferKey(it) {
  return `${it.part_no || ""}||${it.make || ""}`;
}

// Resolves what to actually show as a request line's source/destination: prefer what a
// completed Transfer Note recorded (the real outcome); otherwise fall back to the
// currently active (not-yet-recorded) note's row, since a Transfer Note is auto-created
// the instant a request exists and mirrors whatever was last saved as the execution
// plan — so an edit made in the Transfer Note shows up here as soon as it's saved, even
// before recording. Finally falls back to whatever the request itself specified, or "-".
function transferEffectiveLocations(it, noteHistory = []) {
  const key = transferKey(it);
  const completed = [];
  const active = [];
  noteHistory.forEach((stn) => {
    (stn.items || []).forEach((row) => {
      if (transferKey(row) !== key) return;
      if ((parseFloat(row.quantity) || 0) <= 0) return;
      (transferNoteDone(stn) ? completed : active).push(row);
    });
  });
  const rows = completed.length ? completed : active;
  const dedupe = (locs) => {
    const seen = new Set();
    const out = [];
    locs.forEach((loc) => {
      if (!loc.godown_name && !loc.rack_no && !loc.box_no) return;
      const k = `${loc.godown_name || ""}||${loc.rack_no || ""}||${loc.box_no || ""}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push(loc);
    });
    return out;
  };
  let srcLocs = dedupe(rows.map((row) => ({ godown_name: row.src_godown_name, rack_no: row.src_rack_no, box_no: row.src_box_no })));
  let destLocs = dedupe(rows.map((row) => ({ godown_name: row.dest_godown_name, rack_no: row.dest_rack_no, box_no: row.dest_box_no })));
  if (!srcLocs.length) {
    srcLocs = dedupe([{ godown_name: it.src_godown_name, rack_no: it.src_rack_no, box_no: it.src_box_no }]);
  }
  if (!destLocs.length) {
    destLocs = dedupe([{ godown_name: it.dest_godown_name, rack_no: it.dest_rack_no, box_no: it.dest_box_no }]);
  }
  return { srcLocs, destLocs };
}

// Plain-text join for on-screen display (e.g. the detail dialog).
function locationCellText(locs) {
  if (!locs.length) return "-";
  return locs.map((loc) => formatLocationText(loc, "-")).join("; ");
}

// Print-only rendering: Godown, then Rack, then Box stacked on their own line inside
// the cell — deliberately without the words "Godown"/"Rack"/"Box" as labels.
function locationCellHtml(locs) {
  if (!locs.length) return "-";
  return locs.map((loc) => {
    const lines = [loc.godown_name, loc.rack_no, loc.box_no].map((p) => (p || "").trim()).filter(Boolean);
    return lines.map((p) => htmlEscape(p)).join("<br/>");
  }).join("<br/><br/>");
}

// Total Transferred and Rejected per part/make across the request's whole Transfer Note
// chain — the root note plus every continuation. Derived live rather than snapshotted, so
// a corrected note shows up on the request, its preview and its print at once. Mirrors
// `_enrich_transfer_request_totals` on the server, including its CLOSED exclusion.
function transferQtysByKey(noteHistory = []) {
  const transferred = {}, rejected = {};
  (noteHistory || []).forEach((stn) => {
    if ((stn.status || "").toUpperCase() === "CLOSED") return;
    (stn.items || []).forEach((it) => {
      const k = transferKey(it);
      transferred[k] = (transferred[k] || 0) + (parseFloat(it.quantity) || 0);
      rejected[k] = (rejected[k] || 0) + (parseFloat(it.rejected_qty) || 0);
    });
  });
  return { transferred, rejected };
}

// The Transfer Request's own five totals, aggregated over its Transfer Notes. Mirrors
// `_enrich_transfer_request_totals` (and `note_qty_totals` under it): Pending and Extra
// are floored per part/make before being summed.
function transferRequestTotals(s, noteHistory = []) {
  return transferTotals({
    assigned_items: s?.items || [],
    items: (noteHistory || [])
      .filter((stn) => (stn.status || "").toUpperCase() !== "CLOSED")
      .flatMap((stn) => stn.items || []),
  });
}

// Transfer Request print columns: Sr, Part Number, Item, Make, Source Location,
// Destination Location, Requested Qty, Transferred Qty, Pending / Extra, Rejected Qty,
// Status. No Available column — availability is the store's live concern and belongs to
// the Transfer Note alone. Every number comes from `noteQtys`/`varianceLabel`, the same
// functions the screen uses, so the sheet and the application cannot disagree.
function printTransferRequest(s, noteHistory = []) {
  const { transferred: movedByKey, rejected: rejectedByKey } = transferQtysByKey(noteHistory);
  const rows = (s.items || []).map((it, idx) => {
    const k = transferKey(it);
    const q = noteQtys(it.quantity, movedByKey[k], rejectedByKey[k]);
    // A rejected quantity resolves its share of the request just as a transferred one
    // does — the line is settled, it simply wasn't moved. Same rule the server's status
    // recompute uses, so the printed row status can never disagree with the document.
    const resolved = q.actual + q.rejected;
    const rowStatus = resolved <= 0 ? "Pending" : (resolved + 1e-6 >= q.requested ? "Complete" : "In Process");
    const eff = transferEffectiveLocations(it, noteHistory);
    const num = (v) => `<span style="text-align:right;display:block">${htmlEscape(v)}</span>`;
    return [
      String(idx + 1),
      htmlEscape(it.part_no),
      htmlEscape(it.description_1 || ""),
      htmlEscape(it.make || "—"),
      locationCellHtml(eff.srcLocs),
      locationCellHtml(eff.destLocs),
      num(q.requested),
      num(q.actual),
      num(varianceLabel(q.pending, q.extra)),
      num(q.rejected),
      htmlEscape(rowStatus),
    ];
  });
  const html = buildStandardPrintHtml({
    docTitle: "Transfer Request",
    docNo: s.str_no,
    statusLabel: transferRequestStatusLabel(s.status),
    fieldsLeft: [
      ["Transfer Request No", s.str_no],
      ["Request Date", fmtDate(s.str_date)],
      ["Purpose", s.purpose || "—"],
      ["Status", transferRequestStatusLabel(s.status)],
    ],
    fieldsRight: [
      ["Assigned To", assigneeLabel(s.assigned_to_name, s.assigned_to_email)],
      ["Created By", actorLabel(null, s.created_by)],
      ["Created At", s.created_at ? new Date(s.created_at).toLocaleString() : "—"],
    ],
    columns: [
      { label: "Sr" }, { label: "Part Number" }, { label: "Item" }, { label: "Make" },
      { label: "Source Location" }, { label: "Destination Location" },
      { label: "Requested Qty", align: "right" }, { label: "Transferred Qty", align: "right" },
      { label: "Pending / Extra", align: "right" }, { label: "Rejected Qty", align: "right" },
      { label: "Status" },
    ],
    rows,
    printedBy: actorLabel(null, s.created_by),
  });
  if (!openPrintWindow(html)) toast.error("Popup blocked — allow popups for this site to print");
}

// Transfer Note print columns: Sr, Part Number, Item, Source, Destination, Requested Qty,
// Available Qty, Transferred Qty, Pending / Extra, Rejected Qty, Receiver.
// Every number here is produced by `noteQtys` and rendered by `varianceLabel` — the same
// two functions the form, the list and the preview dialog use, so the printed sheet and
// the application can never disagree. Pending and Extra share ONE column: they are the
// two directions of one variance and can never both be non-zero on a line.
function printTransferNote(stn) {
  const requestedFor = transferRequestedLookup(stn);
  const availableFor = transferAvailableLookup(stn);
  const rows = transferDisplayItems(stn).map((it, idx) => {
    const q = noteQtys(requestedFor(it), it.moved_qty, it.rejected_qty);
    const avail = availableFor(it);
    const num = (v) => `<span style="text-align:right;display:block">${htmlEscape(v)}</span>`;
    return [
      String(idx + 1),
      htmlEscape(it.part_no),
      htmlEscape(it.description_1 || it.make || ""),
      htmlEscape([it.src_godown_name, it.src_rack_no, it.src_box_no].filter(Boolean).join(" / ") || "—"),
      htmlEscape([it.dest_godown_name, it.dest_rack_no, it.dest_box_no].filter(Boolean).join(" / ") || "—"),
      num(q.requested == null ? "—" : q.requested),
      num(avail == null ? "—" : avail),
      num(q.actual),
      num(varianceLabel(q.pending, q.extra)),
      num(q.rejected),
      htmlEscape(stn.created_by || "—"),
    ];
  });
  const html = buildStandardPrintHtml({
    docTitle: "Transfer Note",
    docNo: stn.stn_no,
    statusLabel: transferNoteStatusLabel(stn.status),
    fieldsLeft: [
      ["Transfer Note No", stn.stn_no],
      ["Transfer Note Date", fmtDate(stn.stn_date)],
      ["Transfer Request No", stn.transfer_request_no || "—"],
      ["Execution Attempt", stn.execution_attempt || 1],
      ["Status", transferNoteStatusLabel(stn.status)],
    ],
    // Quantities live only in the table below, not duplicated up here — one place to read
    // them, and no risk of the header block and the table showing different numbers.
    fieldsRight: [
      ["Assigned To", assigneeLabel(stn.parent_assigned_to_name, stn.parent_assigned_to_email)],
      ["Receiver / Created By", actorLabel(null, stn.created_by)],
    ],
    columns: [
      { label: "Sr" }, { label: "Part Number" }, { label: "Item" },
      { label: "Source" }, { label: "Destination" },
      { label: "Requested Qty", align: "right" }, { label: "Available Qty", align: "right" },
      { label: "Transferred Qty", align: "right" }, { label: "Pending / Extra", align: "right" },
      { label: "Rejected Qty", align: "right" },
      { label: "Receiver" },
    ],
    rows,
    printedBy: actorLabel(null, stn.created_by),
  });
  if (!openPrintWindow(html)) toast.error("Popup blocked — allow popups for this site to print");
}

/* ==============================================================
   STOCK TRANSFER  (Transfer Request + Transfer Note)
   ============================================================== */
export default function StockTransferPage() {
  const [tab, setTab] = useState("transfer-request");
  return (
    <div className="p-8 max-w-[1600px] mx-auto" data-testid="stock-transfer-page">
      <div className="mb-6">
        <h1 className="text-4xl font-black tracking-tight text-slate-900">Stock Transfer</h1>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="rounded-sm">
          <TabsTrigger value="transfer-request" className="rounded-sm" data-testid="tab-transfer-request">
            <FileText size={14} weight="bold" className="mr-2" /> Transfer Request
          </TabsTrigger>
          <TabsTrigger value="transfer-note" className="rounded-sm" data-testid="tab-transfer-note">
            <ArrowsLeftRight size={14} weight="bold" className="mr-2" /> Transfer Note
          </TabsTrigger>
        </TabsList>
        <TabsContent value="transfer-request"><TransferRequestTab /></TabsContent>
        <TabsContent value="transfer-note"><TransferNoteTab /></TabsContent>
      </Tabs>
    </div>
  );
}

/* =========================== TRANSFER REQUEST TAB =========================== */
function TransferRequestTab() {
  const [view, setView] = useState("list");
  const [editing, setEditing] = useState(null);
  const [openStr, setOpenStr] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const goCreate = () => { setEditing(null); setView("create"); };
  const goEdit = (s) => { setEditing(s); setView("edit"); };
  const goList = () => { setEditing(null); setView("list"); setReloadKey((k) => k + 1); };

  return (
    <>
      {view === "list" && <TransferRequestList reloadKey={reloadKey} onCreate={goCreate} onEdit={goEdit} onOpen={setOpenStr} />}
      {(view === "create" || view === "edit") && <TransferRequestForm editing={editing} onCancel={goList} onSaved={goList} />}
      <TransferRequestDetailDialog s={openStr} onClose={() => setOpenStr(null)} />
    </>
  );
}

function TransferRequestList({ reloadKey, onCreate, onEdit, onOpen }) {
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
      const res = await api.get("/transfer-requests", { params: { page, page_size: PAGE_SIZE, search: search || undefined } });
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

  const handleDelete = async (s) => {
    if (!window.confirm(`Delete ${s.str_no}?`)) return;
    try {
      await api.delete(`/transfer-requests/${s.id}`);
      toast.success(`${s.str_no} deleted`);
      load();
    } catch (err) { toast.error(formatApiError(err.response?.data?.detail) || "Could not delete"); }
  };

  const statusLabel = (r) => transferRequestStatusLabel(r.status);

  const columns = useMemo(() => [
    { key: "str_date", label: "TRANSFER REQUEST DATE", value: (r) => fmtDate(r.str_date) },
    { key: "str_no", label: "TRANSFER REQUEST NO", value: (r) => r.str_no || "" },
    { key: "purpose", label: "PURPOSE", value: (r) => r.purpose || "" },
    { key: "items_count", label: "ITEMS", value: (r) => (r.items || []).length},
    // The four quantities the request aggregates from its Transfer Notes. Pending and
    // Extra are one calculated column — numeric here so it still sorts and filters, and
    // rendered as the same signed number the cell below (and the print) shows.
    { key: "qty_total", label: "REQUESTED", value: (r) => r.requested_qty_total ?? qtySum(r.items), isQty: true, isNumeric: true },
    { key: "moved_qty", label: "TRANSFERRED", value: (r) => r.transferred_qty_total ?? 0, isQty: true, isNumeric: true },
    { key: "rejected_qty", label: "REJECTED", value: (r) => r.rejected_qty_total ?? 0, isQty: true, isNumeric: true },
    { key: "variance_qty", label: "PENDING / EXTRA", value: (r) => varianceValue(r.pending_qty_total ?? 0, r.extra_qty_total ?? 0), isQty: true, isNumeric: true },
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
    exportToExcel(filteredRows, exportCols, `Transfer_Requests_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="mt-4" data-testid="str-list-view">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input
            ref={searchInputRef}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search transfer requests…"
            className="rounded-sm font-mono h-9 pl-10 w-full"
            data-testid="str-search-input"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleExport} variant="outline" className="rounded-sm border-slate-300" data-testid="str-export-button">
            <DownloadSimple size={14} weight="bold" className="mr-2" /> Export
          </Button>
          <Button onClick={load} variant="outline" className="rounded-sm border-slate-300" disabled={loading} data-testid="str-refresh-button">
            <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button onClick={onCreate} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="create-str-button">
            <Plus size={16} weight="bold" className="mr-2" /> Create New Transfer Request
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-between mb-3 text-xs text-slate-600">
        <div>
        {total === 0 ? "No transfer requests" : (
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
              <th className="text-right">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r, idx) => {
              const totalQty = r.requested_qty_total ?? qtySum(r.items);
              const movedQty = r.transferred_qty_total ?? 0;
              const rejectedQty = r.rejected_qty_total ?? 0;
              // Editable only until the first quantity is transferred/rejected — matches
              // the backend rule (a transfer note with processed qty flips status off Pending).
              const hasNotes = transferRequestHasProcessed(r.status);
              const lockedToOther = !!r.assigned_to_user_id && r.assigned_to_user_id !== me?.id && !isAdmin;
              const lock = hasNotes || lockedToOther;
              const editTitle = hasNotes ? "Cannot edit — transfer has already started"
                : (lockedToOther ? `Locked — assigned to ${assigneeLabel(r.assigned_to_name, r.assigned_to_email)}` : "Edit");
              const deleteTitle = hasNotes ? "Cannot delete — transfer has already started"
                : (lockedToOther ? `Locked — assigned to ${assigneeLabel(r.assigned_to_name, r.assigned_to_email)}` : "Delete");
              const label = statusLabel(r);
              const cls = transferRequestStatusClass(r.status);
              return (
                <tr key={r.id} data-testid={`str-row-${r.str_no}`}>
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td className="font-mono text-slate-700 date-cell">{fmtDate(r.str_date)}</td>
                  <td>
                    <button onClick={() => onOpen(r)} className="font-mono font-semibold text-blue-700 hover:underline" data-testid={`str-open-${r.str_no}`}>
                      {r.str_no}
                    </button>
                  </td>
                  <td className="text-slate-700 max-w-[280px] truncate">{r.purpose || "—"}</td>
                  <td className="text-left font-mono text-slate-600">{(r.items || []).length}</td>
                  <td className="text-left font-mono font-bold text-slate-900 tabular-nums">{totalQty || "—"}</td>
                  <td className="text-left font-mono font-bold text-slate-900 tabular-nums">{movedQty}</td>
                  <td className={`text-left font-mono font-bold tabular-nums ${rejectedQty > 0 ? "text-red-700" : "text-slate-400"}`}>{rejectedQty}</td>
                  {/* Pending / Extra — one calculated field, worded exactly as it is on the
                      note, the preview and the printed sheet (see `varianceLabel`). */}
                  <td className={`text-left font-mono font-bold tabular-nums ${varianceClass(r.pending_qty_total, r.extra_qty_total)}`}
                    title={varianceTitle(totalQty, movedQty, rejectedQty, r.pending_qty_total, r.extra_qty_total)}>
                    {varianceLabel(r.pending_qty_total ?? 0, r.extra_qty_total ?? 0)}
                  </td>
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${cls}`} data-testid={`str-status-${r.str_no}`}>{label}</span>
                  </td>
                  <td className="text-left whitespace-nowrap">
                    <button onClick={() => onEdit(r)} disabled={lock}
                      title={editTitle}
                      className={`p-1.5 rounded-sm mr-1 ${lock ? "text-slate-300 cursor-not-allowed" : "hover:bg-slate-100"}`}
                      data-testid={`str-edit-${r.str_no}`}>
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => handleDelete(r)} disabled={lock}
                      title={deleteTitle}
                      className={`p-1.5 rounded-sm ${lock ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                      data-testid={`str-delete-${r.str_no}`}>
                      <Trash size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && (
              <tr><td colSpan={columns.length + 2} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? "No transfer requests. Click 'Create New Transfer Request' to begin." : "No rows match the current filters.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TransferRequestDetailDialog({ s, onClose }) {
  const [history, setHistory] = useState([]);

  useEffect(() => {
    if (!s?.id) {
      setHistory([]);
      return;
    }
    api.get("/transfer-notes", { params: { transfer_request_id: s.id, page_size: 100 } })
      .then((r) => setHistory(r.data || []))
      .catch(() => setHistory([]));
  }, [s?.id]);

  // Both derived from the SAME roll-up the print uses, so the dialog and the printed
  // sheet are literally the same document with the same numbers.
  const totals = transferRequestTotals(s, history);
  const { transferred: movedByKey, rejected: rejectedByKey } = transferQtysByKey(history);

  return (
    <Dialog open={!!s} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto rounded-sm" data-testid="str-detail-dialog">
        {s && (
          <>
            <div className="text-center text-xl font-black tracking-widest uppercase pt-1 pb-2 border-b border-slate-200">
              TRANSFER REQUEST
            </div>
            <div className="grid grid-cols-2 gap-6 text-sm pt-3 pb-4 border-b border-slate-200">
              <div className="space-y-2">
                <Detail k="TRANSFER REQUEST DATE" v={fmtDate(s.str_date)} />
                <Detail k="TRANSFER REQUEST NO" v={s.str_no} />
                <Detail k="PURPOSE" v={s.purpose || "—"} />
                <Detail k="STATUS" v={
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${transferRequestStatusClass(s.status)}`}>
                    {transferRequestStatusLabel(s.status)}
                  </span>
                } />
              </div>
              <div className="space-y-2">
                <Detail k="CREATED BY" v={actorLabel(null, s.created_by)} />
                <Detail k="CREATED AT" v={s.created_at ? new Date(s.created_at).toLocaleString() : "—"} />
                <div>
                  <div className="label-sm">ASSIGNED TO</div>
                  <div className="mt-1"><AssigneeBadge name={s.assigned_to_name} email={s.assigned_to_email} /></div>
                </div>
              </div>
            </div>
            {/* Request totals, aggregated across every Transfer Note raised against this
                request. Same four numbers as the print sheet and as each line's columns
                below, from the same helper — they cannot drift apart. */}
            <div className="mt-3 grid grid-cols-4 gap-3 bg-slate-50 border border-slate-200 rounded-sm px-4 py-3 text-sm">
              <Detail k="REQUESTED QTY" v={<span className="font-bold">{totals.requested || "—"}</span>} />
              <Detail k="TRANSFERRED QTY" v={<span className="font-bold">{totals.transferred}</span>} />
              <Detail k="PENDING / EXTRA" v={
                <span className={`font-bold ${varianceClass(totals.pending, totals.extra)}`}
                  title={varianceTitle(totals.requested, totals.transferred, totals.rejected, totals.pending, totals.extra)}>
                  {varianceLabel(totals.pending, totals.extra)}
                </span>
              } />
              <Detail k="REJECTED QTY" v={<span className={`font-bold ${totals.rejected > 0 ? "text-red-700" : "text-slate-500"}`}>{totals.rejected}</span>} />
            </div>
            <div className="mt-2">
              <div className="label-sm mb-2">Items ({(s.items || []).length})</div>
              <div className="overflow-x-auto">
                <table className="data-table w-full text-xs">
                  <thead>
                    <tr>
                      <th>SL NO.</th><th>PART NO</th><th>MAKE</th><th>DESCRIPTION</th>
                      <th className="text-center">REQUESTED QTY</th>
                      <th className="text-center">TRANSFERRED QTY</th>
                      <th className="text-center">PENDING / EXTRA</th>
                      <th className="text-center">REJECTED QTY</th>
                      <th>SOURCE LOCATION</th><th>DESTINATION LOCATION</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(s.items || []).map((it, idx) => {
                      const eff = transferEffectiveLocations(it, history);
                      // Transferred and Rejected are derived live from the Transfer Notes,
                      // so a corrected note is reflected here the next time the request is
                      // opened — nothing is snapshotted.
                      const k = transferKey(it);
                      const q = noteQtys(it.quantity, movedByKey[k], rejectedByKey[k]);
                      return (
                        <tr key={idx}>
                          <td className="font-mono text-slate-500">{idx + 1}</td>
                          <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                          <td>{it.make}</td>
                          <td className="text-slate-700 max-w-[260px] truncate">{it.description_1 || "—"}</td>
                          <td className="text-center font-mono font-bold">{q.requested}</td>
                          <td className="text-center font-mono font-bold">{q.actual}</td>
                          <td className={`text-center font-mono font-bold ${varianceClass(q.pending, q.extra)}`}
                            title={varianceTitle(q.requested, q.actual, q.rejected, q.pending, q.extra)}>
                            {varianceLabel(q.pending, q.extra)}
                          </td>
                          <td className={`text-center font-mono font-bold ${q.rejected > 0 ? "text-red-700" : "text-slate-400"}`}>
                            {q.rejected || "—"}
                          </td>
                          <td className="text-slate-600">{locationCellText(eff.srcLocs)}</td>
                          <td className="text-slate-600">{locationCellText(eff.destLocs)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="mt-6 border-t border-slate-200 pt-4">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-700 mb-2 pb-1 border-b border-slate-200">Transfer Note History</div>
              <table className="data-table w-full text-xs">
                <thead>
                  <tr><th>STN NO</th><th>ATTEMPT</th><th>PARENT STN</th><th className="text-center">REQUESTED</th><th className="text-center">TRANSFERRED</th><th className="text-center">PENDING / EXTRA</th><th className="text-center">REJECTED</th><th>STATUS</th></tr>
                </thead>
                <tbody>
                  {[...history].sort((a, b) => (a.execution_attempt || 1) - (b.execution_attempt || 1)).map((stn) => {
                    const parent = history.find((h) => h.id === stn.parent_transfer_note_id);
                    const done = transferNoteDone(stn);
                    const t = transferTotals(stn);
                    return (
                      <tr key={stn.id}>
                        <td className="font-mono font-semibold">{stn.stn_no}</td>
                        <td className="font-mono">{stn.execution_attempt || 1}</td>
                        <td className="font-mono">{parent?.stn_no || "—"}</td>
                        <td className="text-center font-mono font-bold">{t.requested || "—"}</td>
                        <td className="text-center font-mono font-bold">{t.transferred}</td>
                        {/* Pending is what carries into the next Transfer Note. */}
                        <td className={`text-center font-mono font-bold ${varianceClass(t.pending, t.extra)}`}
                          title={varianceTitle(t.requested, t.transferred, t.rejected, t.pending, t.extra)}>
                          {varianceLabel(t.pending, t.extra)}
                        </td>
                        <td className={`text-center font-mono font-bold ${t.rejected > 0 ? "text-red-700" : "text-slate-400"}`}
                          title={t.rejected > 0 ? "Refused — no stock moved and no follow-up note is raised for it" : ""}>
                          {t.rejected}
                        </td>
                        <td>
                          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${done ? "bg-green-100 text-green-800" : (stn.status === "PENDING" ? "bg-blue-50 text-blue-800" : "bg-amber-50 text-amber-700")}`}>
                            {transferNoteStatusLabel(stn.status)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {history.length === 0 && <tr><td colSpan={8} className="text-center py-6 text-slate-500">No transfer notes yet.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-2 pt-4 border-t border-slate-200 mt-6">
              <Button variant="outline" size="sm" className="rounded-sm" onClick={() => printTransferRequest(s, history)} data-testid="str-detail-print">
                <Printer size={14} weight="bold" className="mr-1.5" /> Print
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const emptyTransferReqItem = () => ({
  part_no: "", make: "", model: "", quantity: "", makes: [], partLooked: false, available_qty: 0,
  // All optional — leave blank to let the Transfer Note auto-resolve against current
  // inventory when it's prepared. As much or as little as is known can be specified.
  src_godown_id: "", src_godown_name: "",
  src_rack_id: "", src_rack_no: "",
  src_box_id: "", src_box_no: "", src_box_category: "",
  dest_godown_id: "", dest_godown_name: "",
  dest_rack_id: "", dest_rack_no: "",
  dest_box_id: "", dest_box_no: "", dest_box_category: "",
});

function TransferRequestForm({ editing, onCancel, onSaved }) {
  const isEdit = !!editing;
  const [strNo, setStrNo] = useState("");
  const [strDate, setStrDate] = useState("");
  const [purpose, setPurpose] = useState("");
  const [items, setItems] = useState([emptyTransferReqItem()]);
  const [addCount, setAddCount] = useState("");
  const [saving, setSaving] = useState(false);
  const [assignedToUserId, setAssignedToUserId] = useState("");

  const [godowns, setGodowns] = useState([]);
  const [racksByGodown, setRacksByGodown] = useState({});
  const [boxesByRack, setBoxesByRack] = useState({});

  useEffect(() => { api.get("/godowns").then((r) => setGodowns(r.data)); }, []);

  const ensureRacks = useCallback(async (gid) => {
    if (!gid || racksByGodown[gid]) return;
    const { data } = await api.get("/racks", { params: { godown_id: gid } });
    setRacksByGodown((p) => ({ ...p, [gid]: data }));
  }, [racksByGodown]);
  const ensureBoxes = useCallback(async (rid) => {
    if (!rid || boxesByRack[rid]) return;
    const { data } = await api.get("/boxes", { params: { rack_id: rid } });
    setBoxesByRack((p) => ({ ...p, [rid]: data }));
  }, [boxesByRack]);

  useEffect(() => {
    if (isEdit) {
      setStrNo(editing.str_no || "");
      setStrDate(editing.str_date || "");
      setPurpose(editing.purpose || "");
      setAssignedToUserId(editing.assigned_to_user_id || "");
      const initial = (editing.items || []).map((it) => ({
        ...emptyTransferReqItem(),
        ...it,
        quantity: it.quantity ?? "",
        makes: it.make ? [{ make: it.make, available_qty: 0 }] : [],
        partLooked: !!it.part_no,
      }));
      setItems(initial.length ? initial : [emptyTransferReqItem()]);
      initial.forEach((row, idx) => {
        if (!row.part_no) return;
        api.get(`/transfer-requests/lookup/${encodeURIComponent(row.part_no)}`)
          .then(({ data }) => {
            const makesArr = data.makes || [];
            const found = makesArr.find((m) => m.make === row.make);
            setItems((prev) => prev.map((r, i) => i === idx ? { ...r, makes: makesArr, model: r.model || found?.model || "", available_qty: found?.available_qty || 0 } : r));
          })
          .catch(() => {});
        if (row.src_godown_id) ensureRacks(row.src_godown_id);
        if (row.src_rack_id) ensureBoxes(row.src_rack_id);
        if (row.dest_godown_id) ensureRacks(row.dest_godown_id);
        if (row.dest_rack_id) ensureBoxes(row.dest_rack_id);
      });
    } else {
      api.get("/transfer-requests/next-no").then((r) => { setStrNo(r.data.next_str_no); setStrDate(r.data.str_date); })
        .catch(() => toast.error("Could not preview transfer-request number"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, editing]);

  const addItems = () => {
    const n = Math.max(1, Math.min(500, parseInt(addCount, 10) || 1));
    setItems((p) => [...p, ...Array.from({ length: n }, emptyTransferReqItem)]);
    setAddCount("");
  };
  const removeItem = (i) => setItems((p) => (p.length === 1 ? p : p.filter((_, idx) => idx !== i)));
  const updateItem = (i, patch) => setItems((p) => p.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  const lookupMakes = async (i, partNo) => {
    const v = (partNo || "").trim();
    if (!v) { updateItem(i, { makes: [], make: "", partLooked: false, available_qty: 0 }); return; }
    try {
      const { data } = await api.get(`/transfer-requests/lookup/${encodeURIComponent(v)}`);
      const list = data.makes || [];
      const auto = list.length === 1 ? list[0] : null;
      updateItem(i, {
        makes: list, partLooked: true,
        make: auto ? auto.make : "",
        model: auto ? (auto.model || "") : "",
        available_qty: auto ? auto.available_qty : 0,
      });
    } catch { updateItem(i, { makes: [], partLooked: true, make: "", model: "", available_qty: 0 }); }
  };

  const onMakeChange = (i, makeVal) => {
    const row = items[i];
    const found = (row.makes || []).find((m) => m.make === makeVal);
    updateItem(i, { make: makeVal, model: found?.model || "", available_qty: found?.available_qty || 0 });
  };

  // Quantity is clamped to live availability — the source location's balance once one is
  // chosen, otherwise the part/make total. Nothing over-stock can be typed, so the row
  // never enters an "over" state that has to be flagged and then rejected on save.
  const onReqQtyChange = (i, raw, cap) => {
    if (raw === "") { updateItem(i, { quantity: "" }); return; }
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 0) return;
    updateItem(i, { quantity: String(Math.min(n, cap || 0)) });
  };

  // Recompute the row's location-specific available qty (undefined = no source
  // selected, fall back to the part/make grand total) whenever the source changes.
  const refreshLocationQty = async (i, patch) => {
    const row = { ...items[i], ...patch };
    if (!row.src_godown_id) { updateItem(i, { location_available_qty: undefined }); return; }
    try {
      const { data } = await api.get(`/transfer-requests/lookup-locations/${encodeURIComponent(row.part_no)}/${encodeURIComponent(row.make)}`);
      const locs = data.locations || [];
      const match = locs.filter((L) =>
        L.godown_id === row.src_godown_id &&
        (!row.src_rack_id || L.rack_id === row.src_rack_id) &&
        (!row.src_box_id || L.box_id === row.src_box_id)
      );
      const qty = match.reduce((s, L) => s + (L.current_qty || 0), 0);
      updateItem(i, { location_available_qty: qty });
    } catch { updateItem(i, { location_available_qty: 0 }); }
  };

  const onSrcGodownChange = async (i, gid) => {
    if (gid === NO_LOCATION) {
      const patch = { src_godown_id: "", src_godown_name: "", src_rack_id: "", src_rack_no: "", src_box_id: "", src_box_no: "", src_box_category: "" };
      updateItem(i, patch);
      await refreshLocationQty(i, patch);
      return;
    }
    const g = godowns.find((x) => x.id === gid);
    const patch = {
      src_godown_id: gid, src_godown_name: g?.godown_name || "",
      src_rack_id: "", src_rack_no: "", src_box_id: "", src_box_no: "", src_box_category: "",
    };
    updateItem(i, patch);
    await ensureRacks(gid);
    await refreshLocationQty(i, patch);
  };
  const onSrcRackChange = async (i, rid) => {
    if (rid === NO_LOCATION) {
      const patch = { src_rack_id: "", src_rack_no: "", src_box_id: "", src_box_no: "", src_box_category: "" };
      updateItem(i, patch);
      await refreshLocationQty(i, patch);
      return;
    }
    const racks = racksByGodown[items[i].src_godown_id] || [];
    const rk = racks.find((x) => x.id === rid);
    const patch = {
      src_rack_id: rid, src_rack_no: rk?.rack_no || "",
      src_box_id: "", src_box_no: "", src_box_category: "",
    };
    updateItem(i, patch);
    await ensureBoxes(rid);
    await refreshLocationQty(i, patch);
  };
  const onSrcBoxChange = async (i, bid) => {
    if (bid === NO_LOCATION) {
      const patch = { src_box_id: "", src_box_no: "", src_box_category: "" };
      updateItem(i, patch);
      await refreshLocationQty(i, patch);
      return;
    }
    const boxes = boxesByRack[items[i].src_rack_id] || [];
    const bx = boxes.find((x) => x.id === bid);
    const patch = { src_box_id: bid, src_box_no: bx?.box_no || "", src_box_category: bx?.box_category || "" };
    updateItem(i, patch);
    await refreshLocationQty(i, patch);
  };

  const onDestGodownChange = async (i, gid) => {
    const g = godowns.find((x) => x.id === gid);
    updateItem(i, {
      dest_godown_id: gid, dest_godown_name: g?.godown_name || "",
      dest_rack_id: "", dest_rack_no: "", dest_box_id: "", dest_box_no: "", dest_box_category: "",
    });
    await ensureRacks(gid);
  };
  const onDestRackChange = async (i, rid) => {
    const racks = racksByGodown[items[i].dest_godown_id] || [];
    const rk = racks.find((x) => x.id === rid);
    updateItem(i, {
      dest_rack_id: rid, dest_rack_no: rk?.rack_no || "",
      dest_box_id: "", dest_box_no: "", dest_box_category: "",
    });
    await ensureBoxes(rid);
  };
  const onDestBoxChange = (i, bid) => {
    const boxes = boxesByRack[items[i].dest_rack_id] || [];
    const bx = boxes.find((x) => x.id === bid);
    updateItem(i, { dest_box_id: bid, dest_box_no: bx?.box_no || "", dest_box_category: bx?.box_category || "" });
  };

  const requestedByKey = useMemo(() => {
    const m = {};
    items.forEach((r) => {
      if (!r.part_no || !r.make) return;
      const k = `${r.part_no}||${r.make}`;
      m[k] = (m[k] || 0) + (parseInt(r.quantity) || 0);
    });
    return m;
  }, [items]);

  // Rows whose quantity no longer fits current stock. Typing is clamped, so this can
  // only happen when stock fell after the request was saved.
  const shortRows = items.reduce((n, r) => {
    if (!r.make) return n;
    const avail = r.src_godown_id ? (r.location_available_qty || 0) : (r.available_qty || 0);
    return n + ((parseInt(r.quantity) || 0) > avail ? 1 : 0);
  }, 0);

  const save = async () => {
    if (items.length === 0) { toast.error("Add at least one item"); return; }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.part_no.trim()) { toast.error(`Row ${i + 1}: Part No required`); return; }
      if (!it.make.trim()) { toast.error(`Row ${i + 1}: Make required`); return; }
      // 0 is a legitimate request: it names the item and where it should end up and
      // leaves the quantity to the operator, who records whatever actually moves as an
      // Extra on the Transfer Note. Only a blank or negative number is meaningless.
      const q = parseInt(it.quantity);
      if (isNaN(q) || q < 0) { toast.error(`Row ${i + 1}: Quantity cannot be negative`); return; }
      if (it.src_godown_id) {
        const locAvail = it.location_available_qty || 0;
        if (q > locAvail + 1e-6) {
          toast.error(`Row ${i + 1}: ${it.part_no}/${it.make} — only ${locAvail} at the selected location`);
          return;
        }
      } else if (q > (it.available_qty || 0) + 1e-6) {
        toast.error(`Row ${i + 1}: ${it.part_no}/${it.make} — only ${it.available_qty} in stock`);
        return;
      }
    }
    for (const [k, total] of Object.entries(requestedByKey)) {
      const [p, m] = k.split("||");
      const row = items.find((r) => r.part_no === p && r.make === m);
      const avail = row?.available_qty || 0;
      if (total > avail + 1e-6) {
        toast.error(`${p}/${m}: total requested across rows is ${total} but only ${avail} in stock`);
        return;
      }
    }
    setSaving(true);
    try {
      const payload = {
        purpose: purpose.trim(),
        assigned_to_user_id: assignedToUserId || null,
        items: items.map((it) => ({
          part_no: it.part_no.trim(), make: it.make.trim(), quantity: parseInt(it.quantity),
          src_godown_id: it.src_godown_id || "", src_godown_name: it.src_godown_name || "",
          src_rack_id: it.src_rack_id || "", src_rack_no: it.src_rack_no || "",
          src_box_id: it.src_box_id || "", src_box_no: it.src_box_no || "", src_box_category: it.src_box_category || "",
          dest_godown_id: it.dest_godown_id || "", dest_godown_name: it.dest_godown_name || "",
          dest_rack_id: it.dest_rack_id || "", dest_rack_no: it.dest_rack_no || "",
          dest_box_id: it.dest_box_id || "", dest_box_no: it.dest_box_no || "", dest_box_category: it.dest_box_category || "",
        })),
      };
      const { data } = isEdit
        ? await api.put(`/transfer-requests/${editing.id}`, payload)
        : await api.post("/transfer-requests", payload);
      toast.success(`Transfer Request ${data.str_no} ${isEdit ? "updated" : "saved"}`);
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save");
    } finally { setSaving(false); }
  };

  return (
    <div className="mt-4 space-y-6" data-testid="str-create-view">
      <div className="flex items-center justify-between">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="str-back-button">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
        <Button onClick={save} disabled={saving} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="str-save-button">
          <FloppyDisk size={14} weight="bold" className="mr-2" /> {saving ? "Saving…" : (isEdit ? "Update Transfer Request" : "Save Transfer Request")}
        </Button>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm p-6 grid grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <Label className="label-sm">Request Date</Label>
          <Input value={strDate} disabled className="mt-2 rounded-sm font-mono bg-slate-50" data-testid="str-date-input" />
        </div>
        <div>
          <Label className="label-sm">Request No</Label>
          <Input value={strNo} disabled className="mt-2 rounded-sm font-mono font-semibold bg-blue-50 text-blue-900" data-testid="str-no-input" />
        </div>
        <div>
          <Label className="label-sm">Purpose</Label>
          <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. relocate to A-rack"
            className="mt-2 rounded-sm" data-testid="str-purpose-input" />
        </div>
        <div className="col-span-2">
          <AssigneeSelect value={assignedToUserId} onChange={setAssignedToUserId} module="stock_transfer" testid="str-assignee" />
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm">
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="label-sm">Items to Transfer</div>
              {shortRows > 0 && (
                <span className="text-[11px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-sm px-2 py-0.5" data-testid="str-short-banner">
                  {shortRows} row{shortRows > 1 ? "s" : ""} exceed current stock — availability has changed
                </span>
              )}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">{items.length} row{items.length !== 1 ? "s" : ""} · source and destination are both optional — specify as much as you know (godown only, godown+rack, or leave blank), the Transfer Note resolves the rest against current stock</div>
          </div>
          <div className="flex items-center gap-2">
            <Input type="number" min="1" max="500" value={addCount} onChange={(e) => setAddCount(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addItems(); } }}
              placeholder="Qty" className="rounded-sm font-mono h-9 w-24 text-center" data-testid="str-add-row-count" />
            <Button onClick={addItems} variant="outline" className="rounded-sm" data-testid="str-add-row-button">
              <Plus size={14} weight="bold" className="mr-1" /> Add Row{addCount && parseInt(addCount, 10) > 1 ? "s" : ""}
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto">
          {/* Fixed layout + colgroup: with auto layout the browser treats width classes
              as hints and redistributes the slack, which is what left a gap between the
              auto-filled Model and Make. These widths are exact. */}
          <table className="data-table data-table-fixed w-full min-w-[1420px]">
            <colgroup>
              <col style={{ width: "60px" }} />
              <col style={{ width: "170px" }} />
              <col style={{ width: "96px" }} />
              <col style={{ width: "150px" }} />
              <col style={{ width: "112px" }} />
              <col style={{ width: "148px" }} />
              <col style={{ width: "118px" }} />
              <col style={{ width: "118px" }} />
              <col style={{ width: "148px" }} />
              <col style={{ width: "118px" }} />
              <col style={{ width: "118px" }} />
              <col style={{ width: "56px" }} />
            </colgroup>
            <thead>
              <tr>
                <th>SL NO.</th><th>PART NO</th><th>MODEL</th><th>MAKE</th><th className="!text-center">QTY</th>
                <th>SOURCE GODOWN</th><th>SOURCE RACK</th><th>SOURCE BOX</th>
                <th>DEST GODOWN</th><th>DEST RACK</th><th>DEST BOX</th><th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => {
                const effAvail = it.src_godown_id ? (it.location_available_qty || 0) : (it.available_qty || 0);
                const atCap = effAvail > 0 && (parseInt(it.quantity) || 0) === effAvail;
                // Typing is clamped to availability, so a quantity can only exceed it if
                // stock fell after this request was saved (consumed by a Stock Out, a
                // transfer, or a correction). Flag it rather than silently rewriting the
                // operator's number.
                const shortNow = it.make && (parseInt(it.quantity) || 0) > effAvail;
                const srcRacks = racksByGodown[it.src_godown_id] || [];
                const srcBoxes = boxesByRack[it.src_rack_id] || [];
                const destRacks = racksByGodown[it.dest_godown_id] || [];
                const destBoxes = boxesByRack[it.dest_rack_id] || [];
                return (
                  <tr key={idx} data-testid={`str-item-row-${idx}`} className={shortNow ? "bg-amber-50" : ""}>
                    <td className="font-mono text-slate-500">{idx + 1}</td>
                    <td>
                      <Input value={it.part_no}
                        onChange={(e) => updateItem(idx, { part_no: e.target.value, partLooked: false, makes: [], make: "", model: "", available_qty: 0 })}
                        onBlur={(e) => lookupMakes(idx, e.target.value)}
                        onKeyDown={async (e) => {
                          // The Make dropdown is disabled until the part lookup resolves,
                          // so a plain Tab lands nowhere. Hold focus, look up, then hand
                          // focus to Make. Model in between is auto-fetched and skipped.
                          if (e.key !== "Tab" || e.shiftKey) return;
                          e.preventDefault();
                          if (!it.partLooked) await lookupMakes(idx, e.target.value);
                          document.querySelector(`[data-testid="str-make-${idx}"]`)?.focus();
                        }}
                        placeholder="Enter part no" className="rounded-sm font-mono h-9 text-base" data-testid={`str-part-no-${idx}`} />
                    </td>
                    <td>
                      <div className="h-9 flex items-center font-mono text-sm text-slate-700 truncate" data-testid={`str-model-${idx}`}>
                        {it.model || <span className="text-slate-400 italic">—</span>}
                      </div>
                    </td>
                    <td>
                      <Select disabled={!it.partLooked || it.makes.length === 0}
                        value={it.make || undefined} onValueChange={(v) => onMakeChange(idx, v)}>
                        <SelectTrigger className="rounded-sm h-9 w-full [&>span]:truncate" data-testid={`str-make-${idx}`}>
                          <SelectValue placeholder={!it.partLooked ? "Enter Part No first" : (it.makes.length === 0 ? "No stock" : "Select make")} />
                        </SelectTrigger>
                        <SelectContent>
                          {it.makes.map((m) => (
                            <SelectItem key={m.make} value={m.make} data-testid={`str-make-${idx}-option-${m.make}`}>
                              <span className="font-mono">{m.make}</span>
                              <span className="ml-3 text-xs text-slate-500">avail {m.available_qty}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td>
                      <Input type="number" min="0" step="1" value={it.quantity} disabled={!it.make}
                        max={effAvail || undefined}
                        onChange={(e) => onReqQtyChange(idx, e.target.value, effAvail)}
                        title={it.make ? `Up to ${effAvail} available` : undefined}
                        placeholder="0"
                        className={`rounded-sm font-mono h-9 text-center text-base ${shortNow ? "border-amber-500" : ""}`}
                        data-testid={`str-qty-${idx}`} />
                      {it.make && (
                        <div className={`text-[10px] mt-0.5 ${shortNow ? "text-amber-700 font-bold" : (atCap ? "text-amber-600 font-bold" : "text-slate-500")}`} data-testid={`str-avail-hint-${idx}`}>
                          {atCap && !shortNow ? `Max ${effAvail}` : `Avail ${effAvail}`}
                        </div>
                      )}
                      {shortNow && (
                        <div className="text-[10px] text-amber-800 mt-1 leading-tight" data-testid={`str-short-warning-${idx}`}>
                          Stock dropped to {effAvail} since this request was created.
                          <button
                            type="button"
                            onClick={() => updateItem(idx, { quantity: String(effAvail) })}
                            className="ml-1 underline font-bold hover:text-amber-900"
                            data-testid={`str-use-avail-${idx}`}
                          >
                            Use {effAvail}
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="w-44">
                      <Select value={it.src_godown_id || undefined} onValueChange={(v) => onSrcGodownChange(idx, v)}>
                        <SelectTrigger className="rounded-sm h-8" data-testid={`str-src-godown-${idx}`}>
                          <SelectValue placeholder="Optional" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_LOCATION}>No preference</SelectItem>
                          {godowns.map((g) => <SelectItem key={g.id} value={g.id}>{g.godown_name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="w-32">
                      <Select disabled={!it.src_godown_id} value={it.src_rack_id || undefined} onValueChange={(v) => onSrcRackChange(idx, v)}>
                        <SelectTrigger className="rounded-sm h-8" data-testid={`str-src-rack-${idx}`}>
                          <SelectValue placeholder="—" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_LOCATION}>No preference</SelectItem>
                          {srcRacks.map((r) => <SelectItem key={r.id} value={r.id} className="font-mono">{r.rack_no}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="w-32">
                      <Select disabled={!it.src_rack_id || srcBoxes.length === 0} value={it.src_box_id || undefined} onValueChange={(v) => onSrcBoxChange(idx, v)}>
                        <SelectTrigger className="rounded-sm h-8" data-testid={`str-src-box-${idx}`}>
                          <SelectValue placeholder={srcBoxes.length === 0 ? "—" : "Optional"} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_LOCATION}>No preference</SelectItem>
                          {srcBoxes.map((b) => <SelectItem key={b.id} value={b.id} className="font-mono">{b.box_no}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="w-44">
                      <Select value={it.dest_godown_id || undefined} onValueChange={(v) => onDestGodownChange(idx, v)}>
                        <SelectTrigger className="rounded-sm h-8" data-testid={`str-dest-godown-${idx}`}>
                          <SelectValue placeholder="Optional" />
                        </SelectTrigger>
                        <SelectContent>
                          {godowns.map((g) => <SelectItem key={g.id} value={g.id}>{g.godown_name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="w-32">
                      <Select disabled={!it.dest_godown_id} value={it.dest_rack_id || undefined} onValueChange={(v) => onDestRackChange(idx, v)}>
                        <SelectTrigger className="rounded-sm h-8" data-testid={`str-dest-rack-${idx}`}>
                          <SelectValue placeholder="—" />
                        </SelectTrigger>
                        <SelectContent>
                          {destRacks.map((r) => <SelectItem key={r.id} value={r.id} className="font-mono">{r.rack_no}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="w-32">
                      <Select disabled={!it.dest_rack_id || destBoxes.length === 0} value={it.dest_box_id || undefined} onValueChange={(v) => onDestBoxChange(idx, v)}>
                        <SelectTrigger className="rounded-sm h-8" data-testid={`str-dest-box-${idx}`}>
                          <SelectValue placeholder={destBoxes.length === 0 ? "—" : "Box"} />
                        </SelectTrigger>
                        <SelectContent>
                          {destBoxes.map((b) => <SelectItem key={b.id} value={b.id} className="font-mono">{b.box_no}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                    <td>
                      <button onClick={() => removeItem(idx)} disabled={items.length === 1}
                        onKeyDown={(e) => {
                          // End of the last row — the Save button sits above the table in
                          // DOM order, so forward Tab would otherwise leave the form.
                          if (e.key === "Tab" && !e.shiftKey && idx === items.length - 1) {
                            e.preventDefault();
                            document.querySelector('[data-testid="str-save-button"]')?.focus();
                          }
                        }}
                        className={`p-1.5 rounded-sm ${items.length === 1 ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                        data-testid={`str-remove-row-${idx}`}><Trash size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* =========================== TRANSFER NOTE TAB =========================== */
function TransferNoteTab() {
  const [view, setView] = useState("list");
  const [editing, setEditing] = useState(null);
  const [openStn, setOpenStn] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const goEdit = (s) => { setEditing(s); setView("edit"); };
  const goList = () => { setEditing(null); setView("list"); setReloadKey((k) => k + 1); };

  return (
    <>
      {view === "list" && <TransferNoteList reloadKey={reloadKey} onEdit={goEdit} onOpen={setOpenStn} onRecorded={() => setReloadKey((k) => k + 1)} />}
      {view === "edit" && <TransferNoteForm editing={editing} onCancel={goList} onSaved={goList} />}
      <TransferNoteDetailDialog stn={openStn} onClose={() => setOpenStn(null)} />
    </>
  );
}

function TransferNoteList({ reloadKey, onEdit, onOpen, onRecorded }) {
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
      const res = await api.get("/transfer-notes", { params: { page, page_size: PAGE_SIZE, search: search || undefined } });
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

  // Completion is refused while any row asks for more than its source currently holds.
  // The server enforces this inside the transaction regardless; checking here first means
  // the operator gets the same explanation the edit form gives — naming the row, the
  // location and the real figure — instead of a bare failure after confirming.
  const blockingShortfall = async (stn) => {
    const { data } = await api.get(`/transfer-notes/prepare/${stn.transfer_request_id}`,
      { params: { exclude_stn_id: stn.id } });
    const locsByItem = {};
    (data.items || []).forEach((p) => {
      const k = `${p.part_no}||${p.make}`;
      if (!locsByItem[k]) locsByItem[k] = p.available_locations || [];
    });
    for (let i = 0; i < (stn.items || []).length; i++) {
      const it = stn.items[i];
      const q = parseInt(it.quantity) || 0;
      if (q <= 0) continue;
      const loc = (locsByItem[`${it.part_no}||${it.make}`] || []).find((L) => (
        (L.godown_id || "") === (it.src_godown_id || "")
        && (L.rack_id || "") === (it.src_rack_id || "")
        && (L.box_id || "") === (it.src_box_id || "")
      ));
      const avail = loc ? (loc.available_qty ?? loc.current_qty ?? 0) : 0;
      if (q > avail) {
        const where = [it.src_godown_name, it.src_rack_no, it.src_box_no].filter(Boolean).join(" / ") || "the source";
        return `Row ${i + 1} (${it.part_no} / ${it.make}) needs ${q} but only ${avail} is available at ${where}.`;
      }
    }
    return null;
  };

  const handleRecord = async (stn) => {
    setRecordingId(stn.id);
    try {
      const shortfall = await blockingShortfall(stn);
      if (shortfall) {
        toast.error(`Cannot complete ${stn.stn_no} — ${shortfall} Open the note, reduce the quantity or pick another location, then complete it.`);
        return;
      }
    } catch {
      // Availability check failed (network/permission) — fall through and let the server
      // make the call; it re-checks the real ledger before moving anything.
    } finally { setRecordingId(null); }
    if (!window.confirm(`Record ${stn.stn_no} as Stock Transfer?\n\n${stn.items.length} item(s) — 1 OUT + 1 IN transaction will be created per item.`)) return;
    setRecordingId(stn.id);
    try {
      const { data } = await api.post(`/transfer-notes/${stn.id}/record`);
      toast.success(`Recorded · ${data.transactions_created} transaction(s) created`);
      if (data.remaining_transfer_note?.stn_no) toast.info(`Remaining quantity moved to ${data.remaining_transfer_note.stn_no}`);
      load(); onRecorded?.();
    } catch (err) { toast.error(formatApiError(err.response?.data?.detail) || "Could not record"); }
    finally { setRecordingId(null); }
  };

  const columns = useMemo(() => [
    { key: "stn_date", label: "STN DATE", value: (r) => fmtDate(r.stn_date) },
    { key: "stn_no", label: "STN NO", value: (r) => r.stn_no || "" },
    { key: "str_no", label: "REQUEST NO", value: (r) => r.transfer_request_no || "" },
    { key: "items_count", label: "ITEMS", value: (r) => (r.assigned_items || r.items || []).length},
    { key: "requested_qty", label: "REQUESTED", value: transferRequestedQty, isQty: true, isNumeric: true },
    { key: "moved_qty", label: "TRANSFERRED", value: transferMovedQty, isQty: true, isNumeric: true },
    { key: "rejected_qty", label: "REJECTED", value: transferRejectedQty, isQty: true, isNumeric: true },
    // Pending and Extra are one calculated column — numeric so it still sorts and filters,
    // and rendered as the same signed number the cell, the preview and the print show.
    { key: "variance_qty", label: "PENDING / EXTRA", value: (r) => { const t = transferTotals(r); return varianceValue(t.pending, t.extra); }, isQty: true, isNumeric: true },
    { key: "status", label: "STATUS", value: (r) => transferNoteStatusLabel(r.status) },
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
    exportToExcel(filteredRows, exportCols, `Transfer_Notes_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="mt-4" data-testid="stn-list-view">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input
            ref={searchInputRef}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search transfer notes…"
            className="rounded-sm font-mono h-9 pl-10 w-full"
            data-testid="stn-search-input"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleExport} variant="outline" className="rounded-sm border-slate-300" data-testid="stn-export-button">
            <DownloadSimple size={14} weight="bold" className="mr-2" /> Export
          </Button>
          <Button onClick={load} variant="outline" className="rounded-sm border-slate-300" disabled={loading} data-testid="stn-refresh-button">
            <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button disabled variant="outline" className="rounded-sm border-slate-300 text-slate-400" title="Transfer Notes are auto-generated from Transfer Requests" data-testid="create-stn-button">
            <Package size={16} weight="bold" className="mr-2" /> Auto Generated
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-between mb-3 text-xs text-slate-600">
        <div>
    {total === 0 ? "No transfer notes" : (
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
      {/* Fixed widths: the document numbers are long, and on auto layout they were
          wrapping onto a second line inside their cell. Each column is sized to hold its
          value on one line, with the table scrolling horizontally instead. */}
      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto">
        {/* One <col> per column, in order: SL, STN Date, STN No, Request No, Items,
            Requested, Transferred, Rejected, Pending/Extra, Status, Actions. */}
        <table className="data-table data-table-fixed data-table-wrap-head w-full min-w-[1400px]">
          <colgroup>
            <col style={{ width: "60px" }} />
            <col style={{ width: "116px" }} />
            <col style={{ width: "150px" }} />
            <col style={{ width: "150px" }} />
            <col style={{ width: "80px" }} />
            <col style={{ width: "108px" }} />
            <col style={{ width: "118px" }} />
            <col style={{ width: "108px" }} />
            <col style={{ width: "140px" }} />
            <col style={{ width: "110px" }} />
            <col style={{ width: "230px" }} />
          </colgroup>
          <thead>
            <tr>
              <th>SL NO</th>
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
              const t = transferTotals(r);
              const recorded = transferNoteDone(r);
              const pending = r.status === "PENDING";
              const aId = r.parent_assigned_to_user_id;
              const aName = r.parent_assigned_to_name;
              const aEmail = r.parent_assigned_to_email;
              const lockedToOther = !!aId && aId !== me?.id && !isAdmin;
              const lock = recorded || lockedToOther;
              const editTitle = recorded ? "Already completed" : (lockedToOther ? `Locked — assigned to ${assigneeLabel(aName, aEmail)}` : (pending ? "Open Transfer Note" : "Edit"));
              const recordTitle = recorded ? "Already completed" : (pending ? "Open and save draft first" : (lockedToOther ? `Locked — assigned to ${assigneeLabel(aName, aEmail)}` : "Complete Transfer"));
              const recordDisabled = recorded || pending || lockedToOther || recordingId === r.id;
              return (
                <tr key={r.id} data-testid={`stn-row-${r.stn_no}`}>
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td className="font-mono text-slate-700 date-cell">{fmtDate(r.stn_date)}</td>
                  <td>
                    <button onClick={() => onOpen(r)} className="font-mono font-semibold text-blue-700 hover:underline" data-testid={`stn-open-${r.stn_no}`}>{r.stn_no}</button>
                  </td>
                  <td className="font-mono text-slate-700">{r.transfer_request_no || "—"}</td>
                  <td className="text-left font-mono text-slate-600">{(r.assigned_items || r.items || []).length}</td>
                  <td className="text-left font-mono font-bold text-slate-900 tabular-nums">{t.requested || "—"}</td>
                  <td className="text-left font-mono font-bold text-slate-900 tabular-nums">{t.transferred}</td>
                  <td className={`text-left font-mono font-bold tabular-nums ${t.rejected > 0 ? "text-red-700" : "text-slate-400"}`}>{t.rejected}</td>
                  {/* Pending / Extra — one calculated field, identical on the note, the
                      preview dialog and the printed sheet (see `varianceLabel`). */}
                  <td className={`text-left font-mono font-bold tabular-nums ${varianceClass(t.pending, t.extra)}`}
                    title={varianceTitle(t.requested, t.transferred, t.rejected, t.pending, t.extra)}>
                    {varianceLabel(t.pending, t.extra)}
                  </td>
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${recorded ? "bg-green-100 text-green-800" : (pending ? "bg-blue-50 text-blue-800" : "bg-amber-50 text-amber-700")}`} data-testid={`stn-status-${r.stn_no}`}>
                      {transferNoteStatusLabel(r.status)}
                    </span>
                  </td>
                  {/* Flex row rather than inline buttons: the cell inherits
                      text-overflow:ellipsis from data-table-fixed, which is what was
                      rendering "…" after Delete and hiding the Complete button. */}
                  <td>
                    <div className="flex items-center gap-1 whitespace-nowrap">
                      <button onClick={() => onEdit(r)} disabled={lock} title={editTitle}
                        className={`p-1.5 rounded-sm shrink-0 ${lock ? "text-slate-300 cursor-not-allowed" : "hover:bg-slate-100"}`}
                        data-testid={`stn-edit-${r.stn_no}`}>
                        <Pencil size={14} />
                      </button>
                      {/* No delete: a Transfer Note is the record of an execution attempt
                          and must never disappear from the request's history — the same
                          rule Picking Notes follow. Edit / Preview / Print remain. */}
                      <Button onClick={() => handleRecord(r)} disabled={recordDisabled} size="sm"
                        title={recordTitle}
                        className={`rounded-sm h-7 text-xs px-2 shrink-0 ${lock ? "bg-slate-200 text-slate-500 cursor-not-allowed hover:bg-slate-200" : "bg-emerald-700 hover:bg-emerald-800 text-white"}`}
                        data-testid={`stn-record-${r.stn_no}`}>
                        <CheckCircle size={12} weight="bold" className="mr-1" />
                        {recorded ? "Completed" : (recordingId === r.id ? "Completing…" : "Complete Transfer")}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && (
              <tr><td colSpan={columns.length + 2} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? "No transfer notes yet — they are created from a Transfer Request." : "No rows match the current filters.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TransferNoteDetailDialog({ stn, onClose }) {
  // Every number in this dialog comes from the same three helpers the print sheet uses,
  // so the preview and the printed document can never disagree.
  const totals = transferTotals(stn);
  const available = transferAvailableQty(stn);
  const requestedFor = transferRequestedLookup(stn);
  const availableFor = transferAvailableLookup(stn);
  return (
    <Dialog open={!!stn} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-7xl max-h-[92vh] overflow-y-auto rounded-sm" data-testid="stn-detail-dialog">
        {stn && (
          <>
            <div className="text-center text-xl font-black tracking-widest uppercase pt-1 pb-2 border-b border-slate-200">
              TRANSFER NOTE
            </div>
            <div className="grid grid-cols-2 gap-6 text-sm pt-3 pb-4 border-b border-slate-200">
              <div className="space-y-2">
                <Detail k="TRANSFER NOTE DATE" v={fmtDate(stn.stn_date)} />
                <Detail k="TRANSFER NOTE NO" v={stn.stn_no} />
                <Detail k="EXECUTION ATTEMPT" v={stn.execution_attempt || 1} />
                <Detail k="TRANSFER REQUEST NO" v={stn.transfer_request_no || "—"} />
                <Detail k="STATUS" v={
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${transferNoteDone(stn) ? "bg-green-100 text-green-800" : (stn.status === "PENDING" ? "bg-blue-50 text-blue-800" : "bg-amber-50 text-amber-700")}`}>
                    {transferNoteStatusLabel(stn.status)}
                  </span>
                } />
              </div>
              <div className="space-y-2">
                <Detail k="REQUESTED QTY / AVAILABLE QTY" v={
                  <span className="font-mono">
                    {totals.requested || "—"}
                    <span className="text-slate-400"> / </span>
                    {available == null ? "—" : available}
                  </span>
                } />
                <Detail k="TRANSFERRED QTY" v={<span className="font-mono font-bold">{totals.transferred}</span>} />
                {/* Pending and Extra are ONE calculated field — the two directions of a
                    single variance, which can never both be non-zero. A Pending quantity
                    is what carries into an automatically-raised follow-up Transfer Note;
                    a Rejected one settles the request with no follow-up at all. */}
                <Detail k="PENDING / EXTRA" v={
                  <span className={`font-mono font-bold ${varianceClass(totals.pending, totals.extra)}`}
                    title={varianceTitle(totals.requested, totals.transferred, totals.rejected, totals.pending, totals.extra)}>
                    {varianceLabel(totals.pending, totals.extra)}
                    {totals.pending > 0 && <span className="ml-2 text-[10px] font-normal text-slate-500">carries to the next Transfer Note</span>}
                    {totals.extra > 0 && <span className="ml-2 text-[10px] font-normal text-emerald-700">extra moved</span>}
                  </span>
                } />
                <Detail k="REJECTED QTY" v={
                  <span className={`font-mono font-bold ${totals.rejected > 0 ? "text-red-700" : "text-slate-500"}`}>{totals.rejected}</span>
                } />
                <Detail k="CREATED BY" v={actorLabel(null, stn.created_by)} />
                <div>
                  <div className="label-sm">ASSIGNED TO (FROM REQUEST)</div>
                  <div className="mt-1"><AssigneeBadge name={stn.parent_assigned_to_name} email={stn.parent_assigned_to_email} /></div>
                </div>
              </div>
            </div>
            <div className="mt-2">
              <div className="label-sm mb-2">Items ({transferDisplayItems(stn).length})</div>
              <div className="overflow-x-auto">
                <table className="data-table w-full text-xs">
                  <thead>
                    <tr>
                      <th>SL NO.</th><th>PART NO</th><th>MAKE</th><th>STATUS</th>
                      <th className="text-center">REQUESTED QTY</th>
                      <th className="text-center">AVAILABLE QTY</th>
                      <th className="text-center">TRANSFERRED QTY</th>
                      <th className="text-center">PENDING / EXTRA</th>
                      <th className="text-center">REJECTED QTY</th>
                      <th>SOURCE GODOWN</th><th>SOURCE RACK</th><th>SOURCE BOX</th>
                      <th>DEST GODOWN</th><th>DEST RACK</th><th>DEST BOX</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transferDisplayItems(stn).map((it, idx) => {
                      const q = noteQtys(requestedFor(it), it.moved_qty, it.rejected_qty);
                      const avail = availableFor(it);
                      return (
                      <tr key={idx}>
                        <td className="font-mono text-slate-500">{idx + 1}</td>
                        <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                        <td>{it.make}</td>
                        <td className="font-mono text-slate-600">{it.row_status || "—"}</td>
                        <td className="text-center font-mono font-bold text-slate-600">{q.requested == null ? "—" : q.requested}</td>
                        <td className="text-center font-mono text-slate-600" title="Live stock for this item">{avail == null ? "—" : avail}</td>
                        <td className="text-center font-mono font-bold">{q.actual}</td>
                        <td className={`text-center font-mono font-bold ${varianceClass(q.pending, q.extra)}`}
                          title={varianceTitle(q.requested, q.actual, q.rejected, q.pending, q.extra)}>
                          {varianceLabel(q.pending, q.extra)}
                        </td>
                        <td className={`text-center font-mono font-bold ${q.rejected > 0 ? "text-red-700" : "text-slate-400"}`}>
                          {q.rejected || "—"}
                        </td>
                        <td className="font-mono">{it.src_godown_name || "—"}</td>
                        <td className="font-mono">{it.src_rack_no || "—"}</td>
                        <td className="font-mono">{it.src_box_no || "—"}</td>
                        <td className="font-mono">{it.dest_godown_name || "—"}</td>
                        <td className="font-mono">{it.dest_rack_no || "—"}</td>
                        <td className="font-mono">{it.dest_box_no || "—"}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="flex items-center gap-2 pt-4 border-t border-slate-200 mt-6">
              <Button variant="outline" size="sm" className="rounded-sm" onClick={() => printTransferNote(stn)} data-testid="stn-detail-print">
                <Printer size={14} weight="bold" className="mr-1.5" /> Print
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TransferNoteForm({ editing, onCancel, onSaved }) {
  const isEdit = !!editing;
  const [stnNo, setStnNo] = useState("");
  const [stnDate, setStnDate] = useState("");
  const [pendingStrs, setPendingStrs] = useState([]);
  const [selectedStrId, setSelectedStrId] = useState("");
  const [items, setItems] = useState([]);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [godowns, setGodowns] = useState([]);
  const [racksByGodown, setRacksByGodown] = useState({});
  const [boxesByRack, setBoxesByRack] = useState({});

  useEffect(() => { api.get("/godowns").then((r) => setGodowns(r.data)); }, []);

  useEffect(() => {
    if (isEdit) {
      setStnNo(editing.stn_no);
      setStnDate(editing.stn_date);
      setSelectedStrId(editing.transfer_request_id);
      setPendingStrs([{ id: editing.transfer_request_id, str_no: editing.transfer_request_no, str_date: editing.transfer_request_date }]);
      api.get(`/transfer-notes/prepare/${editing.transfer_request_id}`, { params: { exclude_stn_id: editing.id } })
        .then((r) => {
          const map = {};
          (r.data.items || []).forEach((p) => { map[`${p.part_no}||${p.make}`] = p; });
          const sourceItems = (editing.items || []).length ? editing.items : (r.data.items || []);
          setItems(sourceItems.map((it) => {
            const p = map[`${it.part_no}||${it.make}`] || {};
            return {
              ...it, available_locations: p.available_locations || [],
              pending_qty: p.pending_qty ?? 0, requested_qty: p.requested_qty ?? 0,
              // Availability is always the CURRENT number, never what it was when the
              // draft was saved: the whole point of the field is that the shelf moves
              // underneath the note.
              available_qty: p.available_qty ?? 0,
              // A saved 0 comes back as an empty input, not a literal "0" the operator
              // has to clear before typing.
              rejected_qty: (parseInt(it.rejected_qty) || 0) || "",
            };
          }));
        }).catch(() => setItems((editing.items || []).map((it) => ({ ...it, available_locations: [], pending_qty: 0, requested_qty: 0, available_qty: 0 }))));
    } else {
      // No number to show yet: a Transfer Note is numbered after its Transfer
      // Request, so the real number only exists once one is selected.
      api.get("/transfer-notes/next-no").then((r) => { setStnDate(r.data.stn_date); })
        .catch(() => toast.error("Could not preview transfer-note number"));
      api.get("/transfer-requests", { params: { not_status: "COMPLETE", page_size: 100 } })
        .then((r) => setPendingStrs(r.data || []));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, editing]);

  const ensureRacks = useCallback(async (gid) => {
    if (!gid || racksByGodown[gid]) return;
    const { data } = await api.get("/racks", { params: { godown_id: gid } });
    setRacksByGodown((p) => ({ ...p, [gid]: data }));
  }, [racksByGodown]);
  const ensureBoxes = useCallback(async (rid) => {
    if (!rid || boxesByRack[rid]) return;
    const { data } = await api.get("/boxes", { params: { rack_id: rid } });
    setBoxesByRack((p) => ({ ...p, [rid]: data }));
  }, [boxesByRack]);

  useEffect(() => {
    items.forEach((it) => {
      if (it.src_godown_id) ensureRacks(it.src_godown_id);
      if (it.src_rack_id) ensureBoxes(it.src_rack_id);
      if (it.dest_godown_id) ensureRacks(it.dest_godown_id);
      if (it.dest_rack_id) ensureBoxes(it.dest_rack_id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  const handleStrChange = async (id) => {
    setSelectedStrId(id);
    if (!id) { setItems([]); setStnNo(""); return; }
    // The Transfer Note number follows the request's, so it can only be
    // previewed once that request is known.
    api.get("/transfer-notes/next-no", { params: { transfer_request_id: id } })
      .then((r) => setStnNo(r.data.next_stn_no || ""))
      .catch(() => setStnNo(""));
    try {
      const { data } = await api.get(`/transfer-notes/prepare/${id}`);
      setItems(data.items || []);
      (data.items || []).forEach((it) => {
        if (it.src_godown_id) ensureRacks(it.src_godown_id);
        if (it.src_rack_id) ensureBoxes(it.src_rack_id);
        if (it.dest_godown_id) ensureRacks(it.dest_godown_id);
        if (it.dest_rack_id) ensureBoxes(it.dest_rack_id);
      });
    } catch (err) { toast.error(formatApiError(err.response?.data?.detail) || "Could not prepare items"); }
  };

  const updateItem = (i, patch) => setItems((p) => p.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  // Split an item across another source: append a fresh row for the same part/make with
  // the source cleared and the quantity blank, so the operator can take part of the line
  // from the prepared location and the remainder from somewhere else. The destination is
  // kept — a split is about where stock is drawn FROM, not where it lands. Mirrors the
  // Picking Note's "+ Split".
  const addSourceRow = (i) => {
    setItems((prev) => {
      const copy = [...prev];
      copy.splice(i + 1, 0, {
        ...prev[i],
        quantity: "", rejected_qty: "",
        src_godown_id: "", src_godown_name: "", src_rack_id: "", src_rack_no: "",
        src_box_id: "", src_box_no: "", src_box_category: "",
        manual: true,
      });
      return copy;
    });
  };

  // Lets the operator discard a row they don't intend to use — e.g. one of several
  // auto-split source-location rows for the same part when only one is actually chosen.
  // The last remaining row for an item can never be removed: the Transfer Request asked
  // for that item, so the line has to stay on the note (set Transferred Qty to 0 instead).
  const rowCountForItem = (row) => items.filter((r) => transferKey(r) === transferKey(row)).length;
  const removeItem = (i) => setItems((p) => (
    p.filter((r) => transferKey(r) === transferKey(p[i])).length > 1
      ? p.filter((_, idx) => idx !== i)
      : p
  ));

  // How much this row can actually draw, derived from the live per-location balances the
  // prepare endpoint returns (`available_locations[].available_qty`). The row itself
  // carries no availability field, so it has to be computed here — narrowed by whatever
  // of godown/rack/box has been chosen so far, and netted against what other rows in this
  // same form already claim from the identical location.
  const srcAvailableAtRow = (row, idx) => {
    const locKey = (g, r, b) => `${g || ""}||${r || ""}||${b || ""}`;
    const matching = (row.available_locations || []).filter((L) => (
      (!row.src_godown_id || L.godown_id === row.src_godown_id)
      && (!row.src_rack_id || L.rack_id === row.src_rack_id)
      && (!row.src_box_id || L.box_id === row.src_box_id)
    ));
    const pool = matching.reduce((sum, L) => sum + (L.available_qty || 0), 0);
    const rowKey = locKey(row.src_godown_id, row.src_rack_id, row.src_box_id);
    const claimedElsewhere = items.reduce((sum, r, ri) => {
      if (ri === idx || r.part_no !== row.part_no || r.make !== row.make) return sum;
      return locKey(r.src_godown_id, r.src_rack_id, r.src_box_id) === rowKey
        ? sum + (parseInt(r.quantity) || 0) : sum;
    }, 0);
    return Math.max(0, pool - claimedElsewhere);
  };

  // Re-pull live per-location balances and merge them into the rows, keeping every
  // quantity and location the operator has already entered. Lets them re-check after a
  // colleague's Stock Out drains a shelf, without abandoning the draft.
  const refreshAvailability = async () => {
    if (!selectedStrId) return;
    setRefreshing(true);
    try {
      const { data } = await api.get(`/transfer-notes/prepare/${selectedStrId}`,
        isEdit ? { params: { exclude_stn_id: editing.id } } : undefined);
      const byItem = {};
      (data.items || []).forEach((p) => { byItem[`${p.part_no}||${p.make}`] = p; });
      setItems((prev) => prev.map((r) => {
        const p = byItem[`${r.part_no}||${r.make}`];
        if (!p) return r;
        return {
          ...r, available_locations: p.available_locations || [],
          requested_qty: p.requested_qty ?? r.requested_qty,
          available_qty: p.available_qty ?? r.available_qty,
        };
      }));
      toast.success("Availability updated");
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not refresh availability");
    } finally { setRefreshing(false); }
  };

  // Rows whose entered quantity no longer fits the stock actually on the shelf.
  const shortRows = items.reduce(
    (n, r, i) => n + ((parseInt(r.quantity) || 0) > srcAvailableAtRow(r, i) ? 1 : 0), 0,
  );

  // Source and destination are the same physical place only when all three levels match.
  // Same godown, or same godown + same rack with a different box, are both real moves.
  const sameLocation = (it) => (
    (it.src_godown_id || "") === (it.dest_godown_id || "")
    && (it.src_rack_id || "") === (it.dest_rack_id || "")
    && (it.src_box_id || "") === (it.dest_box_id || "")
  );

  // A request line can be split across several source locations, so Requested is a budget
  // for the LINE (part/make), not for one row — Pending, Extra and Reject are therefore
  // all computed over every row that draws on the same requested line, and shown (and,
  // for Reject, entered) once, on the line's first row.
  const rowsOfLine = (rows, row) => rows.filter((r) => transferKey(r) === transferKey(row));
  const lineTotals = (rows, row, skipIdx = -1) => rows.reduce((acc, r, ri) => {
    if (transferKey(r) !== transferKey(row)) return acc;
    acc.transferred += parseInt(r.quantity) || 0;
    if (ri !== skipIdx) acc.rejected += parseInt(r.rejected_qty) || 0;
    return acc;
  }, { transferred: 0, rejected: 0 });
  // Requested is repeated on every split row of the same line, so take it once.
  const lineRequested = (rows, row) => {
    const first = rowsOfLine(rows, row)[0];
    return parseInt(first?.requested_qty) || 0;
  };
  // The line's whole arithmetic in one place — the same function every other view uses.
  const lineQtys = (rows, row) => {
    const t = lineTotals(rows, row, -1);
    return noteQtys(lineRequested(rows, row), t.transferred, t.rejected);
  };

  // Reject Quantity closes out the part of the request that will NOT be moved, so it is
  // bounded by what is still outstanding on the line:
  //   remaining = requested − transferred,  and  transferred + rejected <= requested.
  const maxRejectAtRow = (row, idx, rows = items) => {
    const requested = lineRequested(rows, row);
    if (requested <= 0) return 0;
    const t = lineTotals(rows, row, idx);
    return Math.max(0, requested - t.transferred - t.rejected);
  };
  // Reject is legal only while Extra is 0: once more has moved than was asked for, there
  // is nothing outstanding left to refuse. The same rule the server enforces
  // (`_validate_reject_rules`), so a note the form accepts is a note the server accepts.
  const rejectDisabledReason = (row, rows = items) => {
    const requested = lineRequested(rows, row);
    if (requested <= 0) return "Reject needs a requested quantity on this line — nothing was asked for, so anything moved is extra";
    const moved = lineTotals(rows, row, -1).transferred;
    if (moved > requested) {
      return `Reject unavailable — ${moved} moved against ${requested} requested leaves nothing outstanding to refuse`;
    }
    if (moved === requested) return "Nothing to reject — the full requested quantity has been transferred";
    return "";
  };

  // Transferred Qty is clamped to what the SOURCE actually holds — real stock is the only
  // ceiling. The requested quantity is a target, not a limit: moving less leaves a Pending
  // quantity that rolls into an automatically-raised follow-up note, moving more is an
  // Extra and simply stands.
  //
  // Pushing the line into Extra also clears any Rejected on it: Reject is only legal while
  // Extra is 0, and silently leaving a stale number behind for the server to refuse would
  // be worse than resetting the field the rule has just disabled. Below that, Reject is
  // re-clamped to whatever is still outstanding.
  const onTransferQtyChange = (i, raw, cap) => {
    const n = raw === "" ? null : parseInt(raw, 10);
    if (raw !== "" && (isNaN(n) || n < 0)) return;
    setItems((prev) => {
      const next = prev.map((r, ri) => (ri === i ? { ...r, quantity: raw === "" ? "" : String(Math.min(n, cap)) } : r));
      const overPicked = lineQtys(next, next[i]).extra > 0;
      return next.map((r, ri) => {
        if (transferKey(r) !== transferKey(next[i])) return r;
        if (overPicked) return { ...r, rejected_qty: "" };
        const cur = parseInt(r.rejected_qty) || 0;
        if (!cur) return r;
        const allowed = maxRejectAtRow(r, ri, next);
        return cur > allowed ? { ...r, rejected_qty: allowed ? String(allowed) : "" } : r;
      });
    });
  };

  // Reject may be entered before or after the transferred quantity — it is clamped to the
  // remaining quantity as it is typed, and re-clamped whenever the transferred quantity
  // moves underneath it.
  const onRejectQtyChange = (i, raw) => {
    if (raw === "") { updateItem(i, { rejected_qty: "" }); return; }
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 0) return;
    if (rejectDisabledReason(items[i])) return;   // input is disabled here; ignore stray writes
    const cap = maxRejectAtRow(items[i], i);
    updateItem(i, { rejected_qty: String(Math.min(n, cap)) });
  };

  // Pending / Extra and Reject describe the LINE, so they are rendered once — on its first
  // row — rather than repeated identically on every split row of the same line.
  const lineHeadIdx = useMemo(() => {
    const m = {};
    items.forEach((r, i) => { if (!(transferKey(r) in m)) m[transferKey(r)] = i; });
    return m;
  }, [items]);

  const onLocChange = async (i, side, kind, value) => {
    // side: "src" | "dest"; kind: "godown" | "rack" | "box"
    if (kind === "godown") {
      const g = godowns.find((x) => x.id === value);
      const patch = side === "src"
        ? { src_godown_id: value, src_godown_name: g?.godown_name || "", src_rack_id: "", src_rack_no: "", src_box_id: "", src_box_no: "", src_box_category: "" }
        : { dest_godown_id: value, dest_godown_name: g?.godown_name || "", dest_rack_id: "", dest_rack_no: "", dest_box_id: "", dest_box_no: "", dest_box_category: "" };
      updateItem(i, patch);
      await ensureRacks(value);
    } else if (kind === "rack") {
      const gid = side === "src" ? items[i].src_godown_id : items[i].dest_godown_id;
      const rk = (racksByGodown[gid] || []).find((x) => x.id === value);
      const patch = side === "src"
        ? { src_rack_id: value, src_rack_no: rk?.rack_no || "", src_box_id: "", src_box_no: "", src_box_category: "" }
        : { dest_rack_id: value, dest_rack_no: rk?.rack_no || "", dest_box_id: "", dest_box_no: "", dest_box_category: "" };
      updateItem(i, patch);
      await ensureBoxes(value);
    } else {
      const rid = side === "src" ? items[i].src_rack_id : items[i].dest_rack_id;
      const bx = (boxesByRack[rid] || []).find((x) => x.id === value);
      const patch = side === "src"
        ? { src_box_id: value, src_box_no: bx?.box_no || "", src_box_category: bx?.box_category || "" }
        : { dest_box_id: value, dest_box_no: bx?.box_no || "", dest_box_category: bx?.box_category || "" };
      updateItem(i, patch);
    }
  };

  const applySrcChip = async (i, loc) => {
    await ensureRacks(loc.godown_id);
    await ensureBoxes(loc.rack_id);
    updateItem(i, {
      src_godown_id: loc.godown_id, src_godown_name: loc.godown_name,
      src_rack_id: loc.rack_id, src_rack_no: loc.rack_no,
      src_box_id: loc.box_id, src_box_no: loc.box_no,
      src_box_category: loc.box_category || "",
    });
  };

  const save = async () => {
    if (!selectedStrId) { toast.error("Select a Transfer Request"); return; }
    if (items.length === 0) { toast.error("No items to transfer"); return; }
    if (!items.some((it) => (parseInt(it.quantity) || 0) > 0 || (parseInt(it.rejected_qty) || 0) > 0)) {
      toast.error("Enter a Transferred Qty or a Rejected Qty on at least one row"); return;
    }
    // Reject rules, checked per requested line exactly as the server does: rejection is
    // only possible while the line is under-transferred (Extra must be 0), and never
    // beyond what is left over (transferred + rejected <= requested).
    const seenLines = new Set();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if ((parseInt(it.rejected_qty) || 0) <= 0) continue;
      const requested = lineRequested(items, it);
      if (requested <= 0) { toast.error(`Row ${i + 1}: Reject Qty needs a requested quantity on this line`); return; }
      const k = transferKey(it);
      if (seenLines.has(k)) continue;
      seenLines.add(k);
      const t = lineTotals(items, it, -1);
      if (t.transferred > requested) {
        toast.error(`${it.part_no} / ${it.make}: Rejected Qty must be 0 — ${t.transferred} was transferred against ${requested} requested`); return;
      }
      if (t.transferred === requested) {
        toast.error(`Row ${i + 1}: Reject Qty must be 0 — the full requested quantity of ${requested} was transferred`); return;
      }
      if (t.rejected > requested - t.transferred) {
        toast.error(`Row ${i + 1}: Reject Qty ${t.rejected} exceeds the remaining quantity ${requested - t.transferred} (requested ${requested} − transferred ${t.transferred})`); return;
      }
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const q = parseInt(it.quantity) || 0;
      if (q < 0) { toast.error(`Row ${i + 1}: quantity cannot be negative`); return; }
      // Source/destination are only required for the portion that actually moves.
      if (q > 0) {
        if (!it.src_godown_id || !it.src_rack_id) { toast.error(`Row ${i + 1}: pick Source Godown / Rack`); return; }
        if (!it.dest_godown_id) { toast.error(`Row ${i + 1}: pick Destination Godown`); return; }
        // A rack that has boxes must be resolved down to the box, on both sides —
        // otherwise the destination is ambiguous and stock lands "in the rack".
        const srcHasBoxes = (boxesByRack[it.src_rack_id] || []).length > 0;
        if (srcHasBoxes && !it.src_box_id) { toast.error(`Row ${i + 1}: pick Source Box`); return; }
        if (!it.dest_rack_id) { toast.error(`Row ${i + 1}: pick Destination Rack`); return; }
        const destHasBoxes = (boxesByRack[it.dest_rack_id] || []).length > 0;
        if (destHasBoxes && !it.dest_box_id) { toast.error(`Row ${i + 1}: pick Destination Box`); return; }
        // Same godown is a legitimate transfer (rack-to-rack, box-to-box). The only
        // thing that makes no sense is moving stock onto the shelf it already sits on,
        // so the full source and destination location must differ somewhere.
        if (sameLocation(it)) {
          toast.error(`Row ${i + 1}: source and destination are the same location — change the rack or box`);
          return;
        }
        // Stock may have fallen since this note was drafted — the server checks the real
        // ledger again on completion, so catch it here with a message that explains why.
        const avail = srcAvailableAtRow(it, i);
        if (q > avail) {
          toast.error(`Row ${i + 1}: only ${avail} available at ${[it.src_godown_name, it.src_rack_no, it.src_box_no].filter(Boolean).join(" / ") || "the source"} — reduce the quantity or pick another location`);
          return;
        }
      }
    }
    setSaving(true);
    try {
      // Every requested line is sent, including any left at 0 — a 0 is a real answer
      // ("this line was covered elsewhere / not taken") and the row must survive the save.
      // Only split rows the operator added and then left completely empty are dropped.
      const sendRows = items.filter((it) => !(
        it.manual && (parseInt(it.quantity) || 0) <= 0 && (parseInt(it.rejected_qty) || 0) <= 0
      ));
      const payload = {
        transfer_request_id: selectedStrId,
        items: sendRows.map((it) => ({
          part_no: it.part_no, make: it.make, quantity: parseInt(it.quantity) || 0,
          rejected_qty: parseInt(it.rejected_qty) || 0,
          rejection_reason: it.rejection_reason || "",
          model: it.model || "", old_part_no: it.old_part_no || "", make_part_no: it.make_part_no || "",
          description_1: it.description_1 || "", description_2: it.description_2 || "",
          remarks_oem: it.remarks_oem || "", remarks_others: it.remarks_others || "",
          item_category: it.item_category || "",
          src_godown_id: it.src_godown_id || "", src_godown_name: it.src_godown_name || "",
          src_rack_id: it.src_rack_id || "", src_rack_no: it.src_rack_no || "",
          src_box_id: it.src_box_id || "", src_box_no: it.src_box_no || "", src_box_category: it.src_box_category || "",
          dest_godown_id: it.dest_godown_id || "", dest_godown_name: it.dest_godown_name || "",
          dest_rack_id: it.dest_rack_id || "", dest_rack_no: it.dest_rack_no || "",
          dest_box_id: it.dest_box_id || "", dest_box_no: it.dest_box_no || "", dest_box_category: it.dest_box_category || "",
        })),
      };
      const { data } = isEdit
        ? await api.put(`/transfer-notes/${editing.id}`, payload)
        : await api.post("/transfer-notes", payload);
      toast.success(`Transfer Note ${data.stn_no} ${isEdit ? "updated" : "saved"}`);
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save");
    } finally { setSaving(false); }
  };

  return (
    <div className="mt-4 space-y-6" data-testid="stn-create-view">
      <div className="flex items-center justify-between">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="stn-back-button">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
        <Button onClick={save} disabled={saving} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="stn-save-button">
          <FloppyDisk size={14} weight="bold" className="mr-2" /> {saving ? "Saving…" : (isEdit ? "Update Transfer Note" : "Save Transfer Note")}
        </Button>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm p-6 grid grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <Label className="label-sm">STN Date</Label>
          <Input value={stnDate} disabled className="mt-2 rounded-sm font-mono bg-slate-50" data-testid="stn-date-input" />
        </div>
        <div>
          <Label className="label-sm">STN No</Label>
          <Input value={stnNo} disabled className="mt-2 rounded-sm font-mono font-semibold bg-blue-50 text-blue-900" data-testid="stn-no-input" />
        </div>
        <div>
          <Label className="label-sm">Linked Transfer Request *</Label>
          <Select value={selectedStrId || undefined} onValueChange={handleStrChange} disabled={isEdit}>
            <SelectTrigger className="mt-2 rounded-sm" data-testid="stn-str-select">
              <SelectValue placeholder="Select pending request" />
            </SelectTrigger>
            <SelectContent>
              {pendingStrs.map((s) => (
                <SelectItem key={s.id} value={s.id} data-testid={`stn-str-option-${s.str_no}`}>
                  <span className="font-mono font-semibold">{s.str_no}</span>
                  <span className="ml-2 text-xs text-slate-500">{fmtDate(s.str_date)}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {selectedStrId && items.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-sm">
          <div className="p-4 border-b border-slate-200 flex items-center gap-2 flex-wrap">
            <Package size={16} weight="bold" className="text-slate-500" />
            <div className="label-sm">Items to Transfer ({items.length})</div>
            {shortRows > 0 && (
              <span className="text-[11px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-sm px-2 py-0.5" data-testid="stn-short-banner">
                {shortRows} row{shortRows > 1 ? "s" : ""} exceed current stock — availability has changed
              </span>
            )}
            <Button
              onClick={refreshAvailability}
              variant="outline"
              size="sm"
              disabled={refreshing}
              className="rounded-sm ml-auto"
              title="Re-check live stock at each source location without losing what you have entered"
              data-testid="stn-refresh-availability"
            >
              <ArrowsClockwise size={14} weight="bold" className={`mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
              {refreshing ? "Checking…" : "Refresh Availability"}
            </Button>
          </div>
          <div className="px-4 pt-3 text-xs text-slate-500">
            Enter <span className="font-bold">Transferred</span> and <span className="font-bold text-red-700">Rejected</span> only — the rest is worked out.
            Transferring is capped at <span className="font-bold">Available</span>.
            <span className="font-bold text-amber-700"> −qty</span> is outstanding and rolls into a new Transfer Note;
            <span className="font-bold text-emerald-700"> +qty</span> is extra moved.
            Use <span className="font-bold text-blue-700">+</span> to draw the same item from another source location —
            the destination carries over. A requested item always keeps at least one row: to move nothing,
            set its Transferred Qty to 0 rather than deleting the row.
          </div>
          <div className="overflow-x-auto">
            {/* `data-table-wrap-head` (index.css) lets a header wider than its column wrap
                instead of being clipped — "PENDING / EXTRA" needs it. */}
            <table className="data-table data-table-wrap-head w-full text-xs">
              <thead>
                <tr>
                  <th className="w-16">SL NO.</th>
                  <th>PART / MAKE</th>
                  {/* The five quantity columns: two read-only, two inputs, one derived. */}
                  <th className="text-center w-28">REQUESTED QTY</th>
                  <th className="text-center w-28">AVAILABLE QTY</th>
                  <th className="text-center w-32">TRANSFERRED QTY</th>
                  <th className="text-center w-28">REJECT QTY</th>
                  <th className="text-center w-28">PENDING / EXTRA</th>
                  <th>SOURCE</th>
                  <th>DESTINATION</th>
                  {/* Two 28px icon buttons (split + delete) plus cell padding. */}
                  <th className="w-20"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => {
                  const srcRacks = racksByGodown[it.src_godown_id] || [];
                  const srcBoxes = boxesByRack[it.src_rack_id] || [];
                  const destRacks = racksByGodown[it.dest_godown_id] || [];
                  const destBoxes = boxesByRack[it.dest_rack_id] || [];
                  const requested = it.requested_qty || 0;
                  const srcAvail = srcAvailableAtRow(it, idx);
                  // Stock can fall after this note was drafted (consumed by a Stock Out,
                  // another transfer, a correction). The typed quantity is deliberately
                  // NOT reduced behind the operator's back — it is flagged instead, so
                  // they decide whether to lower it or pick another location.
                  const shortNow = (parseInt(it.quantity) || 0) > srcAvail;
                  const rejectBlocked = rejectDisabledReason(it);
                  const maxReject = maxRejectAtRow(it, idx);
                  const canRemoveRow = rowCountForItem(it) > 1;
                  // Line-level arithmetic: split rows share one requested line, so
                  // Pending/Extra and Reject are computed over the whole line and shown
                  // (and, for Reject, entered) once, on its first row.
                  const lineHead = lineHeadIdx[transferKey(it)] === idx;
                  const line = lineQtys(items, it);
                  return (
                    <tr key={idx} data-testid={`stn-item-row-${idx}`} className={shortNow ? "align-top bg-amber-50" : "align-top"}>
                      <td className="font-mono text-slate-500 pt-3">{idx + 1}</td>
                      <td className="pt-3">
                        <div><PartNoLink partNo={it.part_no} make={it.make} /></div>
                        <div className="text-slate-600">{it.make}</div>
                        <div className="text-[10px] text-slate-500 mt-0.5">{it.description_1 || ""}</div>
                      </td>
                      {/* Requested — read-only. A target, not a limit: the operator may
                          move more (an Extra) or less (a Pending). */}
                      <td className="text-center pt-3 font-mono font-bold text-slate-700" data-testid={`stn-requested-${idx}`}>
                        {requested || "—"}
                      </td>
                      {/* Available — read-only and LIVE: the total currently on the shelf
                          for this part/make, which is the real ceiling on Transferred Qty.
                          When it has dropped below Requested, the operator moves what is
                          there and the rest stays Pending for a follow-up note. */}
                      <td className="text-center pt-3 font-mono" data-testid={`stn-available-${idx}`}>
                        <span className={(it.available_qty ?? 0) < requested ? "font-bold text-amber-700" : "text-slate-600"}
                          title={(it.available_qty ?? 0) < requested
                            ? `Only ${it.available_qty ?? 0} in stock against ${requested} requested — move what is there; the rest stays outstanding`
                            : "Live stock across every location holding this item"}>
                          {it.available_qty ?? 0}
                        </span>
                      </td>
                      <td className="text-center pt-3">
                        <Input type="number" min="0" step="1" value={it.quantity}
                          max={srcAvail || undefined}
                          onChange={(e) => onTransferQtyChange(idx, e.target.value, srcAvail)}
                          title={`Up to ${srcAvail} available at the selected source`}
                          className={`rounded-sm font-mono h-9 text-center text-base w-24 mx-auto ${shortNow ? "border-amber-500" : ""}`}
                          data-testid={`stn-qty-${idx}`} />
                        <div className={`font-mono text-[11px] whitespace-nowrap mt-1 ${shortNow ? "text-amber-700 font-bold" : "text-slate-500"}`} data-testid={`stn-live-summary-${idx}`}>
                          Avail {srcAvail}
                        </div>
                        {shortNow && (
                          <div className="text-[10px] text-amber-800 mt-1 leading-tight" data-testid={`stn-short-warning-${idx}`}>
                            Stock dropped to {srcAvail} since this note was created.
                            <button
                              type="button"
                              onClick={() => updateItem(idx, { quantity: String(srcAvail) })}
                              className="ml-1 underline font-bold hover:text-amber-900"
                              data-testid={`stn-use-avail-${idx}`}
                            >
                              Use {srcAvail}
                            </button>
                          </div>
                        )}
                      </td>
                      {/* Reject Qty — the operator's second and last input, entered once
                          per line. It never moves stock; it closes out the untransferred
                          remainder so no follow-up Transfer Note is raised for it.
                          Disabled the moment the line runs an Extra: there is then nothing
                          outstanding left to refuse. */}
                      <td className="text-center pt-3" data-testid={`stn-rejected-${idx}`}>
                        {!lineHead ? <span className="text-slate-300">·</span> : (
                          <>
                            <Input type="number" min="0" step="1" max={maxReject || undefined}
                              value={it.rejected_qty ?? ""}
                              disabled={!!rejectBlocked}
                              onChange={(e) => onRejectQtyChange(idx, e.target.value)}
                              title={rejectBlocked || `Up to ${maxReject} outstanding on this line`}
                              className="rounded-sm font-mono h-9 text-center text-base w-20 mx-auto disabled:bg-slate-100 disabled:text-slate-400"
                              data-testid={`stn-reject-${idx}`} />
                            <div className={`font-mono text-[11px] whitespace-nowrap mt-1 ${
                              rejectBlocked ? "text-slate-400" : ((parseInt(it.rejected_qty) || 0) > 0 ? "text-red-700 font-bold" : "text-slate-500")
                            }`} data-testid={`stn-reject-hint-${idx}`}>
                              {line.extra > 0 ? "Extra — N/A" : (rejectBlocked ? "Not allowed" : `Rem ${maxReject}`)}
                            </div>
                          </>
                        )}
                      </td>
                      {/* Pending / Extra — the two derived quantities in one column,
                          because they are the two directions of a single variance and can
                          never both be non-zero on a line:
                              −qty  short of what was requested, and rolls into a new
                                    Transfer Note when this one is recorded (unless rejected)
                              +qty  moved over and above what was requested
                          Never typed, never negative in the underlying figures — the sign
                          here is presentation, so one glance says which way the line went. */}
                      <td className="text-center pt-3" data-testid={`stn-variance-${idx}`}>
                        {!lineHead ? <span className="text-slate-300">·</span> : (
                          <span className={`font-mono font-bold ${varianceClass(line.pending, line.extra)}`}
                            title={varianceTitle(line.requested, line.actual, line.rejected, line.pending, line.extra)}>
                            {varianceLabel(line.pending, line.extra)}
                          </span>
                        )}
                      </td>
                      <td className="space-y-1 pt-2">
                        <div className="text-[10px] text-slate-500 uppercase font-bold tracking-wider"><MapPin size={10} weight="bold" className="inline mr-0.5" /> From</div>
                        <Select value={it.src_godown_id || undefined} onValueChange={(v) => onLocChange(idx, "src", "godown", v)}>
                          <SelectTrigger className="rounded-sm h-7 text-xs" data-testid={`stn-src-godown-${idx}`}><SelectValue placeholder="Godown" /></SelectTrigger>
                          <SelectContent>{godowns.map((g) => <SelectItem key={g.id} value={g.id}>{g.godown_name}</SelectItem>)}</SelectContent>
                        </Select>
                        <Select disabled={!it.src_godown_id} value={it.src_rack_id || undefined} onValueChange={(v) => onLocChange(idx, "src", "rack", v)}>
                          <SelectTrigger className="rounded-sm h-7 text-xs" data-testid={`stn-src-rack-${idx}`}><SelectValue placeholder="Rack" /></SelectTrigger>
                          <SelectContent>{srcRacks.map((r) => <SelectItem key={r.id} value={r.id} className="font-mono">{r.rack_no}</SelectItem>)}</SelectContent>
                        </Select>
                        <Select disabled={!it.src_rack_id || srcBoxes.length === 0} value={it.src_box_id || undefined} onValueChange={(v) => onLocChange(idx, "src", "box", v)}>
                          <SelectTrigger className="rounded-sm h-7 text-xs" data-testid={`stn-src-box-${idx}`}><SelectValue placeholder={srcBoxes.length === 0 ? "—" : "Box"} /></SelectTrigger>
                          <SelectContent>{srcBoxes.map((b) => <SelectItem key={b.id} value={b.id} className="font-mono">{b.box_no}</SelectItem>)}</SelectContent>
                        </Select>
                        {(it.available_locations || []).length > 0 && (
                          <div className="flex flex-wrap gap-1 pt-1">
                            {(it.available_locations || []).filter((L) => L.available_qty > 0).slice(0, 3).map((L, li) => (
                              <button key={li} type="button" onClick={() => applySrcChip(idx, L)}
                                className="text-[10px] px-1.5 py-0.5 rounded-sm bg-slate-100 hover:bg-blue-100 text-slate-700 font-mono"
                                title={`avail ${L.available_qty}`}>
                                {formatLocationText(L)} ({L.available_qty})
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="space-y-1 pt-2">
                        <div className="text-[10px] text-slate-500 uppercase font-bold tracking-wider"><MapPin size={10} weight="bold" className="inline mr-0.5" /> To</div>
                        <Select value={it.dest_godown_id || undefined} onValueChange={(v) => onLocChange(idx, "dest", "godown", v)}>
                          <SelectTrigger className="rounded-sm h-7 text-xs" data-testid={`stn-dest-godown-${idx}`}><SelectValue placeholder="Godown" /></SelectTrigger>
                          <SelectContent>{godowns.map((g) => <SelectItem key={g.id} value={g.id}>{g.godown_name}</SelectItem>)}</SelectContent>
                        </Select>
                        <Select disabled={!it.dest_godown_id} value={it.dest_rack_id || undefined} onValueChange={(v) => onLocChange(idx, "dest", "rack", v)}>
                          <SelectTrigger className="rounded-sm h-7 text-xs" data-testid={`stn-dest-rack-${idx}`}><SelectValue placeholder="Rack" /></SelectTrigger>
                          <SelectContent>{destRacks.map((r) => <SelectItem key={r.id} value={r.id} className="font-mono">{r.rack_no}</SelectItem>)}</SelectContent>
                        </Select>
                        <Select disabled={!it.dest_rack_id || destBoxes.length === 0} value={it.dest_box_id || undefined} onValueChange={(v) => onLocChange(idx, "dest", "box", v)}>
                          <SelectTrigger className="rounded-sm h-7 text-xs" data-testid={`stn-dest-box-${idx}`}><SelectValue placeholder={destBoxes.length === 0 ? "—" : "Box"} /></SelectTrigger>
                          <SelectContent>{destBoxes.map((b) => <SelectItem key={b.id} value={b.id} className="font-mono">{b.box_no}</SelectItem>)}</SelectContent>
                        </Select>
                      </td>
                      <td className="pt-3">
                        <div className="flex items-center gap-1 whitespace-nowrap">
                          <button type="button" onClick={() => addSourceRow(idx)}
                            className="p-1.5 rounded-sm shrink-0 hover:bg-blue-50 text-blue-700"
                            title="Add a row for this item from another source location"
                            data-testid={`stn-split-row-${idx}`}><Plus size={14} /></button>
                          <button type="button" onClick={() => removeItem(idx)}
                            disabled={!canRemoveRow}
                            className={`p-1.5 rounded-sm shrink-0 ${canRemoveRow ? "hover:bg-red-50 text-red-700" : "text-slate-300 cursor-not-allowed"}`}
                            title={canRemoveRow ? "Remove this row" : "The last row for an item cannot be removed — set Transferred Qty to 0 instead"}
                            data-testid={`stn-remove-row-${idx}`}><Trash size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
