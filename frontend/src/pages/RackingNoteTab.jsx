import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { api, formatApiError } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel,
} from "../components/ui/select";
import PartNoLink from "../components/PartNoLink";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "../components/ui/dialog";
import { toast } from "sonner";
import {
  Plus, Trash, ArrowLeft, FloppyDisk, CaretLeft, CaretRight, Pencil, CheckCircle, MapPin, ArrowsSplit,
  DownloadSimple, ArrowsClockwise,
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

function hasCompleteRackingLocations(rkn) {
  const items = rkn?.items || [];
  return items.length > 0 && items.every((it) =>
    (it.godown_id || "").trim() &&
    (it.rack_id || "").trim() &&
    (it.box_id || "").trim() &&
    (parseFloat(it.quantity) || 0) > 0
  );
}

// Phase 2: source-type badge colours (RN=blue, SRN=amber, ERN=purple)
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


/* ==============================================================
   STOCK IN  ·  Racking Note tab
   ============================================================== */
export default function RackingNoteTab() {
  const [view, setView] = useState("list"); // list | create | edit | detail
  const [editing, setEditing] = useState(null);
  const [openRkn, setOpenRkn] = useState(null);
  const [openRn, setOpenRn] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const goCreate = () => { setEditing(null); setView("create"); };
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
          onCreate={goCreate}
          onEdit={goEdit}
          onOpen={(r) => setOpenRkn(r)}
          onOpenRn={handleOpenRn}
          onRecorded={() => setReloadKey((k) => k + 1)}
        />
      )}
      {(view === "create" || view === "edit") && (
        <RackingNoteForm editing={editing} onCancel={goList} onSaved={goList} />
      )}
      <RackingNoteDetailDialog rkn={openRkn} onClose={() => setOpenRkn(null)} />
      <ReceiptNoteDetailDialog rn={openRn} onClose={() => setOpenRn(null)} />
    </>
  );
}

