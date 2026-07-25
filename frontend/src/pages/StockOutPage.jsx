import React, { useEffect, useState, useCallback, useMemo } from "react";
import { api, formatApiError } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "../components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "../components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { toast } from "sonner";
import {
  Plus, Trash, ArrowLeft, FloppyDisk, FileText, CaretLeft, CaretRight,
  Pencil, CheckCircle, MapPin, Package, ArrowsSplit,
  DownloadSimple, ArrowsClockwise,
} from "@phosphor-icons/react";
import { useAuth } from "../lib/auth";
import AssigneeSelect, { AssigneeBadge } from "../components/AssigneeSelect";
import ExcelColumnFilter from "../components/ExcelColumnFilter";
import useExcelTableFilter from "../components/useExcelTableFilter";
import PartNoLink from "../components/PartNoLink";
import { exportToExcel } from "../lib/exportExcel";

const PAGE_SIZE = 100;
const NO_GODOWN = "__NO_GODOWN__";

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

function isDisplayOnlyRemainingRow(it) {
  return !!it.is_remaining_row && !it.godown_id && !it.rack_id && !it.box_id;
}

function pickingAssignedItems(pn) {
  return (pn.assigned_items || []).length ? (pn.assigned_items || []) : (pn.requested_items || []);
}

function pickingAssignedQty(pn) {
  return pickingAssignedItems(pn).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0);
}

function pickingPickedQty(pn) {
  return (pn.items || []).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0);
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