/* ---------- LIST VIEW ---------- */
function RackingNoteList({ reloadKey, onCreate, onEdit, onOpen, onOpenRn, onRecorded }) {
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

  const handleRecord = async (rkn) => {
    if (!hasCompleteRackingLocations(rkn)) {
      toast.error("Complete Godown, Rack, Box and Qty before recording Stock In");
      return;
    }
    if (!window.confirm(`Record ${rkn.rkn_no} as Stock In?\n\nThis will add ${rkn.items.length} stock-in transaction(s) and mark the linked Receipt Note (${rkn.receipt_note_no}) as RACKED. This cannot be undone.`)) return;
    setRecordingId(rkn.id);
    try {
      const res = await api.post(`/racking-notes/${rkn.id}/record`);
      const data = res.data || {};
      const autoRkn = res.headers?.["x-auto-rkn-no"] || data.auto_rkn_no;
      if (autoRkn) {
        toast.success(`Recorded · ${data.transactions_created} stock-in transaction(s) · ${autoRkn} auto-created for remaining qty`);
      } else {
        toast.success(`Recorded · ${data.transactions_created} stock-in transaction(s) created`);
      }
      load();
      onRecorded?.();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not record");
    } finally { setRecordingId(null); }
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
          <Button onClick={onCreate} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="create-rkn-button">
            <Plus size={16} weight="bold" className="mr-2" /> Create New Racking Note
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
              const totalQty = (r.items || []).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0);
              const recorded = r.status === "RECORDED";
              const assigneeId = r.parent_assigned_to_user_id;
              const assigneeName = r.parent_assigned_to_name;
              const assigneeEmail = r.parent_assigned_to_email;
              const isLockedToOther = !!assigneeId && assigneeId !== me?.id && !isAdmin;
              const lock = recorded || isLockedToOther;
              const locationsComplete = hasCompleteRackingLocations(r);
              const recordDisabled = lock || !locationsComplete || recordingId === r.id;
              const editTitle = recorded ? "Cannot edit — already recorded"
                : (isLockedToOther ? `Locked — assigned to ${assigneeName || assigneeEmail}` : "Edit");
              const deleteTitle = recorded ? "Cannot delete — already recorded"
                : (isLockedToOther ? `Locked — assigned to ${assigneeName || assigneeEmail}` : "Delete");
              const recordTitle = recorded ? "Already recorded"
                : (isLockedToOther ? `Locked — assigned to ${assigneeName || assigneeEmail}`
                  : (!locationsComplete ? "Complete Godown, Rack, Box and Qty before recording" : "Record as Stock In"));
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
                      <Button
                        onClick={() => handleRecord(r)}
                        disabled={recordDisabled}
                        size="sm"
                        title={recordTitle}
                        className={`rounded-sm h-7 text-xs ml-1 ${recordDisabled ? "bg-slate-200 text-slate-500 cursor-not-allowed hover:bg-slate-200" : "bg-emerald-700 hover:bg-emerald-800 text-white"}`}
                        data-testid={`rkn-record-${r.rkn_no}`}
                      >
                        <CheckCircle size={12} weight="bold" className="mr-1" />
                        {recorded ? "Recorded" : (recordingId === r.id ? "Recording…" : "Record Stock In")}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && (
              <tr><td colSpan={8} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? "No racking notes. Click 'Create New Racking Note' to begin." : "No rows match the current filters.")}</td></tr>
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
function RackingNoteDetailDialog({ rkn, onClose }) {
  return (
    <Dialog open={!!rkn} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl rounded-sm" data-testid="rkn-detail-dialog">
        {rkn && (
          <>
            <DialogHeader>
              <DialogTitle className="text-2xl font-black font-mono">{rkn.rkn_no}</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-3 gap-4 text-sm border-b border-slate-200 pb-4 mb-4">
              <Detail k="Racking Note Date" v={fmtDate(rkn.rkn_date)} />
              <Detail k="Receipt Note No" v={rkn.receipt_note_no || "—"} />
              <Detail k="Receipt Note Date" v={fmtDate(rkn.receipt_note_date)} />
              <div>
                <div className="label-sm">Racked Against</div>
                <div className="font-mono mt-1 text-slate-900 flex items-center gap-2" data-testid="rkn-detail-source">
                  <SourceTypeBadge type={rkn.source_type || "RN"} />
                  <span>{rkn.source_no || rkn.receipt_note_no || "—"}</span>
                </div>
              </div>
              <Detail k="Status" v={rkn.status === "RECORDED" ? "Fully Racked" : (rkn.status || "Draft")} />
              <Detail k="Created By" v={rkn.created_by || "—"} />
              <Detail k="Created At" v={new Date(rkn.created_at).toLocaleString()} />
              <div>
                <div className="label-sm">Assigned To (from Receipt Note)</div>
                <div className="mt-1"><AssigneeBadge name={rkn.parent_assigned_to_name} email={rkn.parent_assigned_to_email} /></div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="data-table w-full text-xs">
                <thead>
                  <tr>
                    <th>SL</th>
                    <th>PART NO</th>
                    <th>MAKE</th>
                    <th>MODEL</th>
                    <th>DESCRIPTION</th>
                    <th>CATEGORY</th>
                    <th className="text-right">QTY</th>
                    <th>GODOWN</th>
                    <th>RACK</th>
                    <th>BOX</th>
                  </tr>
                </thead>
                <tbody>
                  {(rkn.items || []).map((it, idx) => (
                    <tr key={idx}>
                                            <td className="font-mono text-slate-500">{idx + 1}</td>
                      <td className="font-mono text-slate-600">{it.model || "—"}</td>
                      <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                      <td className="text-slate-700 max-w-[260px] truncate" title={it.description_1}>{it.description_1 || "—"}</td>
                      <td className="text-slate-600">{it.item_category || "—"}</td>
                      <td className="text-right font-mono font-bold">{it.quantity}</td>
                      <td className="font-mono">{it.godown_name || "—"}</td>
                      <td className="font-mono">{it.rack_no || "—"}</td>
                      <td className="font-mono">{it.box_no || "—"}</td>
                    </tr>
                  ))}
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

/* ---------- CREATE / EDIT FORM ---------- */
function RackingNoteForm({ editing, onCancel, onSaved }) {
  const isEdit = !!editing;
  const [rknNo, setRknNo] = useState("");
  const [rknDate, setRknDate] = useState("");
  // Phase 2: polymorphic sources grouped by parent RN.
  // sourceGroups: [{ parent_rn_no, parent_rn_date, sources: [{source_type, source_id, source_no, ...}] }]
  const [sourceGroups, setSourceGroups] = useState([]);
  // Currently-selected source = composite "TYPE:ID" key.
  const [selectedSourceKey, setSelectedSourceKey] = useState("");
  const [selectedSource, setSelectedSource] = useState(null); // full object from sources list OR prepare-source response.source
  const [items, setItems] = useState([]);
  const [narration, setNarration] = useState("");
  const [saving, setSaving] = useState(false);

  // Cascading dropdown caches
  const [godowns, setGodowns] = useState([]);
  const [racksByGodown, setRacksByGodown] = useState({}); // {godown_id: [racks]}
  const [boxesByRack, setBoxesByRack] = useState({});

  useEffect(() => { api.get("/godowns").then((r) => setGodowns(r.data)); }, []);

  // Bootstrap form
  useEffect(() => {
    if (isEdit) {
      setRknNo(editing.rkn_no);
      setRknDate(editing.rkn_date);
      setNarration(editing.narration || "");
      // Resolve source identity: prefer Phase 2 fields, fall back to legacy receipt_note_id.
      const srcType = editing.source_type || "RN";
      const srcId = editing.source_id || editing.receipt_note_id;
      const srcNo = editing.source_no || editing.receipt_note_no;
      const srcDate = editing.source_date || editing.receipt_note_date;
      const key = `${srcType}:${srcId}`;
      setSelectedSourceKey(key);
      setSelectedSource({
        source_type: srcType, source_id: srcId, source_no: srcNo, source_date: srcDate,
        parent_rn_id: editing.receipt_note_id, parent_rn_no: editing.receipt_note_no, parent_rn_date: editing.receipt_note_date,
      });
      // Seed the dropdown with a single-group entry so the trigger displays something sensible.
      setSourceGroups([{
        parent_rn_id: editing.receipt_note_id,
        parent_rn_no: editing.receipt_note_no,
        parent_rn_date: editing.receipt_note_date,
        sources: [{ source_type: srcType, source_id: srcId, source_no: srcNo, source_date: srcDate, status: "" }],
      }]);
      // Fetch a fresh prepare to learn pending_qty per (part,make) excluding THIS rkn so user can edit safely
      api.get("/racking-notes/prepare-source", { params: { source_type: srcType, source_id: srcId, exclude_rkn_id: editing.id } })
        .then((r) => {
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
            };
          }));
        }).catch(() => {
          setItems((editing.items || []).map((it) => ({ ...it, existing_locations: [], pending_qty: 0, received_qty: 0, rackable_qty: 0 })));
        });
    } else {
      api.get("/racking-notes/next-no").then((r) => {
        setRknNo(r.data.next_rkn_no);
        setRknDate(r.data.rkn_date);
      }).catch(() => toast.error("Could not preview racking-note number"));
      // Phase 2: fetch polymorphic source groups (RN + SRN + ERN) keyed by parent RN.
      api.get("/racking-notes/sources")
        .then((r) => setSourceGroups(r.data || []))
        .catch((err) => toast.error(formatApiError(err.response?.data?.detail) || "Could not load racking sources"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, editing]);

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

  const handleSourceChange = async (compositeKey) => {
    setSelectedSourceKey(compositeKey);
    if (!compositeKey) { setItems([]); setSelectedSource(null); return; }
    const [sourceType, sourceId] = compositeKey.split(":");
    if (!sourceType || !sourceId) { setItems([]); setSelectedSource(null); return; }
    try {
      const { data } = await api.get("/racking-notes/prepare-source", {
        params: { source_type: sourceType, source_id: sourceId },
      });
      setSelectedSource(data.source || null);
      setItems(data.items || []);
      // Eagerly preload racks/boxes for prefilled rows
      (data.items || []).forEach((it) => {
        if (it.godown_id) ensureRacks(it.godown_id);
        if (it.rack_id) ensureBoxes(it.rack_id);
      });
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not prepare items");
    }
  };

  const updateItem = (i, patch) => setItems((prev) => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  const onGodownChange = async (i, godownId) => {
    const g = godowns.find((x) => x.id === godownId);
    updateItem(i, { godown_id: godownId, godown_name: g?.godown_name || "", rack_id: "", rack_no: "", box_id: "", box_no: "", box_category: "" });
    await ensureRacks(godownId);
  };
  const onRackChange = async (i, rackId) => {
    const racks = racksByGodown[items[i].godown_id] || [];
    const rk = racks.find((x) => x.id === rackId);
    updateItem(i, { rack_id: rackId, rack_no: rk?.rack_no || "", box_id: "", box_no: "", box_category: "" });
    await ensureBoxes(rackId);
  };
  const onBoxChange = (i, boxId) => {
    const boxes = boxesByRack[items[i].rack_id] || [];
    const bx = boxes.find((x) => x.id === boxId);
    updateItem(i, { box_id: boxId, box_no: bx?.box_no || "", box_category: bx?.box_category || "" });
  };

  // Apply an existing-location chip click
  const applyExistingLocation = async (i, loc) => {
    await ensureRacks(loc.godown_id);
    await ensureBoxes(loc.rack_id);
    updateItem(i, {
      godown_id: loc.godown_id, godown_name: loc.godown_name,
      rack_id: loc.rack_id, rack_no: loc.rack_no,
      box_id: loc.box_id, box_no: loc.box_no,
      box_category: loc.box_category || "",
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
        // existing_locations & received/pending hint stay the same so the chips still appear
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

  // Sum of qty per (part_no, make) across the current rows -- used to display "Allocated X of Y" hints
  const allocatedByKey = useMemo(() => {
    const map = {};
    items.forEach((r) => {
      const k = `${r.part_no}||${r.make}`;
      map[k] = (map[k] || 0) + (parseFloat(r.quantity) || 0);
    });
    return map;
  }, [items]);

  const save = async () => {
    if (!selectedSourceKey) { toast.error("Select a racking source (RN / SRN / ERN)"); return; }
    const [sourceType, sourceId] = selectedSourceKey.split(":");
    if (!sourceType || !sourceId) { toast.error("Invalid source selection"); return; }
    if (items.length === 0) { toast.error("No items to rack"); return; }
    // Per-row checks
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.godown_id || !it.rack_id) {
        toast.error(`Row ${i + 1}: pick Godown / Rack`); return;
      }
      if (!it.box_id) {
        toast.error(`Row ${i + 1}: pick Box`); return;
      }
      const q = parseFloat(it.quantity);
      if (isNaN(q) || q <= 0) { toast.error(`Row ${i + 1}: quantity must be > 0`); return; }
    }
    // Cumulative-vs-pending check (client-side; backend re-validates)
    // Build a map of pending_qty per key from the current rows (any row carries it)
    const pendingMap = {};
    items.forEach((r) => {
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
        source_type: sourceType,
        source_id: sourceId,
        // Legacy back-compat: backend still accepts receipt_note_id; harmless when source_type/id is sent.
        receipt_note_id: sourceType === "RN" ? sourceId : (selectedSource?.parent_rn_id || undefined),
        narration: narration.trim(),
        items: items.map((it) => ({
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
        ? await api.put(`/racking-notes/${editing.id}`, payload)
        : await api.post("/racking-notes", payload);
      toast.success(`Racking Note ${data.rkn_no} ${isEdit ? "updated" : "saved"}`);
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save");
    } finally { setSaving(false); }
  };

  return (
    <div className="mt-4 space-y-6" data-testid="rkn-create-view">
      <div className="flex items-center justify-between">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="rkn-back-button">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
      </div>

      {/* HEADER */}
      <div className="bg-white border border-slate-200 rounded-sm p-6 grid grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <Label className="label-sm">Racking Note Date</Label>
          <Input value={rknDate} disabled className="mt-2 rounded-sm font-mono bg-slate-50" data-testid="rkn-date-input" />
        </div>
        <div>
          <Label className="label-sm">Racking Note No</Label>
          <Input value={rknNo} disabled className="mt-2 rounded-sm font-mono font-semibold bg-blue-50 text-blue-900" data-testid="rkn-no-input" />
        </div>
        <div className="col-span-2 lg:col-span-3">
          <Label className="label-sm">Racking Source *</Label>
          <Select value={selectedSourceKey || undefined} onValueChange={handleSourceChange} disabled={isEdit}>
            <SelectTrigger className="mt-2 rounded-sm" data-testid="rkn-source-select">
              <SelectValue placeholder={sourceGroups.length === 0 ? "No rackable sources available" : "Select a source (RN / SRN / ERN)"} />
            </SelectTrigger>
            <SelectContent className="max-h-[420px]">
              {sourceGroups.map((grp, gi) => (
                <SelectGroup key={`${grp.parent_rn_id}-${gi}`}>
                  <SelectLabel className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 bg-slate-50 border-b border-slate-100">
                    <span className="font-mono text-slate-800">{grp.parent_rn_no}</span>
                    <span className="ml-2 text-slate-400">·</span>
                    <span className="ml-2 font-mono text-slate-500">{fmtDate(grp.parent_rn_date)}</span>
                    {grp.invoice_no ? (
                      <span className="ml-2 text-slate-400 normal-case tracking-normal">Inv {grp.invoice_no}</span>
                    ) : null}
                  </SelectLabel>
                  {(grp.sources || []).map((s) => {
                    const key = `${s.source_type}:${s.source_id}`;
                    return (
                      <SelectItem
                        key={key}
                        value={key}
                        className="pl-6"
                        data-testid={`rkn-source-option-${s.source_type}-${s.source_id}`}
                      >
                        <span className="inline-flex items-center gap-2">
                          <SourceTypeBadge type={s.source_type} />
                          <span className="font-mono font-semibold">{s.source_no}</span>
                          <span className="text-slate-400 text-[11px]">{fmtDate(s.source_date)}</span>
                          {s.assigned_to_name ? (
                            <span className="text-[10px] text-slate-500 ml-1">· {s.assigned_to_name}</span>
                          ) : null}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          {isEdit && <div className="text-[11px] text-slate-500 mt-1">Source cannot be changed in edit mode</div>}
          {selectedSource && (
            <div className="text-[11px] text-slate-600 mt-2 flex items-center gap-2" data-testid="rkn-selected-source-hint">
              Racking against:
              <SourceTypeBadge type={selectedSource.source_type || selectedSource.type} />
              <span className="font-mono font-semibold">{selectedSource.source_no || selectedSource.no}</span>
              {(selectedSource.parent_rn_no && (selectedSource.parent_rn_no !== (selectedSource.source_no || selectedSource.no))) && (
                <span className="text-slate-500">(parent <span className="font-mono">{selectedSource.parent_rn_no}</span>)</span>
              )}
            </div>
          )}
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
                <th>DESCRIPTION 1</th>
                <th>ITEM CATEGORY</th>
                <th className="text-right">QTY</th>
                <th className="min-w-[140px]">GODOWN *</th>
                <th className="min-w-[120px]">RACK *</th>
                <th className="min-w-[120px]">BOX *</th>
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
                const overAllocated = pending !== undefined && allocated > pending + 1e-6;
                return (
                  <tr key={idx} data-testid={`rkn-item-row-${idx}`} className={overAllocated ? "bg-red-50" : ""}>
                                        <td className="font-mono text-slate-500">{idx + 1}</td>
                    <td className="font-mono text-slate-600">{it.model || "—"}</td>
                    <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                    <td className="text-slate-700 max-w-[200px] truncate" title={it.description_1}>{it.description_1 || "—"}</td>
                    <td className="text-slate-600">{it.item_category || "—"}</td>
                    <td className="text-right">
                      <Input type="number" min="0.001" step="any" value={it.quantity}
                        onChange={(e) => updateItem(idx, { quantity: e.target.value })}
                        className={`rounded-sm font-mono h-8 text-right w-20 ${overAllocated ? "border-red-400" : ""}`} data-testid={`rkn-qty-${idx}`} />
                      {pending !== undefined && (
                        <div className={`text-[10px] mt-0.5 ${overAllocated ? "text-red-600 font-bold" : "text-slate-500"}`} data-testid={`rkn-pending-hint-${idx}`}>
                          {overAllocated ? `Over ${allocated}/${pending}` : `Pending ${pending} of ${received}`}
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
                      <Select value={it.box_id || undefined} onValueChange={(v) => onBoxChange(idx, v)} disabled={!it.rack_id || boxes.length === 0}>
                        <SelectTrigger className="rounded-sm h-8" data-testid={`rkn-box-${idx}`}>
                          <SelectValue placeholder={!it.rack_id ? "Box" : (boxes.length === 0 ? "No boxes configured" : "Box")} />
                        </SelectTrigger>
                        <SelectContent>
                          {boxes.map((b) => <SelectItem key={b.id} value={b.id}>{b.box_no}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                    <td>
                      {(it.existing_locations || []).length === 0 ? (
                        <span className="text-[11px] text-slate-400 italic">New part — pick any location</span>
                      ) : (
                        <div className="flex flex-wrap gap-1 max-w-[220px]">
                          {(it.existing_locations || []).map((loc, k) => {
                            const isCurrent = loc.box_id === it.box_id;
                            return (
                              <button key={k} onClick={() => applyExistingLocation(idx, loc)}
                                className={`text-[10px] font-mono px-2 py-0.5 rounded-sm border ${isCurrent ? "bg-blue-50 border-blue-300 text-blue-800" : "bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100"}`}
                                title={`${loc.godown_name}/${loc.rack_no}/${loc.box_no} — ${loc.current_qty} in stock`}
                                data-testid={`rkn-existing-loc-${idx}-${k}`}>
                                <MapPin size={10} weight="bold" className="inline mr-0.5" />
                                {loc.godown_name}/{loc.rack_no}/{loc.box_no} ({loc.current_qty})
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
      {selectedSourceKey && items.length > 0 && (
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
              <Button onClick={save} disabled={saving} className="rounded-sm bg-blue-700 hover:bg-blue-800 px-6" data-testid="rkn-save-button">
                <FloppyDisk size={14} weight="bold" className="mr-2" />
                {saving ? "Saving…" : (isEdit ? "Update Racking Note" : "Save Racking Note")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {!selectedSourceKey && !isEdit && (
        <div className="bg-amber-50 border border-amber-200 rounded-sm p-6 text-sm text-amber-800">
          Pick a racking source (RN / SRN / ERN) above to load its items for racking.
        </div>
      )}
    </div>
  );
}