function printPickingNote(pn) {
  const rows = pickingDisplayItems(pn).map((it, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${htmlEscape(it.part_no)}</td>
      <td>${htmlEscape(it.make)}</td>
      <td>${htmlEscape(it.description_1 || "")}</td>
      <td>${htmlEscape(it.row_status || "")}</td>
      <td class="num">${htmlEscape(it.quantity)}</td>
      <td>${htmlEscape(it.godown_name || "")}</td>
      <td>${htmlEscape(it.rack_no || "")}</td>
      <td>${htmlEscape(it.box_no || "")}</td>
    </tr>
  `).join("");
  const html = `<!doctype html>
<html>
<head>
  <title>${htmlEscape(pn.pn_no || "Picking Note")}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #111827; padding: 24px; }
    h1 { font-size: 22px; margin: 0 0 16px; }
    .meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 18px; margin-bottom: 18px; font-size: 12px; }
    .label { color: #64748b; text-transform: uppercase; font-size: 10px; font-weight: 700; letter-spacing: .04em; }
    .value { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin-top: 3px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border: 1px solid #cbd5e1; padding: 7px; text-align: left; vertical-align: top; }
    th { background: #f1f5f9; font-size: 10px; text-transform: uppercase; }
    .num { text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    @media print { body { padding: 12mm; } }
  </style>
</head>
<body>
  <h1>Picking Note ${htmlEscape(pn.pn_no || "")}</h1>
  <div class="meta">
    <div><div class="label">Issue Number</div><div class="value">${htmlEscape(pn.issue_note_no || "")}</div></div>
    <div><div class="label">Picking Number</div><div class="value">${htmlEscape(pn.pn_no || "")}</div></div>
    <div><div class="label">Date</div><div class="value">${htmlEscape(fmtDate(pn.pn_date))}</div></div>
    <div><div class="label">Issued To</div><div class="value">${htmlEscape(pn.issued_to || "")}</div></div>
    <div><div class="label">Picker</div><div class="value">${htmlEscape(pn.created_by || "")}</div></div>
    <div><div class="label">Status</div><div class="value">${htmlEscape(pn.status || "")}</div></div>
  </div>
  <table>
    <thead><tr><th>SL</th><th>Part</th><th>Brand</th><th>Description</th><th>Status</th><th>Qty</th><th>Godown</th><th>Rack</th><th>Box</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="9">No picked locations saved.</td></tr>`}</tbody>
  </table>
  <script>window.onload = () => setTimeout(() => window.print(), 100);</script>
</body>
</html>`;
  const w = window.open("", "_blank");
  if (!w) { toast.error("Popup blocked — allow popups for this site to print"); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function buildPickingEditItems(editing, preparedItems) {
  const preparedByKey = {};
  (preparedItems || []).forEach((p) => { preparedByKey[pickingKey(p)] = p; });
  const existing = editing?.items || [];
  if (existing.length) {
    return existing.map((it) => {
      const p = preparedByKey[pickingKey(it)] || {};
      return {
      ...it,
      row_status: editing?.status === "RECORDED" ? "Picked" : "Draft Pick",
      available_locations: p.available_locations || [],
      pending_qty: p.pending_qty ?? it.pending_qty ?? 0,
      requested_qty: p.requested_qty ?? it.requested_qty ?? 0,
      already_picked_qty: p.already_picked_qty ?? it.already_picked_qty ?? 0,
      };
    });
  }
  return (preparedItems || []).map((it) => ({ ...it, row_status: "Assigned" }));
}

/* ==============================================================
   STOCK OUT  (Issue Note + Picking Note)
   ============================================================== */
export default function StockOutPage() {
  const [tab, setTab] = useState("issue-note");
  return (
    <div className="p-8 max-w-[1600px] mx-auto" data-testid="stock-out-page">
      <div className="mb-6">
        <div className="label-sm mb-2">Outward</div>
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/issue-notes", { params: { page, page_size: PAGE_SIZE } });
      setRows(res.data);
      const t = parseInt(res.headers["x-total-count"], 10);
      setTotal(isNaN(t) ? res.data.length : t);
    } finally { setLoading(false); }
  }, [page]);
  useEffect(() => { load(); }, [load, reloadKey]);

  const handleDelete = async (inn) => {
    if (!window.confirm(`Delete ${inn.in_no}?`)) return;
    try {
      await api.delete(`/issue-notes/${inn.id}`);
      toast.success(`${inn.in_no} deleted`);
      load();
    } catch (err) { toast.error(formatApiError(err.response?.data?.detail) || "Could not delete"); }
  };

  const statusLabel = (r) => {
    if (r.status === "COMPLETED" || r.status === "FULLY_PICKED") return "Completed";
    if (r.status === "PICKED" || r.status === "PARTIALLY_PICKED") return "Partially Picked";
    if (r.status === "PICKING_IN_PROGRESS") return "Picking In Progress";
    if (r.status === "OPEN") return "Open";
    return "Picking Pending";
  };

  const columns = useMemo(() => [
    { key: "in_date", label: "ISSUE NOTE DATE", value: (r) => fmtDate(r.in_date) },
    { key: "in_no", label: "ISSUE NOTE NO", value: (r) => r.in_no || "" },
    { key: "issued_to", label: "ISSUED TO", value: (r) => r.issued_to || "" },
     { key: "items_count", label: "ITEMS", value: (r) => (r.items || []).length},
    { key: "qty_total", label: "TOTAL QUANTITY", value: (r) => (r.items || []).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0)},
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
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div className="text-sm text-slate-600">
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
      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto overflow-visible">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-14">SL NO</th>
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
              const totalQty = (r.items || []).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0);
              const isFully = r.status === "COMPLETED" || r.status === "FULLY_PICKED";
              const isPartial = r.status === "PICKING_IN_PROGRESS" || r.status === "PICKED" || r.status === "PARTIALLY_PICKED";
              const hasPicking = isFully || isPartial;
              const lockedToOther = !!r.assigned_to_user_id && r.assigned_to_user_id !== me?.id && !isAdmin;
              const lock = hasPicking || lockedToOther;
              const editTitle = hasPicking ? "Cannot edit — picking notes exist"
                : (lockedToOther ? `Locked — assigned to ${r.assigned_to_name || r.assigned_to_email}` : "Edit");
              const deleteTitle = hasPicking ? "Cannot delete — picking notes exist"
                : (lockedToOther ? `Locked — assigned to ${r.assigned_to_name || r.assigned_to_email}` : "Delete");
              const label = statusLabel(r);
              const cls = isFully ? "bg-green-100 text-green-800" : (isPartial ? "bg-blue-50 text-blue-800" : "bg-amber-50 text-amber-700");
              return (
                <tr key={r.id} data-testid={`in-row-${r.in_no}`}>
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td className="font-mono text-slate-700">{fmtDate(r.in_date)}</td>
                  <td>
                    <button onClick={() => onOpen(r)} className="font-mono font-semibold text-blue-700 hover:underline" data-testid={`in-open-${r.in_no}`}>
                      {r.in_no}
                    </button>
                  </td>
                  <td className="text-slate-700">{r.issued_to || "—"}</td>
                                    <td className="font-mono text-slate-600">{(r.items || []).length}</td>
                  <td className="font-mono font-bold text-slate-900">{totalQty}</td>
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
              <tr><td colSpan={8} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? "No issue notes. Click 'Create New Issue Note' to begin." : "No rows match the current filters.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between mt-3 text-xs text-slate-600">
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
    </div>
  );
}

function IssueNoteDetailDialog({ inn, onClose }) {
  const [history, setHistory] = useState([]);

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
      <DialogContent className="max-w-5xl rounded-sm" data-testid="in-detail-dialog">
        {inn && (
          <>
            <DialogHeader>
              <DialogTitle className="text-2xl font-black font-mono">{inn.in_no}</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-4 text-sm border-b border-slate-200 pb-4 mb-4">
              <Detail k="Issue Note Date" v={fmtDate(inn.in_date)} />
              <Detail k="Issued To" v={inn.issued_to || "—"} />
              <Detail k="Status" v={inn.status} />
              <Detail k="Created At" v={new Date(inn.created_at).toLocaleString()} />
              <div className="col-span-2">
                <div className="label-sm">Assigned To</div>
                <div className="mt-1"><AssigneeBadge name={inn.assigned_to_name} email={inn.assigned_to_email} /></div>
              </div>
            </div>
            <table className="data-table w-full">
              <thead>
                <tr><th className="w-14">SL</th><th>PART NO</th><th>MAKE</th><th>DESCRIPTION</th><th>GODOWN</th><th className="text-center">QTY</th></tr>
              </thead>
              <tbody>
                {(inn.items || []).map((it, idx) => (
                  <tr key={idx}>
                    <td className="font-mono text-slate-500">{idx + 1}</td>
                    <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                    <td>{it.make}</td>
                    <td className="text-slate-700">{it.description_1 || "—"}</td>
                    <td className="font-mono">{it.selected_godown_name || "—"}</td>
                    <td className="text-center font-mono font-bold">{it.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-6">
              <div className="text-xs font-black uppercase tracking-wider text-slate-600 mb-2">Picking History</div>
              <table className="data-table w-full text-xs">
                <thead>
                  <tr><th>PN NO</th><th>PARENT PN</th><th className="text-center">ASSIGNED</th><th className="text-center">PICKED</th><th>STATUS</th></tr>
                </thead>
                <tbody>
                  {[...history].sort((a, b) => (a.serial || 0) - (b.serial || 0)).map((pn) => {
                    const completed = pn.status === "COMPLETED" || pn.status === "RECORDED";
                    const parent = history.find((h) => h.id === pn.parent_picking_note_id);
                    return (
                      <tr key={pn.id}>
                        <td className="font-mono font-semibold">{pn.pn_no}</td>
                        <td className="font-mono">{parent?.pn_no || "—"}</td>
                        <td className="text-center font-mono font-bold">{pickingAssignedQty(pn)}</td>
                        <td className="text-center font-mono font-bold">{pickingPickedQty(pn)}</td>
                        <td>
                          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${completed ? "bg-green-100 text-green-800" : (pn.status === "PENDING" ? "bg-blue-50 text-blue-800" : "bg-amber-50 text-amber-700")}`}>
                            {completed ? "Completed" : (pn.status === "PENDING" ? "Pending" : "Draft")}
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
  selected_godown_id: null,
  selected_godown_name: null,
  godowns: [],
  makes: [],
  partLooked: false,
  available_qty: 0,
});

function IssueNoteForm({ editing, onCancel, onSaved }) {
  const isEdit = !!editing;
  const [inNo, setInNo] = useState("");
  const [inDate, setInDate] = useState("");
  const [issuedTo, setIssuedTo] = useState("");
  const [items, setItems] = useState([emptyIssueItem()]);
  const [saving, setSaving] = useState(false);
  const [assignedToUserId, setAssignedToUserId] = useState("");

  useEffect(() => {
    if (isEdit) {
      setInNo(editing.in_no || "");
      setInDate(editing.in_date || "");
      setIssuedTo(editing.issued_to || "");
      setAssignedToUserId(editing.assigned_to_user_id || "");
      const initial = (editing.items || []).map((it) => ({
        part_no: it.part_no || "", make: it.make || "", quantity: it.quantity ?? "",
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
            setItems((prev) => prev.map((r, i) => i === idx ? { ...r, makes: makesArr, available_qty: found?.available_qty || 0 } : r));
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

  const addItems = () => {
    setItems((p) => [...p, emptyIssueItem()]);
  };
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
    if (!v) { updateItem(i, { makes: [], make: "", partLooked: false, available_qty: 0, godowns: [], selected_godown_id: null, selected_godown_name: null }); return; }
    try {
      const { data } = await api.get(`/issue-notes/lookup/${encodeURIComponent(v)}`);
      const list = data.makes || [];
      const auto = list.length === 1 ? list[0] : null;
      updateItem(i, {
        makes: list, partLooked: true,
        make: auto ? auto.make : "",
        available_qty: auto ? auto.available_qty : 0,
        godowns: [],
        selected_godown_id: null,
        selected_godown_name: null,
      });
      if (auto) loadIssueGodowns(i, v, auto.make);
    } catch { updateItem(i, { makes: [], partLooked: true, make: "", available_qty: 0 }); }
  };

  const onMakeChange = (i, makeVal) => {
    const row = items[i];
    const found = (row.makes || []).find((m) => m.make === makeVal);
    updateItem(i, { make: makeVal, available_qty: found?.available_qty || 0, godowns: [], selected_godown_id: null, selected_godown_name: null });
    loadIssueGodowns(i, row.part_no, makeVal);
  };

  const onIssueGodownChange = (i, gid) => {
    if (gid === NO_GODOWN) {
      updateItem(i, { selected_godown_id: null, selected_godown_name: null });
      return;
    }
    const row = items[i];
    const found = (row.godowns || []).find((g) => g.godown_id === gid);
    updateItem(i, {
      selected_godown_id: found?.godown_id || null,
      selected_godown_name: found?.godown_name || null,
    });
  };

  // Sum requested qty per (part_no, make) across all rows so multiple rows of the same part/make
  // are validated together (mirrors backend aggregation).
  const requestedByKey = useMemo(() => {
    const m = {};
    items.forEach((r) => {
      if (!r.part_no || !r.make) return;
      const k = `${r.part_no}||${r.make}`;
      m[k] = (m[k] || 0) + (parseFloat(r.quantity) || 0);
    });
    return m;
  }, [items]);

  const requestedByGodownKey = useMemo(() => {
    const m = {};
    items.forEach((r) => {
      if (!r.part_no || !r.make || !r.selected_godown_id) return;
      const k = `${r.part_no}||${r.make}||${r.selected_godown_id}`;
      m[k] = (m[k] || 0) + (parseFloat(r.quantity) || 0);
    });
    return m;
  }, [items]);

  const save = async () => {
    if (items.length === 0) { toast.error("Add at least one item"); return; }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.part_no.trim()) { toast.error(`Row ${i + 1}: Part No required`); return; }
      if (!it.make.trim()) { toast.error(`Row ${i + 1}: Make required`); return; }
      const q = parseFloat(it.quantity);
      if (isNaN(q) || q <= 0) { toast.error(`Row ${i + 1}: Quantity > 0`); return; }
      if (q > (it.available_qty || 0) + 1e-6) {
        toast.error(`Row ${i + 1}: ${it.part_no}/${it.make} — only ${it.available_qty} in stock, cannot issue ${q}`);
        return;
      }
      if (it.selected_godown_id) {
        const selected = (it.godowns || []).find((g) => g.godown_id === it.selected_godown_id);
        if (selected && q > (selected.available_qty || 0) + 1e-6) {
          toast.error(`Row ${i + 1}: ${it.part_no}/${it.make} — only ${selected.available_qty || 0} in ${it.selected_godown_name || "selected godown"}, cannot issue ${q}`);
          return;
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
        return;
      }
    }
    for (const [k, total] of Object.entries(requestedByGodownKey)) {
      const [p, m, gid] = k.split("||");
      const row = items.find((r) => r.part_no === p && r.make === m && r.selected_godown_id === gid);
      const selected = (row?.godowns || []).find((g) => g.godown_id === gid);
      if (selected && total > (selected.available_qty || 0) + 1e-6) {
        toast.error(`${p}/${m}: total requested from ${selected.godown_name || "selected godown"} is ${total} but only ${selected.available_qty || 0} is available there`);
        return;
      }
    }
    setSaving(true);
    try {
      const payload = {
        issued_to: issuedTo.trim(),
        assigned_to_user_id: assignedToUserId || null,
        items: items.map((it) => ({
          part_no: it.part_no.trim(),
          make: it.make.trim(),
          quantity: parseFloat(it.quantity),
          selected_godown_id: it.selected_godown_id || null,
          selected_godown_name: it.selected_godown_name || null,
        })),
      };
      const { data } = isEdit
        ? await api.put(`/issue-notes/${editing.id}`, payload)
        : await api.post("/issue-notes", payload);
      toast.success(`Issue Note ${data.in_no} ${isEdit ? "updated" : "saved"}`);
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save");
    } finally { setSaving(false); }
  };

  return (
    <div className="mt-4 space-y-6" data-testid="in-create-view">
      <div className="flex items-center justify-between">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="in-back-button">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
        <Button onClick={save} disabled={saving} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="in-save-button">
          <FloppyDisk size={14} weight="bold" className="mr-2" /> {saving ? "Saving…" : (isEdit ? "Update Issue Note" : "Save Issue Note")}
        </Button>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm p-6 grid grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <Label className="label-sm">Issue Note Date</Label>
          <Input value={inDate} disabled className="mt-2 rounded-sm font-mono bg-slate-50" data-testid="in-date-input" />
        </div>
        <div>
          <Label className="label-sm">Issue Note No</Label>
          <Input value={inNo} disabled className="mt-2 rounded-sm font-mono font-semibold bg-blue-50 text-blue-900" data-testid="in-no-input" />
        </div>
        <div>
          <Label className="label-sm">Issued To *</Label>
          <Input value={issuedTo} onChange={(e) => setIssuedTo(e.target.value)} placeholder="User / department"
            className="mt-2 rounded-sm" data-testid="in-issued-to-input" />
        </div>
        <div className="col-span-2">
          <AssigneeSelect
            value={assignedToUserId}
            onChange={setAssignedToUserId}
            module="stock_out"
            testid="in-assignee"
          />
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm">
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <div>
            <div className="label-sm">Items Requested</div>
            <div className="text-xs text-slate-500 mt-0.5">{items.length} row{items.length !== 1 ? "s" : ""}</div>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={addItems} variant="outline" className="rounded-sm" data-testid="in-add-row-button">
              <Plus size={14} weight="bold" className="mr-1" /> Add Row
            </Button>
          </div>
        </div>

        <table className="data-table w-full">
          <thead>
            <tr><th className="w-14">SL</th><th>PART NO</th><th>MAKE</th><th>QUANTITY</th><th>GODOWN</th><th className="w-14"></th></tr>
          </thead>
          <tbody>
            {items.map((it, idx) => {
              const overStock = it.available_qty !== undefined && (parseFloat(it.quantity) || 0) > (it.available_qty || 0) + 1e-6;
              const selectedGodown = (it.godowns || []).find((g) => g.godown_id === it.selected_godown_id);
              const overGodown = !!it.selected_godown_id && selectedGodown && (parseFloat(it.quantity) || 0) > (selectedGodown.available_qty || 0) + 1e-6;
              return (
              <tr key={idx} data-testid={`in-item-row-${idx}`} className={(overStock || overGodown) ? "bg-red-50" : ""}>
                <td className="font-mono text-slate-500">{idx + 1}</td>
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
                    placeholder="Enter part no"
                    className="rounded-sm font-mono h-8" data-testid={`in-part-no-${idx}`} />
                </td>
                <td className="w-64">
                  <Select disabled={!it.partLooked || it.makes.length === 0}
                    value={it.make || undefined} onValueChange={(v) => onMakeChange(idx, v)}>
                    <SelectTrigger className="rounded-sm h-8" data-testid={`in-make-${idx}`}>
                      <SelectValue placeholder={!it.partLooked ? "Enter Part No first" : (it.makes.length === 0 ? "No stock available" : "Select make")} />
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
                <td className="w-32">
                  <Input type="number" min="0.001" step="any" value={it.quantity}
                    disabled={!it.make}
                    onChange={(e) => updateItem(idx, { quantity: e.target.value })}
                    placeholder="0"
                    className={`rounded-sm font-mono h-8 text-center ${overStock || overGodown ? "border-red-400" : ""}`}
                    data-testid={`in-qty-${idx}`} />
                  {it.make && (
                    <div className={`text-[10px] mt-0.5 ${overStock || overGodown ? "text-red-600 font-bold" : "text-slate-500"}`}
                      data-testid={`in-avail-hint-${idx}`}>
                      {overGodown ? `Over godown ${it.quantity}/${selectedGodown?.available_qty || 0}` : (overStock ? `Over ${it.quantity}/${it.available_qty}` : `Available ${it.available_qty}`)}
                    </div>
                  )}
                </td>
                <td className="w-64">
                  <Select
                    disabled={!it.make || (it.godowns || []).length === 0}
                    value={it.selected_godown_id || NO_GODOWN}
                    onValueChange={(v) => onIssueGodownChange(idx, v)}
                  >
                    <SelectTrigger className="rounded-sm h-8" data-testid={`in-godown-${idx}`}>
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
                <td>
                  <button onClick={() => removeItem(idx)} disabled={items.length === 1}
                    className={`p-1.5 rounded-sm ${items.length === 1 ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                    data-testid={`in-remove-row-${idx}`}><Trash size={14} /></button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/picking-notes", { params: { page, page_size: PAGE_SIZE } });
      setRows(res.data);
      const t = parseInt(res.headers["x-total-count"], 10);
      setTotal(isNaN(t) ? res.data.length : t);
    } finally { setLoading(false); }
  }, [page]);
  useEffect(() => { load(); }, [load, reloadKey]);

  const handleDelete = async (pn) => {
    if (!window.confirm(`Delete ${pn.pn_no}?`)) return;
    try { await api.delete(`/picking-notes/${pn.id}`); toast.success(`${pn.pn_no} deleted`); load(); }
    catch (err) { toast.error(formatApiError(err.response?.data?.detail) || "Could not delete"); }
  };

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

  const columns = useMemo(() => [
    { key: "in_date", label: "ISSUE NOTE DATE", value: (r) => fmtDate(r.issue_note_date) },
    { key: "in_no", label: "ISSUE NOTE NO", value: (r) => r.issue_note_no || "" },
    { key: "pn_date", label: "PICKING NOTE DATE", value: (r) => fmtDate(r.pn_date) },
    { key: "pn_no", label: "PICKING NOTE NO", value: (r) => r.pn_no || "" },
    { key: "issued_to", label: "ISSUED TO", value: (r) => r.issued_to || "" },
    { key: "items_count", label: "ITEMS", value: (r) => pickingDisplayCount(r),},
    { key: "assigned_qty", label: "ASSIGNED", value: (r) => pickingAssignedQty(r)},
    { key: "picked_qty", label: "PICKED", value: (r) => pickingPickedQty(r)},
    { key: "status", label: "STATUS", value: (r) => (r.status === "RECORDED" || r.status === "COMPLETED") ? "Completed" : (r.status === "PENDING" ? "Pending" : "Draft") },
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
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div className="text-sm text-slate-600">
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
      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto overflow-visible">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-14">SL NO</th>
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
              const deleteTitle = recorded ? "Cannot delete — already recorded"
                : (lockedToOther ? `Locked — assigned to ${aName || aEmail}` : "Delete");
              const recordTitle = recorded ? "Already recorded"
                : (pending ? "Open Picking and save a draft first" : (lockedToOther ? `Locked — assigned to ${aName || aEmail}` : "Record as Stock Out"));
              const recordDisabled = lock || pending || recordingId === r.id;
              return (
                <tr key={r.id} data-testid={`pn-row-${r.pn_no}`}>
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td className="font-mono text-slate-700">{fmtDate(r.issue_note_date)}</td>
                  <td className="font-mono text-slate-700">{r.issue_note_no || "—"}</td>
                  <td className="font-mono text-slate-700">{fmtDate(r.pn_date)}</td>
                  <td>
                    <button onClick={() => onOpen(r)} className="font-mono font-semibold text-blue-700 hover:underline" data-testid={`pn-open-${r.pn_no}`}>{r.pn_no}</button>
                  </td>
                  <td className="text-slate-700">{r.issued_to || "—"}</td>
                  <td className="font-mono text-slate-600">{pickingDisplayCount(r)}</td>
                  <td className="font-mono font-bold text-slate-900">{totalQty}</td>
                  <td className="font-mono font-bold text-slate-900">{pickedQty}</td>
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${recorded ? "bg-green-100 text-green-800" : (pending ? "bg-blue-50 text-blue-800" : "bg-amber-50 text-amber-700")}`} data-testid={`pn-status-${r.pn_no}`}>
                      {recorded ? "Completed" : (pending ? "Pending" : "Draft")}
                    </span>
                  </td>
                  <td className="text-left whitespace-nowrap">
                    <button onClick={() => onEdit(r)} disabled={lock}
                      title={editTitle}
                      className={`p-1.5 rounded-sm mr-1 ${lock ? "text-slate-300 cursor-not-allowed" : "hover:bg-slate-100"}`}
                      data-testid={`pn-edit-${r.pn_no}`}>
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => handleDelete(r)} disabled={lock}
                      title={deleteTitle}
                      className={`p-1.5 rounded-sm mr-2 ${lock ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                      data-testid={`pn-delete-${r.pn_no}`}>
                      <Trash size={14} />
                    </button>
                    <Button onClick={() => handleRecord(r)} disabled={recordDisabled} size="sm"
                      title={recordTitle}
                      className={`rounded-sm h-7 text-xs ${lock ? "bg-slate-200 text-slate-500 cursor-not-allowed hover:bg-slate-200" : "bg-emerald-700 hover:bg-emerald-800 text-white"}`}
                      data-testid={`pn-record-${r.pn_no}`}>
                      <CheckCircle size={12} weight="bold" className="mr-1" />
                      {recorded ? "Recorded" : (recordingId === r.id ? "Recording…" : "Record Stock Out")}
                    </Button>
                  </td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && (
              <tr><td colSpan={11} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? "No pending picking notes." : "No rows match the current filters.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between mt-3 text-xs text-slate-600">
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
    </div>
  );
}

function PickingNoteDetailDialog({ pn, onClose }) {
  return (
    <Dialog open={!!pn} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl rounded-sm" data-testid="pn-detail-dialog">
        {pn && (
          <>
            <DialogHeader>
              <div className="flex items-center justify-between gap-3">
                <DialogTitle className="text-2xl font-black font-mono">{pn.pn_no}</DialogTitle>
                <Button onClick={() => printPickingNote(pn)} variant="outline" size="sm" className="rounded-sm" data-testid="pn-print-button">
                  <FileText size={14} weight="bold" className="mr-2" /> Print
                </Button>
              </div>
            </DialogHeader>
            <div className="grid grid-cols-3 gap-4 text-sm border-b border-slate-200 pb-4 mb-4">
              <Detail k="Picking Note Date" v={fmtDate(pn.pn_date)} />
              <Detail k="Issue Note No" v={pn.issue_note_no || "—"} />
              <Detail k="Issued To" v={pn.issued_to || "—"} />
              <Detail k="Status" v={pn.status} />
              <Detail k="Created By" v={pn.created_by || "—"} />
              <Detail k="Created At" v={new Date(pn.created_at).toLocaleString()} />
              <div>
                <div className="label-sm">Assigned To (from Issue Note)</div>
                <div className="mt-1"><AssigneeBadge name={pn.parent_assigned_to_name} email={pn.parent_assigned_to_email} /></div>
              </div>
            </div>
            <table className="data-table w-full text-xs">
              <thead><tr><th>SL</th><th>PART NO</th><th>MAKE</th><th>DESCRIPTION</th><th>STATUS</th><th className="text-center">QTY</th><th>GODOWN</th><th>RACK</th><th>BOX</th></tr></thead>
              <tbody>
                {pickingDisplayItems(pn).map((it, idx) => (
                  <tr key={idx}>
                    <td className="font-mono text-slate-500">{idx + 1}</td>
                    <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                    <td>{it.make}</td>
                    <td className="text-slate-700 max-w-[260px] truncate">{it.description_1 || "—"}</td>
                    <td className="font-mono text-slate-600">{it.row_status || "—"}</td>
                    <td className="text-center font-mono font-bold">{it.quantity}</td>
                    <td className="font-mono">{it.godown_name || "—"}</td>
                    <td className="font-mono">{it.rack_no || "—"}</td>
                    <td className="font-mono">{it.box_no || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
  const [issuedTo, setIssuedTo] = useState("");
  const [items, setItems] = useState([]);
  const [saving, setSaving] = useState(false);

  const [godowns, setGodowns] = useState([]);
  const [racksByGodown, setRacksByGodown] = useState({});
  const [boxesByRack, setBoxesByRack] = useState({});

  useEffect(() => { api.get("/godowns").then((r) => setGodowns(r.data)); }, []);

  useEffect(() => {
    if (isEdit) {
      setPnNo(editing.pn_no);
      setPnDate(editing.pn_date);
      setSelectedInId(editing.issue_note_id);
      setIssuedTo(editing.issued_to || "");
      setPendingIns([{ id: editing.issue_note_id, in_no: editing.issue_note_no, in_date: editing.issue_note_date, issued_to: editing.issued_to }]);
      api.get(`/picking-notes/prepare/${editing.issue_note_id}`, { params: { exclude_pn_id: editing.id } })
        .then((r) => {
          setItems(buildPickingEditItems(editing, r.data.items || []));
        }).catch(() => setItems((editing.items || []).map((it) => ({ ...it, available_locations: [], pending_qty: 0, requested_qty: 0 }))));
    } else {
      api.get("/picking-notes/next-no").then((r) => { setPnNo(r.data.next_pn_no); setPnDate(r.data.pn_date); })
        .catch(() => toast.error("Could not preview picking-note number"));
      api.get("/issue-notes", { params: { not_status: "FULLY_PICKED,COMPLETED", page_size: 100 } })
        .then((r) => setPendingIns(r.data || []));
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
    items.forEach((it) => { if (it.godown_id) ensureRacks(it.godown_id); if (it.rack_id) ensureBoxes(it.rack_id); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  const handleInChange = async (id) => {
    setSelectedInId(id);
    if (!id) { setItems([]); setIssuedTo(""); return; }
    const inn = pendingIns.find((x) => x.id === id);
    setIssuedTo(inn?.issued_to || "");
    try {
      const { data } = await api.get(`/picking-notes/prepare/${id}`);
      setItems(data.items || []);
      (data.items || []).forEach((it) => { if (it.godown_id) ensureRacks(it.godown_id); if (it.rack_id) ensureBoxes(it.rack_id); });
    } catch (err) { toast.error(formatApiError(err.response?.data?.detail) || "Could not prepare items"); }
  };

  const updateItem = (i, patch) => setItems((p) => p.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  const onGodownChange = async (i, gid) => {
    const g = godowns.find((x) => x.id === gid);
    updateItem(i, { godown_id: gid, godown_name: g?.godown_name || "", rack_id: "", rack_no: "", box_id: "", box_no: "", box_category: "" });
    await ensureRacks(gid);
  };
  const onRackChange = async (i, rid) => {
    const racks = racksByGodown[items[i].godown_id] || [];
    const rk = racks.find((x) => x.id === rid);
    updateItem(i, { rack_id: rid, rack_no: rk?.rack_no || "", box_id: "", box_no: "", box_category: "" });
    await ensureBoxes(rid);
  };
  const onBoxChange = (i, bid) => {
    const boxes = boxesByRack[items[i].rack_id] || [];
    const bx = boxes.find((x) => x.id === bid);
    updateItem(i, { box_id: bid, box_no: bx?.box_no || "", box_category: bx?.box_category || "" });
  };

  const applyExistingLocation = async (i, loc) => {
    await ensureRacks(loc.godown_id);
    await ensureBoxes(loc.rack_id);
    updateItem(i, {
      godown_id: loc.godown_id, godown_name: loc.godown_name,
      rack_id: loc.rack_id, rack_no: loc.rack_no,
      box_id: loc.box_id, box_no: loc.box_no, box_category: loc.box_category || "",
    });
  };

  const splitRow = (i) => {
    setItems((prev) => {
      const src = prev[i];
      const copy = { ...src, quantity: 0, godown_id: "", godown_name: "", rack_id: "", rack_no: "", box_id: "", box_no: "", box_category: "" };
      const out = [...prev];
      out.splice(i + 1, 0, copy);
      return out;
    });
  };
  const removeRow = (i) => setItems((p) => p.filter((_, idx) => idx !== i));

  const allocatedByKey = useMemo(() => {
    const m = {};
    items.forEach((r) => {
      if (isDisplayOnlyRemainingRow(r)) return;
      const k = `${r.part_no}||${r.make}`;
      m[k] = (m[k] || 0) + (parseFloat(r.quantity) || 0);
    });
    return m;
  }, [items]);

  const save = async () => {
    if (!selectedInId) { toast.error("Select an Issue Note"); return; }
    const pickRows = items.filter((it) => !isDisplayOnlyRemainingRow(it));
    if (pickRows.length === 0) { toast.error("No picked allocations to save"); return; }
    for (let i = 0; i < pickRows.length; i++) {
      const rowNo = items.indexOf(pickRows[i]) + 1;
      const it = pickRows[i];
      if (!it.godown_id || !it.rack_id) { toast.error(`Row ${rowNo}: pick Godown / Rack`); return; }
      const hasBoxes = (boxesByRack[it.rack_id] || []).length > 0;
      if (hasBoxes && !it.box_id) { toast.error(`Row ${rowNo}: pick Box`); return; }
      const q = parseFloat(it.quantity);
      if (isNaN(q) || q <= 0) { toast.error(`Row ${rowNo}: quantity must be > 0`); return; }
      // Per-location available check (client-side)
      const loc = (it.available_locations || []).find((L) => (L.box_id || "") === (it.box_id || ""));
      if (loc && q > (loc.available_qty ?? loc.current_qty) + 1e-6) {
        toast.error(`Row ${rowNo}: only ${loc.available_qty ?? loc.current_qty} available at ${loc.godown_name}/${loc.rack_no}/${loc.box_no || "—"}`);
        return;
      }
    }
    // Cumulative-vs-pending check
    const pendingMap = {};
    pickRows.forEach((r) => {
      const k = `${r.part_no}||${r.make}`;
      if (pendingMap[k] === undefined && r.pending_qty !== undefined) pendingMap[k] = r.pending_qty;
    });
    for (const [k, allocated] of Object.entries(allocatedByKey)) {
      const pending = pendingMap[k];
      if (pending !== undefined && allocated > pending + 1e-6) {
        const [p, m] = k.split("||");
        toast.error(`${p} / ${m}: allocated ${allocated} exceeds pending ${pending}`);
        return;
      }
    }

    setSaving(true);
    try {
      const payload = {
        issue_note_id: selectedInId,
          items: pickRows.map((it) => ({
          part_no: it.part_no, make: it.make, quantity: parseFloat(it.quantity),
          model: it.model || "", old_part_no: it.old_part_no || "", make_part_no: it.make_part_no || "",
          description_1: it.description_1 || "", description_2: it.description_2 || "",
          remarks_oem: it.remarks_oem || "", remarks_others: it.remarks_others || "",
          item_category: it.item_category || "",
          godown_id: it.godown_id, godown_name: it.godown_name,
          rack_id: it.rack_id, rack_no: it.rack_no,
          box_id: it.box_id, box_no: it.box_no, box_category: it.box_category || "",
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
                  <span className="font-mono">{inn.in_no}</span><span className="ml-3 text-slate-500 text-xs">{fmtDate(inn.in_date)} · {inn.issued_to || "—"}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="label-sm">Issued To</Label>
          <Input value={issuedTo} disabled className="mt-2 rounded-sm bg-slate-50" data-testid="pn-issued-to" />
        </div>
      </div>

      {items.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto">
          <table className="data-table w-full text-xs">
            <thead>
              <tr>
                <th className="w-10">SL</th>
                <th>PART NO</th>
                <th>MAKE</th>
                <th>MODEL</th>
                <th>DESCRIPTION</th>
                <th>CATEGORY</th>
                <th>STATUS</th>
                <th className="text-center">QTY</th>
                <th className="min-w-[140px]">GODOWN *</th>
                <th className="min-w-[120px]">RACK *</th>
                <th className="min-w-[120px]">BOX *</th>
                <th>AVAILABLE LOCATIONS</th>
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
                const requested = it.requested_qty;
                const overAllocated = pending !== undefined && allocated > pending + 1e-6;
                const currentLoc = (it.available_locations || []).find((L) => (L.box_id || "") === (it.box_id || ""));
                const availAtCurrent = currentLoc ? (currentLoc.available_qty ?? currentLoc.current_qty) : null;
                const overAtLoc = availAtCurrent !== null && (parseFloat(it.quantity) || 0) > availAtCurrent + 1e-6;
                return (
                  <tr key={idx} data-testid={`pn-item-row-${idx}`} className={(overAllocated || overAtLoc) ? "bg-red-50" : ""}>
                    <td className="font-mono text-slate-500">{idx + 1}</td>
                    <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                    <td>{it.make}</td>
                    <td className="font-mono text-slate-600">{it.model || "—"}</td>
                    <td className="text-slate-700 max-w-[200px] truncate" title={it.description_1}>{it.description_1 || "—"}</td>
                    <td className="text-slate-600">{it.item_category || "—"}</td>
                    <td className="font-mono text-[11px] text-slate-600">{it.row_status || "Draft Pick"}</td>
                    <td className="text-center">
                      <Input type="number" min="0.001" step="any" value={it.quantity}
                        onChange={(e) => updateItem(idx, { quantity: e.target.value })}
                        className={`rounded-sm font-mono h-8 text-center w-20 ${overAllocated || overAtLoc ? "border-red-400" : ""}`}
                        data-testid={`pn-qty-${idx}`} />
                      {pending !== undefined && (
                        <div className={`text-[10px] mt-0.5 ${overAllocated ? "text-red-600 font-bold" : "text-slate-500"}`}
                          data-testid={`pn-pending-hint-${idx}`}>
                          {overAllocated ? `Over ${allocated}/${pending}` : `Pending ${pending} of ${requested}`}
                        </div>
                      )}
                      {availAtCurrent !== null && (
                        <div className={`text-[10px] ${overAtLoc ? "text-red-600 font-bold" : "text-slate-400"}`}>
                          Avail {availAtCurrent} at loc
                        </div>
                      )}
                    </td>
                    <td>
                      <Select value={it.godown_id || undefined} onValueChange={(v) => onGodownChange(idx, v)}>
                        <SelectTrigger className="rounded-sm h-8" data-testid={`pn-godown-${idx}`}><SelectValue placeholder="Godown" /></SelectTrigger>
                        <SelectContent>{godowns.map((g) => <SelectItem key={g.id} value={g.id}>{g.godown_name}</SelectItem>)}</SelectContent>
                      </Select>
                    </td>
                    <td>
                      <Select value={it.rack_id || undefined} onValueChange={(v) => onRackChange(idx, v)} disabled={!it.godown_id}>
                        <SelectTrigger className="rounded-sm h-8" data-testid={`pn-rack-${idx}`}><SelectValue placeholder="Rack" /></SelectTrigger>
                        <SelectContent>{racks.map((r) => <SelectItem key={r.id} value={r.id}>{r.rack_no}</SelectItem>)}</SelectContent>
                      </Select>
                    </td>
                    <td>
                      <Select value={it.box_id || undefined} onValueChange={(v) => onBoxChange(idx, v)} disabled={!it.rack_id || boxes.length === 0}>
                        <SelectTrigger className="rounded-sm h-8" data-testid={`pn-box-${idx}`}>
                          <SelectValue placeholder={!it.rack_id ? "Box" : (boxes.length === 0 ? "No boxes — skip" : "Box")} />
                        </SelectTrigger>
                        <SelectContent>{boxes.map((b) => <SelectItem key={b.id} value={b.id}>{b.box_no}</SelectItem>)}</SelectContent>
                      </Select>
                    </td>
                    <td>
                      {(it.available_locations || []).length === 0 ? (
                        <span className="text-[11px] text-red-600 italic">No stock available</span>
                      ) : (
                        <div className="flex flex-wrap gap-1 max-w-[260px]">
                          {(it.available_locations || []).map((loc, k) => {
                            const isCurrent = (loc.box_id || "") === (it.box_id || "") && loc.rack_id === it.rack_id;
                            const avail = loc.available_qty ?? loc.current_qty;
                            return (
                              <button key={k} onClick={() => applyExistingLocation(idx, loc)}
                                disabled={avail <= 0}
                                className={`text-[10px] font-mono px-2 py-0.5 rounded-sm border ${isCurrent ? "bg-blue-50 border-blue-300 text-blue-800" : (avail <= 0 ? "bg-slate-50 border-slate-200 text-slate-400 cursor-not-allowed" : "bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100")}`}
                                title={`${loc.godown_name}/${loc.rack_no}/${loc.box_no || '—'} — ${avail} available`}
                                data-testid={`pn-existing-loc-${idx}-${k}`}>
                                <MapPin size={10} weight="bold" className="inline mr-0.5" />
                                {loc.godown_name}/{loc.rack_no}/{loc.box_no || "—"} ({avail})
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      <button onClick={() => splitRow(idx)} className="p-1 hover:bg-blue-50 text-blue-700 rounded-sm mr-1"
                        title="Split into another row" data-testid={`pn-split-${idx}`}>
                        <ArrowsSplit size={14} weight="bold" />
                      </button>
                      <button onClick={() => removeRow(idx)} disabled={items.length === 1}
                        className={`p-1 rounded-sm ${items.length === 1 ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                        data-testid={`pn-remove-${idx}`}>
                        <Trash size={14} />
                      </button>
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
