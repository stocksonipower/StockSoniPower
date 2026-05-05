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
  Pencil, ArrowsLeftRight, Package, MapPin,
  DownloadSimple, ArrowsClockwise, ArrowsSplit, Checks, Printer,
  CheckCircle,
} from "@phosphor-icons/react";
import { useAuth } from "../lib/auth";
import AssigneeSelect, { AssigneeBadge } from "../components/AssigneeSelect";
import ExcelColumnFilter from "../components/ExcelColumnFilter";
import useExcelTableFilter from "../components/useExcelTableFilter";
import PartNoLink from "../components/PartNoLink";
import { exportToExcel } from "../lib/exportExcel";

const PAGE_SIZE = 100;

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

function strStatusLabel(status) {
  if (status === "FULLY_TRANSFERRED") return "Fully Transferred";
  if (status === "PARTIALLY_TRANSFERRED") return "Partially Transferred";
  if (status === "TRANSFER_NOTE_DRAFT" || status === "PENDING") return "Transfer Note Draft";
  return "Draft";
}

function strStatusCls(status) {
  if (status === "FULLY_TRANSFERRED") return "bg-green-100 text-green-800";
  if (status === "PARTIALLY_TRANSFERRED") return "bg-blue-50 text-blue-800";
  if (status === "TRANSFER_NOTE_DRAFT" || status === "PENDING") return "bg-violet-50 text-violet-800";
  return "bg-amber-50 text-amber-700";
}

/* ==============================================================
   STOCK TRANSFER  (Transfer Request + Transfer Note)
   ============================================================== */
export default function StockTransferPage() {
  const [tab, setTab] = useState("transfer-request");
  return (
    <div className="p-8 max-w-[1600px] mx-auto" data-testid="stock-transfer-page">
      <div className="mb-6">
        <div className="label-sm mb-2">Internal Movement</div>
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
      {view === "list" && (
        <TransferRequestList
          reloadKey={reloadKey}
          onCreate={goCreate}
          onEdit={goEdit}
          onOpen={setOpenStr}
          onFinalized={() => setReloadKey((k) => k + 1)}
        />
      )}
      {(view === "create" || view === "edit") && (
        <TransferRequestForm editing={editing} onCancel={goList} onSaved={goList} onFinalized={goList} />
      )}
      <TransferRequestDetailDialog s={openStr} onClose={() => setOpenStr(null)} />
    </>
  );
}

function TransferRequestList({ reloadKey, onCreate, onEdit, onOpen, onFinalized }) {
  const { user: me, isAdmin } = useAuth();
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [finalizingId, setFinalizingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/transfer-requests", { params: { page, page_size: PAGE_SIZE } });
      setRows(res.data);
      const t = parseInt(res.headers["x-total-count"], 10);
      setTotal(isNaN(t) ? res.data.length : t);
    } finally { setLoading(false); }
  }, [page]);
  useEffect(() => { load(); }, [load, reloadKey]);

  const handleDelete = async (s) => {
    if (!window.confirm(`Delete ${s.str_no}?`)) return;
    try {
      await api.delete(`/transfer-requests/${s.id}`);
      toast.success(`${s.str_no} deleted`);
      load();
    } catch (err) { toast.error(formatApiError(err.response?.data?.detail) || "Could not delete"); }
  };

  const handleFinalize = async (r) => {
    if (!window.confirm(`Finalize ${r.str_no}?\n\nThis will lock the Transfer Request and auto-create a Transfer Note for warehouse processing.`)) return;
    setFinalizingId(r.id);
    try {
      const { data } = await api.post(`/transfer-requests/${r.id}/finalize`);
      toast.success(`${r.str_no} finalized — Transfer Note ${data.stn_no} auto-created. Go to the Transfer Note tab to complete.`);
      onFinalized?.();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not finalize");
    } finally { setFinalizingId(null); }
  };

  const columns = useMemo(() => [
    { key: "str_type", label: "STR TYPE", value: (r) => (r.str_type || "INTRA").toUpperCase() },
    { key: "str_date", label: "STR DATE", value: (r) => fmtDate(r.str_date) },
    { key: "str_no", label: "STR NO", value: (r) => r.str_no || "" },
    { key: "purpose", label: "STR PURPOSE", value: (r) => r.purpose || "" },
    { key: "status", label: "STATUS", value: (r) => strStatusLabel(r.status) },
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
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div className="text-sm text-slate-600"></div>
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
              <th className="text-right">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r, idx) => {
              const isDraft = r.status === "DRAFT";
              const lockedToOther = !!r.assigned_to_user_id && r.assigned_to_user_id !== me?.id && !isAdmin;
              const canEdit = isDraft && !lockedToOther;
              const editTitle = !isDraft ? "Cannot edit — Transfer Request has been finalized"
                : (lockedToOther ? `Locked — assigned to ${r.assigned_to_name || r.assigned_to_email}` : "Edit");
              const deleteTitle = !isDraft ? "Cannot delete — Transfer Request has been finalized"
                : (lockedToOther ? `Locked — assigned to ${r.assigned_to_name || r.assigned_to_email}` : "Delete");
              return (
                <tr key={r.id} data-testid={`str-row-${r.str_no}`}>
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td>
                    {(() => {
                      const t = (r.str_type || "INTRA").toUpperCase();
                      const cls = t === "INTER" ? "bg-purple-50 text-purple-800" : "bg-teal-50 text-teal-800";
                      return <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${cls}`} data-testid={`str-type-${r.str_no}`}>{t === "INTER" ? "Inter Godown" : "Intra Godown"}</span>;
                    })()}
                  </td>
                  <td className="font-mono text-slate-700">{fmtDate(r.str_date)}</td>
                  <td>
                    <button onClick={() => onOpen(r)} className="font-mono font-semibold text-blue-700 hover:underline" data-testid={`str-open-${r.str_no}`}>
                      {r.str_no}
                    </button>
                  </td>
                  <td className="text-slate-700 max-w-[280px] truncate">{r.purpose || "—"}</td>
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${strStatusCls(r.status)}`} data-testid={`str-status-${r.str_no}`}>
                      {strStatusLabel(r.status)}
                    </span>
                  </td>
                  <td className="text-left whitespace-nowrap">
                    <button onClick={() => onEdit(r)} disabled={!canEdit}
                      title={editTitle}
                      className={`p-1.5 rounded-sm mr-1 ${!canEdit ? "text-slate-300 cursor-not-allowed" : "hover:bg-slate-100"}`}
                      data-testid={`str-edit-${r.str_no}`}>
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => handleDelete(r)} disabled={!canEdit}
                      title={deleteTitle}
                      className={`p-1.5 rounded-sm mr-1 ${!canEdit ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                      data-testid={`str-delete-${r.str_no}`}>
                      <Trash size={14} />
                    </button>
                    {isDraft && (
                      <Button
                        onClick={() => handleFinalize(r)}
                        disabled={lockedToOther || finalizingId === r.id}
                        size="sm"
                        title={lockedToOther ? `Locked — assigned to ${r.assigned_to_name || r.assigned_to_email}` : "Finalize & create Transfer Note"}
                        className="rounded-sm h-7 text-xs bg-teal-700 hover:bg-teal-800 text-white"
                        data-testid={`str-finalize-${r.str_no}`}>
                        <Checks size={12} weight="bold" className="mr-1" />
                        {finalizingId === r.id ? "Finalizing…" : "Finalize"}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && (
              <tr><td colSpan={7} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? "No transfer requests. Click 'Create New Transfer Request' to begin." : "No rows match the current filters.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between mt-3 text-xs text-slate-600">
        <div>
          {total === 0 ? "No transfer requests" : (
            <>Showing <span className="font-semibold text-slate-900">{filteredRows.length}</span>{" - "}<span className="font-semibold text-slate-900">{total}</span> total</>
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

function TransferRequestDetailDialog({ s, onClose }) {
  return (
    <Dialog open={!!s} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl rounded-sm" data-testid="str-detail-dialog">
        {s && (
          <>
            <DialogHeader>
              <DialogTitle className="text-2xl font-black font-mono">{s.str_no}</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-4 text-sm border-b border-slate-200 pb-4 mb-4">
              <Detail k="Request Date" v={fmtDate(s.str_date)} />
              <Detail k="Status" v={strStatusLabel(s.status)} />
              <Detail k="STR Type" v={(s.str_type || "INTRA") === "INTER" ? "Inter Godown" : "Intra Godown"} />
              <Detail k="Purpose" v={s.purpose || "—"} />
              <Detail k="Created By" v={s.created_by || "—"} />
              <div className="col-span-2">
                <div className="label-sm">Assigned To</div>
                <div className="mt-1"><AssigneeBadge name={s.assigned_to_name} email={s.assigned_to_email} /></div>
              </div>
            </div>
            <table className="data-table w-full text-xs">
              <thead>
                <tr>
                  <th>SL</th><th>PART NO</th><th>MAKE</th><th>DESCRIPTION</th>
                  <th className="text-right">QTY</th><th>FROM (suggestion)</th><th>TO (suggestion)</th>
                </tr>
              </thead>
              <tbody>
                {(s.items || []).map((it, idx) => (
                  <tr key={idx}>
                    <td className="font-mono text-slate-500">{idx + 1}</td>
                    <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                    <td>{it.make}</td>
                    <td className="text-slate-700 max-w-[260px] truncate">{it.description_1 || "—"}</td>
                    <td className="text-right font-mono font-bold">{it.quantity}</td>
                    <td className="font-mono text-slate-600 text-xs">
                      {it.src_godown_name || it.src_rack_no
                        ? `${it.src_godown_name || "?"}/${it.src_rack_no || "?"}${it.src_box_no ? "/" + it.src_box_no : ""}`
                        : "—"}
                    </td>
                    <td className="font-mono text-slate-600 text-xs">
                      {it.dest_godown_name || it.dest_rack_no
                        ? `${it.dest_godown_name || "?"}/${it.dest_rack_no || "?"}${it.dest_box_no ? "/" + it.dest_box_no : ""}`
                        : "—"}
                    </td>
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

const emptyTransferReqItem = () => ({
  part_no: "", make: "", quantity: "", makes: [], partLooked: false, available_qty: 0,
  model: "", description_1: "", available_locations: [],
  src_godown_id: "", src_godown_name: "", src_rack_id: "", src_rack_no: "",
  src_box_id: "", src_box_no: "", src_box_category: "",
  dest_godown_id: "", dest_godown_name: "",
  dest_rack_id: "", dest_rack_no: "",
  dest_box_id: "", dest_box_no: "", dest_box_category: "",
});

function TransferRequestForm({ editing, onCancel, onSaved, onFinalized }) {
  const isEdit = !!editing;
  const [strNo, setStrNo] = useState("");
  const [strDate, setStrDate] = useState("");
  const [purpose, setPurpose] = useState("");
  const [strType, setStrType] = useState("INTRA");
  const [items, setItems] = useState([emptyTransferReqItem()]);
  const [addCount, setAddCount] = useState("");
  const [saving, setSaving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
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
      setStrType((editing.str_type || "INTRA").toUpperCase());
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
            setItems((prev) => prev.map((r, i) => i === idx ? {
              ...r, makes: makesArr, available_qty: found?.available_qty || 0,
              model: data.model || "", description_1: data.description_1 || "",
              available_locations: found?.available_locations || [],
            } : r));
          })
          .catch(() => {});
        if (row.dest_godown_id) ensureRacks(row.dest_godown_id);
        if (row.dest_rack_id) ensureBoxes(row.dest_rack_id);
      });
    } else {
      api.get("/transfer-requests/next-no").then((r) => { setStrNo(r.data.next_str_no); setStrDate(r.data.str_date); })
        .catch(() => toast.error("Could not preview transfer-request number"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, editing]);

  // Add Rows: input - 1 (one row already exists)
  const addItems = () => {
    const n = Math.max(1, Math.min(499, (parseInt(addCount, 10) || 2) - 1));
    setItems((p) => [...p, ...Array.from({ length: n }, emptyTransferReqItem)]);
    setAddCount("");
  };
  const removeItem = (i) => setItems((p) => (p.length === 1 ? p : p.filter((_, idx) => idx !== i)));
  const updateItem = (i, patch) => setItems((p) => p.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  const lookupMakes = async (i, partNo) => {
    const v = (partNo || "").trim();
    if (!v) {
      updateItem(i, { makes: [], make: "", partLooked: false, available_qty: 0, model: "", description_1: "", available_locations: [] });
      return;
    }
    try {
      const { data } = await api.get(`/transfer-requests/lookup/${encodeURIComponent(v)}`);
      const list = data.makes || [];
      const auto = list.length === 1 ? list[0] : null;
      updateItem(i, {
        makes: list, partLooked: true,
        model: data.model || "", description_1: data.description_1 || "",
        make: auto ? auto.make : "",
        available_qty: auto ? auto.available_qty : 0,
        available_locations: auto ? (auto.available_locations || []) : [],
        src_godown_id: "", src_godown_name: "", src_rack_id: "", src_rack_no: "",
        src_box_id: "", src_box_no: "", src_box_category: "",
      });
    } catch {
      updateItem(i, { makes: [], partLooked: true, make: "", available_qty: 0, model: "", description_1: "", available_locations: [] });
    }
  };

  const onMakeChange = (i, makeVal) => {
    const row = items[i];
    const found = (row.makes || []).find((m) => m.make === makeVal);
    updateItem(i, {
      make: makeVal, available_qty: found?.available_qty || 0,
      available_locations: found?.available_locations || [],
      src_godown_id: "", src_godown_name: "", src_rack_id: "", src_rack_no: "",
      src_box_id: "", src_box_no: "", src_box_category: "",
    });
  };

  const onSrcLocChange = (i, locKey) => {
    if (!locKey || locKey === "__none__") {
      updateItem(i, { src_godown_id: "", src_godown_name: "", src_rack_id: "", src_rack_no: "", src_box_id: "", src_box_no: "", src_box_category: "" });
      return;
    }
    const loc = (items[i].available_locations || []).find((l) => `${l.godown_id}|${l.rack_id}|${l.box_id || ""}` === locKey);
    if (loc) updateItem(i, {
      src_godown_id: loc.godown_id, src_godown_name: loc.godown_name,
      src_rack_id: loc.rack_id, src_rack_no: loc.rack_no,
      src_box_id: loc.box_id || "", src_box_no: loc.box_no || "", src_box_category: loc.box_category || "",
    });
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
      m[k] = (m[k] || 0) + (parseFloat(r.quantity) || 0);
    });
    return m;
  }, [items]);

  const validateItems = () => {
    if (!purpose) { toast.error("Purpose is required"); return false; }
    if (items.length === 0) { toast.error("Add at least one item"); return false; }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.part_no.trim()) { toast.error(`Row ${i + 1}: Part No required`); return false; }
      if (!it.make.trim()) { toast.error(`Row ${i + 1}: Make required`); return false; }
      const q = parseFloat(it.quantity);
      if (isNaN(q) || q <= 0) { toast.error(`Row ${i + 1}: Quantity > 0`); return false; }
      if (q > (it.available_qty || 0) + 1e-6) {
        toast.error(`Row ${i + 1}: ${it.part_no}/${it.make} — only ${it.available_qty} in stock`);
        return false;
      }
    }
    for (const [k, total] of Object.entries(requestedByKey)) {
      const [p, m] = k.split("||");
      const row = items.find((r) => r.part_no === p && r.make === m);
      const avail = row?.available_qty || 0;
      if (total > avail + 1e-6) {
        toast.error(`${p}/${m}: total requested across rows is ${total} but only ${avail} in stock`);
        return false;
      }
    }
    return true;
  };

  const buildPayload = () => ({
    purpose: purpose.trim(),
    str_type: strType,
    assigned_to_user_id: assignedToUserId || null,
    items: items.map((it) => ({
      part_no: it.part_no.trim(), make: it.make.trim(), quantity: parseFloat(it.quantity),
      src_godown_id: it.src_godown_id || "", src_godown_name: it.src_godown_name || "",
      src_rack_id: it.src_rack_id || "", src_rack_no: it.src_rack_no || "",
      src_box_id: it.src_box_id || "", src_box_no: it.src_box_no || "", src_box_category: it.src_box_category || "",
      dest_godown_id: it.dest_godown_id || "", dest_godown_name: it.dest_godown_name || "",
      dest_rack_id: it.dest_rack_id || "", dest_rack_no: it.dest_rack_no || "",
      dest_box_id: it.dest_box_id || "", dest_box_no: it.dest_box_no || "", dest_box_category: it.dest_box_category || "",
    })),
  });

  const save = async () => {
    if (!validateItems()) return;
    setSaving(true);
    try {
      const { data } = isEdit
        ? await api.put(`/transfer-requests/${editing.id}`, buildPayload())
        : await api.post("/transfer-requests", buildPayload());
      toast.success(`Transfer Request ${data.str_no} ${isEdit ? "updated" : "saved"}`);
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save");
    } finally { setSaving(false); }
  };

  const saveAndFinalize = async () => {
    if (!validateItems()) return;
    setFinalizing(true);
    try {
      let strId = editing?.id;
      if (isEdit) {
        const { data } = await api.put(`/transfer-requests/${editing.id}`, buildPayload());
        strId = data.id;
      } else {
        const { data } = await api.post("/transfer-requests", buildPayload());
        strId = data.id;
      }
      const { data: fin } = await api.post(`/transfer-requests/${strId}/finalize`);
      toast.success(`${fin.str_no} finalized — Transfer Note ${fin.stn_no} auto-created. Go to Transfer Note tab to complete.`);
      onFinalized?.();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not finalize");
    } finally { setFinalizing(false); }
  };

  return (
    <div className="mt-4 space-y-6" data-testid="str-create-view">
      <div className="flex items-center justify-between">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="str-back-button">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
        <div className="flex items-center gap-2">
          <Button onClick={save} disabled={saving || finalizing} variant="outline" className="rounded-sm border-slate-300" data-testid="str-save-button">
            <FloppyDisk size={14} weight="bold" className="mr-2" /> {saving ? "Saving…" : "Save as Draft"}
          </Button>
          <Button onClick={saveAndFinalize} disabled={saving || finalizing} className="rounded-sm bg-teal-700 hover:bg-teal-800" data-testid="str-finalize-button">
            <Checks size={14} weight="bold" className="mr-2" /> {finalizing ? "Finalizing…" : "Finalize & Create Transfer Note"}
          </Button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm p-6 grid grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <Label className="label-sm">STR Date</Label>
          <Input value={strDate} disabled className="mt-2 rounded-sm font-mono bg-slate-50" data-testid="str-date-input" />
        </div>
        <div>
          <Label className="label-sm">STR No</Label>
          <Input value={strNo} disabled className="mt-2 rounded-sm font-mono font-semibold bg-blue-50 text-blue-900" data-testid="str-no-input" />
        </div>
        <div>
          <Label className="label-sm">STR Purpose *</Label>
          <Select value={purpose || undefined} onValueChange={setPurpose}>
            <SelectTrigger className="mt-2 rounded-sm" data-testid="str-purpose-input">
              <SelectValue placeholder="Select purpose" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PENDING ORDER">PENDING ORDER</SelectItem>
              <SelectItem value="PURCHASE RETURN">PURCHASE RETURN</SelectItem>
              <SelectItem value="RELOCATION">RELOCATION</SelectItem>
              <SelectItem value="REPLENISHMENT">REPLENISHMENT</SelectItem>
              <SelectItem value="SALE">SALE</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="col-span-2 lg:col-span-3 flex items-center gap-6 flex-wrap">
          <Label className="label-sm">STR Type</Label>
          <label className="flex items-center gap-2 cursor-pointer" data-testid="str-type-inter">
            <input type="radio" name="str-type" value="INTER"
              checked={strType === "INTER"} onChange={() => setStrType("INTER")}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setStrType("INTER"); } }}
              className="accent-blue-700" />
            <span className="text-sm font-semibold text-slate-700">
              <ArrowsLeftRight size={14} weight="bold" className="inline mr-1" /> Inter Godown
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer" data-testid="str-type-intra">
            <input type="radio" name="str-type" value="INTRA"
              checked={strType === "INTRA"} onChange={() => setStrType("INTRA")}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setStrType("INTRA"); } }}
              className="accent-blue-700" />
            <span className="text-sm font-semibold text-slate-700">
              <MapPin size={14} weight="bold" className="inline mr-1" /> Intra Godown
            </span>
          </label>
        </div>
        <div className="col-span-2">
          <AssigneeSelect value={assignedToUserId} onChange={setAssignedToUserId} module="stock_transfer" testid="str-assignee" />
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm">
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <div>
            <div className="label-sm">Items to Transfer</div>
            <div className="text-xs text-slate-500 mt-0.5">{items.length} row{items.length !== 1 ? "s" : ""} · FROM / TO locations are optional suggestions (Transfer Note can modify)</div>
          </div>
          <div className="flex items-center gap-2">
            <Input type="number" min="2" max="500" value={addCount} onChange={(e) => setAddCount(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addItems(); } }}
              placeholder="Count" className="rounded-sm font-mono h-9 w-24 text-center" data-testid="str-add-row-count" />
            <Button onClick={addItems} variant="outline" className="rounded-sm" data-testid="str-add-row-button">
              <Plus size={14} weight="bold" className="mr-1" />
              {addCount && parseInt(addCount, 10) > 1 ? `Add ${parseInt(addCount, 10) - 1} Row${parseInt(addCount, 10) - 1 > 1 ? "s" : ""}` : "Add Row"}
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="w-10">SL</th>
                <th>MODEL</th>
                <th>PART NO</th>
                <th>DESCRIPTION 1</th>
                <th>MAKE</th>
                <th>FROM GODOWN (suggestion)</th>
                <th>QTY</th>
                <th>TO GODOWN (suggestion)</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => {
                const overStock = it.available_qty !== undefined && (parseFloat(it.quantity) || 0) > (it.available_qty || 0) + 1e-6;
                const destRacks = racksByGodown[it.dest_godown_id] || [];
                const destBoxes = boxesByRack[it.dest_rack_id] || [];
                const srcKey = it.src_godown_id ? `${it.src_godown_id}|${it.src_rack_id}|${it.src_box_id || ""}` : undefined;
                const hasSrcLocs = it.make && (it.available_locations || []).length > 0;
                return (
                  <tr key={idx} data-testid={`str-item-row-${idx}`} className={overStock ? "bg-red-50 align-top" : "align-top"}>
                    <td className="font-mono text-slate-500 pt-2">{idx + 1}</td>
                    <td className="pt-2">
                      <Input value={it.model || ""} disabled
                        className="rounded-sm font-mono h-8 bg-slate-50 text-slate-600 w-28" placeholder="—"
                        data-testid={`str-model-${idx}`} />
                    </td>
                    <td className="pt-2">
                      <Input value={it.part_no}
                        onChange={(e) => updateItem(idx, { part_no: e.target.value, partLooked: false, makes: [], make: "", available_qty: 0, model: "", description_1: "", available_locations: [] })}
                        onBlur={(e) => lookupMakes(idx, e.target.value)}
                        placeholder="Enter part no" className="rounded-sm font-mono h-8 w-32" data-testid={`str-part-no-${idx}`} />
                    </td>
                    <td className="pt-2 max-w-[200px]">
                      <Input value={it.description_1 || ""} disabled
                        className="rounded-sm h-8 bg-slate-50 text-slate-600 text-xs" placeholder="—"
                        data-testid={`str-desc1-${idx}`} />
                    </td>
                    <td className="pt-2 w-44">
                      <Select disabled={!it.partLooked || it.makes.length === 0}
                        value={it.make || undefined} onValueChange={(v) => onMakeChange(idx, v)}>
                        <SelectTrigger className="rounded-sm h-8" data-testid={`str-make-${idx}`}>
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
                    <td className="pt-2 w-48">
                      <Select disabled={!hasSrcLocs} value={srcKey || undefined} onValueChange={(v) => onSrcLocChange(idx, v)}>
                        <SelectTrigger className="rounded-sm h-8 text-xs" data-testid={`str-src-loc-${idx}`}>
                          <SelectValue placeholder={!it.make ? "—" : (hasSrcLocs ? "Optional" : "No stock")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__" className="text-slate-400 italic">— Clear</SelectItem>
                          {(it.available_locations || []).map((l) => {
                            const key = `${l.godown_id}|${l.rack_id}|${l.box_id || ""}`;
                            const label = `${l.godown_name} / ${l.rack_no}${l.box_no ? " / " + l.box_no : ""} (${l.current_qty})`;
                            return <SelectItem key={key} value={key} className="font-mono text-xs">{label}</SelectItem>;
                          })}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="pt-2 w-28">
                      <Input type="number" min="0.001" step="any" value={it.quantity} disabled={!it.make}
                        onChange={(e) => updateItem(idx, { quantity: e.target.value })}
                        placeholder="0" className={`rounded-sm font-mono h-8 text-right ${overStock ? "border-red-400" : ""}`}
                        data-testid={`str-qty-${idx}`} />
                      {it.make && (
                        <div className={`text-[10px] mt-0.5 ${overStock ? "text-red-600 font-bold" : "text-slate-500"}`} data-testid={`str-avail-hint-${idx}`}>
                          {overStock ? `Over ${it.quantity}/${it.available_qty}` : `Avail ${it.available_qty}`}
                        </div>
                      )}
                    </td>
                    <td className="pt-2 w-40 space-y-1">
                      <Select value={it.dest_godown_id || undefined} onValueChange={(v) => onDestGodownChange(idx, v)}>
                        <SelectTrigger className="rounded-sm h-7 text-xs" data-testid={`str-dest-godown-${idx}`}>
                          <SelectValue placeholder="Godown" />
                        </SelectTrigger>
                        <SelectContent>
                          {godowns.map((g) => <SelectItem key={g.id} value={g.id}>{g.godown_name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Select disabled={!it.dest_godown_id} value={it.dest_rack_id || undefined} onValueChange={(v) => onDestRackChange(idx, v)}>
                        <SelectTrigger className="rounded-sm h-7 text-xs" data-testid={`str-dest-rack-${idx}`}>
                          <SelectValue placeholder="Rack" />
                        </SelectTrigger>
                        <SelectContent>
                          {destRacks.map((r) => <SelectItem key={r.id} value={r.id} className="font-mono">{r.rack_no}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Select disabled={!it.dest_rack_id || destBoxes.length === 0} value={it.dest_box_id || undefined} onValueChange={(v) => onDestBoxChange(idx, v)}>
                        <SelectTrigger className="rounded-sm h-7 text-xs" data-testid={`str-dest-box-${idx}`}>
                          <SelectValue placeholder={destBoxes.length === 0 ? "—" : "Box"} />
                        </SelectTrigger>
                        <SelectContent>
                          {destBoxes.map((b) => <SelectItem key={b.id} value={b.id} className="font-mono">{b.box_no}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="pt-2">
                      <button onClick={() => removeItem(idx)} disabled={items.length === 1}
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
      {view === "list" && <TransferNoteList reloadKey={reloadKey} onEdit={goEdit} onOpen={setOpenStn} />}
      {view === "edit" && editing && <TransferNoteForm editing={editing} onCancel={goList} onSaved={goList} />}
      <TransferNoteDetailDialog stn={openStn} onClose={() => setOpenStn(null)} />
    </>
  );
}

function TransferNoteList({ reloadKey, onEdit, onOpen }) {
  const { user: me, isAdmin } = useAuth();
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/transfer-notes", { params: { page, page_size: PAGE_SIZE } });
      setRows(res.data);
      const t = parseInt(res.headers["x-total-count"], 10);
      setTotal(isNaN(t) ? res.data.length : t);
    } finally { setLoading(false); }
  }, [page]);
  useEffect(() => { load(); }, [load, reloadKey]);

  const handleDelete = async (stn) => {
    if (!window.confirm(`Delete ${stn.stn_no}?`)) return;
    try { await api.delete(`/transfer-notes/${stn.id}`); toast.success(`${stn.stn_no} deleted`); load(); }
    catch (err) { toast.error(formatApiError(err.response?.data?.detail) || "Could not delete"); }
  };

  const columns = useMemo(() => [
    { key: "stn_date", label: "STN DATE", value: (r) => fmtDate(r.stn_date) },
    { key: "stn_no", label: "STN NO", value: (r) => r.stn_no || "" },
    { key: "str_no", label: "REQUEST NO", value: (r) => r.transfer_request_no || "" },
    { key: "items_count", label: "ITEMS", value: (r) => (r.items || []).length },
    { key: "qty_total", label: "QTY", value: (r) => (r.items || []).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0) },
    { key: "status", label: "STATUS", value: (r) => r.status === "RECORDED" ? "Recorded" : "Draft" },
  ], []);
  const {
    filteredRows, uniqueValues, colFilters, setColFilter, sort, setColumnSort,
  } = useExcelTableFilter(rows, columns);

  const handleExport = () => {
    if (filteredRows.length === 0) { toast.error("No rows to export"); return; }
    const exportCols = [{ label: "Sl No", value: (r) => filteredRows.indexOf(r) + 1 }, ...columns];
    exportToExcel(filteredRows, exportCols, `Transfer_Notes_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="mt-4" data-testid="stn-list-view">
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div className="text-xs text-slate-500">Transfer Notes are auto-created when a Transfer Request is finalized.</div>
        <div className="flex items-center gap-2">
          <Button onClick={handleExport} variant="outline" className="rounded-sm border-slate-300" data-testid="stn-export-button">
            <DownloadSimple size={14} weight="bold" className="mr-2" /> Export
          </Button>
          <Button onClick={load} variant="outline" className="rounded-sm border-slate-300" disabled={loading} data-testid="stn-refresh-button">
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
              <th className="text-right">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r, idx) => {
              const totalQty = (r.items || []).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0);
              const recorded = r.status === "RECORDED";
              const aId = r.parent_assigned_to_user_id;
              const aName = r.parent_assigned_to_name;
              const aEmail = r.parent_assigned_to_email;
              const lockedToOther = !!aId && aId !== me?.id && !isAdmin;
              const canEdit = !recorded && !lockedToOther;
              return (
                <tr key={r.id} data-testid={`stn-row-${r.stn_no}`}>
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td className="font-mono text-slate-700">{fmtDate(r.stn_date)}</td>
                  <td>
                    <button onClick={() => onOpen(r)} className="font-mono font-semibold text-blue-700 hover:underline" data-testid={`stn-open-${r.stn_no}`}>{r.stn_no}</button>
                  </td>
                  <td className="font-mono text-slate-700">{r.transfer_request_no || "—"}</td>
                  <td className="font-mono text-slate-600">{(r.items || []).length}</td>
                  <td className="font-mono font-bold text-slate-900">{totalQty}</td>
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${recorded ? "bg-green-100 text-green-800" : "bg-amber-50 text-amber-700"}`} data-testid={`stn-status-${r.stn_no}`}>
                      {recorded ? "Recorded" : "Draft"}
                    </span>
                  </td>
                  <td className="text-left whitespace-nowrap">
                    {canEdit ? (
                      <Button onClick={() => onEdit(r)} size="sm"
                        title={lockedToOther ? `Locked — assigned to ${aName || aEmail}` : "Edit Transfer Note"}
                        className="rounded-sm h-7 text-xs bg-blue-700 hover:bg-blue-800 text-white mr-1"
                        data-testid={`stn-edit-${r.stn_no}`}>
                        <Pencil size={12} weight="bold" className="mr-1" /> Edit
                      </Button>
                    ) : (
                      <Button onClick={() => onOpen(r)} size="sm" variant="outline"
                        className="rounded-sm h-7 text-xs border-slate-300 mr-1"
                        data-testid={`stn-view-${r.stn_no}`}>
                        View
                      </Button>
                    )}
                    <button onClick={() => handleDelete(r)}
                      disabled={!canEdit}
                      title={recorded ? "Already recorded" : (lockedToOther ? `Locked — assigned to ${aName || aEmail}` : "Delete")}
                      className={`p-1.5 rounded-sm ${!canEdit ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                      data-testid={`stn-delete-${r.stn_no}`}>
                      <Trash size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && (
              <tr><td colSpan={8} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? "No transfer notes. Finalize a Transfer Request to auto-create one." : "No rows match the current filters.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between mt-3 text-xs text-slate-600">
        <div>
          {total === 0 ? "No transfer notes" : (
            <>Showing <span className="font-semibold text-slate-900">{filteredRows.length}</span>{" - "}<span className="font-semibold text-slate-900">{total}</span> total</>
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

function TransferNoteDetailDialog({ stn, onClose }) {
  return (
    <Dialog open={!!stn} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-7xl rounded-sm" data-testid="stn-detail-dialog">
        {stn && (
          <>
            <DialogHeader>
              <div className="flex items-center justify-between">
                <DialogTitle className="text-2xl font-black font-mono">{stn.stn_no}</DialogTitle>
                <Button onClick={() => window.print()} variant="outline" size="sm" className="rounded-sm border-slate-300 mr-6">
                  <Printer size={13} weight="bold" className="mr-1.5" /> Print
                </Button>
              </div>
            </DialogHeader>
            <div className="grid grid-cols-3 gap-4 text-sm border-b border-slate-200 pb-4 mb-4">
              <Detail k="STN Date" v={fmtDate(stn.stn_date)} />
              <Detail k="Request No" v={stn.transfer_request_no || "—"} />
              <Detail k="Status" v={stn.status === "RECORDED" ? "Recorded" : "Draft"} />
              <Detail k="Created By" v={stn.created_by || "—"} />
              <Detail k="Created At" v={new Date(stn.created_at).toLocaleString()} />
              <div>
                <div className="label-sm">Assigned To (from Request)</div>
                <div className="mt-1"><AssigneeBadge name={stn.parent_assigned_to_name} email={stn.parent_assigned_to_email} /></div>
              </div>
              {stn.narration && (
                <div className="col-span-3">
                  <div className="label-sm">Narration</div>
                  <div className="mt-1 text-slate-700 text-sm">{stn.narration}</div>
                </div>
              )}
            </div>
            <table className="data-table w-full text-xs">
              <thead>
                <tr>
                  <th>SL</th><th>PART NO</th><th>MAKE</th><th className="text-right">QTY</th>
                  <th>SOURCE GODOWN</th><th>SOURCE RACK</th><th>SOURCE BOX</th>
                  <th>DEST GODOWN</th><th>DEST RACK</th><th>DEST BOX</th>
                </tr>
              </thead>
              <tbody>
                {(stn.items || []).map((it, idx) => (
                  <tr key={idx}>
                    <td className="font-mono text-slate-500">{idx + 1}</td>
                    <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                    <td>{it.make}</td>
                    <td className="text-right font-mono font-bold">{it.quantity}</td>
                    <td className="font-mono">{it.src_godown_name || "—"}</td>
                    <td className="font-mono">{it.src_rack_no || "—"}</td>
                    <td className="font-mono">{it.src_box_no || "—"}</td>
                    <td className="font-mono">{it.dest_godown_name || "—"}</td>
                    <td className="font-mono">{it.dest_rack_no || "—"}</td>
                    <td className="font-mono">{it.dest_box_no || "—"}</td>
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

/* =========================== TRANSFER NOTE FORM =========================== */
function TransferNoteForm({ editing, onCancel, onSaved }) {
  const [items, setItems] = useState([]);
  const [narration, setNarration] = useState("");
  const [saving, setSaving] = useState(false);

  // Pending / requested qty per "part_no||make" key — fetched from prepare endpoint
  const [pendingByKey, setPendingByKey] = useState({});
  const [requestedByKey, setRequestedByKey] = useState({});

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

  // Preload racks/boxes for any items with pre-filled locations
  useEffect(() => {
    items.forEach((it) => {
      if (it.src_godown_id) ensureRacks(it.src_godown_id);
      if (it.src_rack_id) ensureBoxes(it.src_rack_id);
      if (it.dest_godown_id) ensureRacks(it.dest_godown_id);
      if (it.dest_rack_id) ensureBoxes(it.dest_rack_id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  useEffect(() => {
    if (!editing) return;
    setNarration(editing.narration || "");
    const strId = editing.transfer_request_id;

    api.get(`/transfer-notes/prepare/${strId}`, { params: { exclude_stn_id: editing.id } })
      .then((r) => {
        const prepareMap = {};
        (r.data.items || []).forEach((p) => {
          prepareMap[`${p.part_no}||${p.make}`] = p;
        });
        const pendMap = {};
        const reqMap = {};
        Object.entries(prepareMap).forEach(([k, p]) => {
          pendMap[k] = p.pending_qty ?? 0;
          reqMap[k] = p.requested_qty ?? 0;
        });
        setPendingByKey(pendMap);
        setRequestedByKey(reqMap);

        setItems((editing.items || []).map((it) => {
          const p = prepareMap[`${it.part_no}||${it.make}`] || {};
          return {
            ...it,
            quantity: it.quantity ?? 0,
            available_locations: p.available_locations || [],
            pending_qty: p.pending_qty ?? 0,
            requested_qty: p.requested_qty ?? 0,
          };
        }));
      })
      .catch(() => {
        setItems((editing.items || []).map((it) => ({
          ...it, quantity: it.quantity ?? 0,
          available_locations: [], pending_qty: 0, requested_qty: 0,
        })));
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  const updateItem = (i, patch) => setItems((prev) => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  // Insert a copy of row i after it (same part/make, empty locations, qty=0)
  const splitRow = (i) => {
    setItems((prev) => {
      const src = prev[i];
      const copy = {
        ...src,
        quantity: 0,
        src_godown_id: "", src_godown_name: "",
        src_rack_id: "", src_rack_no: "",
        src_box_id: "", src_box_no: "", src_box_category: "",
        dest_godown_id: "", dest_godown_name: "",
        dest_rack_id: "", dest_rack_no: "",
        dest_box_id: "", dest_box_no: "", dest_box_category: "",
      };
      const out = [...prev];
      out.splice(i + 1, 0, copy);
      return out;
    });
  };

  const removeRow = (i) => setItems((prev) => prev.filter((_, idx) => idx !== i));

  // Count rows per part||make key — to determine if delete should be disabled
  const countByKey = useMemo(() => {
    const map = {};
    items.forEach((r) => {
      const k = `${r.part_no}||${r.make}`;
      map[k] = (map[k] || 0) + 1;
    });
    return map;
  }, [items]);

  // Total allocated qty per part||make across all rows
  const allocByKey = useMemo(() => {
    const map = {};
    items.forEach((r) => {
      const k = `${r.part_no}||${r.make}`;
      map[k] = (map[k] || 0) + (parseFloat(r.quantity) || 0);
    });
    return map;
  }, [items]);

  const onLocChange = async (i, side, kind, value) => {
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
      src_box_id: loc.box_id || "", src_box_no: loc.box_no || "",
      src_box_category: loc.box_category || "",
    });
  };

  const buildPayload = () => ({
    transfer_request_id: editing.transfer_request_id,
    narration: narration.trim(),
    items: items.map((it) => ({
      part_no: it.part_no, make: it.make,
      quantity: parseFloat(it.quantity) || 0,
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
  });

  const saveAsDraft = async () => {
    setSaving(true);
    try {
      const { data } = await api.put(`/transfer-notes/${editing.id}`, buildPayload());
      toast.success(`${data.stn_no} draft saved`);
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save");
    } finally { setSaving(false); }
  };

  const saveFinal = async () => {
    setSaving(true);
    try {
      await api.put(`/transfer-notes/${editing.id}`, buildPayload());
      const res = await api.post(`/transfer-notes/${editing.id}/record`);
      const recData = res.data || {};
      const autoStn = res.headers?.["x-auto-stn-no"] || recData.auto_stn_no;
      if (autoStn) {
        toast.success(`Recorded · ${recData.transactions_created} transaction(s) · ${autoStn} auto-created for remaining qty`);
      } else {
        toast.success(`Recorded · ${recData.transactions_created} transaction(s)`);
      }
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not record");
    } finally { setSaving(false); }
  };

  const stnNo = editing?.stn_no || "";
  const stnDate = editing?.stn_date || "";
  const strNo = editing?.transfer_request_no || "";
  const strDate = editing?.transfer_request_date || "";

  return (
    <div className="mt-4 space-y-6" data-testid="stn-edit-view">
      {/* Top action bar */}
      <div className="flex items-center justify-between">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="stn-back-button">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
        <div className="flex items-center gap-2">
          <Button onClick={saveAsDraft} disabled={saving} variant="outline" className="rounded-sm border-slate-300" data-testid="stn-save-draft-button">
            <FloppyDisk size={14} weight="bold" className="mr-2" /> {saving ? "Saving…" : "Save as Draft"}
          </Button>
          <Button onClick={saveFinal} disabled={saving} className="rounded-sm bg-emerald-700 hover:bg-emerald-800" data-testid="stn-save-final-button">
            <CheckCircle size={14} weight="bold" className="mr-2" /> {saving ? "Saving…" : "Save Final"}
          </Button>
        </div>
      </div>

      {/* STN + STR info header */}
      <div className="bg-white border border-slate-200 rounded-sm p-5 grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
        <div>
          <div className="label-sm">STN Date</div>
          <div className="font-mono mt-1 text-slate-900">{fmtDate(stnDate)}</div>
        </div>
        <div>
          <div className="label-sm">STN No</div>
          <div className="font-mono font-bold mt-1 text-blue-900 text-base">{stnNo}</div>
        </div>
        <div>
          <div className="label-sm">Linked Transfer Request</div>
          <div className="font-mono font-semibold mt-1 text-slate-800">
            {strNo} <span className="text-slate-400 font-normal text-xs">({fmtDate(strDate)})</span>
          </div>
        </div>
        <div className="flex items-end">
          <Button onClick={() => window.print()} variant="outline" size="sm" className="rounded-sm border-slate-300">
            <Printer size={13} weight="bold" className="mr-1.5" /> Print STN
          </Button>
        </div>
      </div>

      {/* Items table */}
      <div className="bg-white border border-slate-200 rounded-sm">
        <div className="p-4 border-b border-slate-200 flex items-center gap-2 flex-wrap">
          <Package size={16} weight="bold" className="text-slate-500" />
          <div className="label-sm">Items to Transfer</div>
          <span className="text-xs text-slate-500">({items.length} rows) · Use <span className="font-semibold">+</span> or <span className="font-semibold">Split</span> to add multiple source rows per item. Same src = dest is allowed.</span>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table w-full text-xs">
            <thead>
              <tr>
                <th className="w-10">SL</th>
                <th>PART / MAKE</th>
                <th className="text-right w-36">REQ · PEND / QTY</th>
                <th>FROM (source)</th>
                <th>TO (destination)</th>
                <th className="w-20 text-center">ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => {
                const k = `${it.part_no}||${it.make}`;
                const pendingForKey = pendingByKey[k] ?? it.pending_qty ?? 0;
                const reqForKey = requestedByKey[k] ?? it.requested_qty ?? 0;
                const allocated = allocByKey[k] ?? 0;
                const overAllocated = allocated > pendingForKey + 1e-6;
                const canDelete = (countByKey[k] || 1) > 1;

                const srcRacks = racksByGodown[it.src_godown_id] || [];
                const srcBoxes = boxesByRack[it.src_rack_id] || [];
                const destRacks = racksByGodown[it.dest_godown_id] || [];
                const destBoxes = boxesByRack[it.dest_rack_id] || [];

                return (
                  <tr key={idx} data-testid={`stn-item-row-${idx}`} className={overAllocated ? "bg-red-50 align-top" : "align-top"}>
                    {/* SL */}
                    <td className="font-mono text-slate-400 pt-3 text-center">{idx + 1}</td>

                    {/* Part / Make / Description */}
                    <td className="pt-3 min-w-[160px]">
                      <div className="font-mono font-semibold text-slate-900 text-xs">
                        <PartNoLink partNo={it.part_no} make={it.make} />
                      </div>
                      <div className="text-slate-500 text-[11px]">{it.make}</div>
                      {it.description_1 && (
                        <div className="text-[10px] text-slate-400 mt-0.5 max-w-[220px] truncate">{it.description_1}</div>
                      )}
                    </td>

                    {/* Qty with req/pend context */}
                    <td className="pt-3 text-right pr-2">
                      <div className="text-[10px] text-slate-500 mb-1">
                        req <b className="text-slate-700">{reqForKey}</b> · pend <b className="text-slate-700">{pendingForKey}</b>
                      </div>
                      <Input
                        type="number" min="0" step="any"
                        value={it.quantity}
                        onChange={(e) => updateItem(idx, { quantity: e.target.value })}
                        className={`rounded-sm font-mono h-8 text-right w-24 ml-auto ${overAllocated ? "border-red-400" : ""}`}
                        data-testid={`stn-qty-${idx}`}
                      />
                      <div className={`text-[10px] mt-0.5 text-right ${overAllocated ? "text-red-600 font-bold" : "text-slate-500"}`}>
                        {overAllocated
                          ? `over ${allocated}/${pendingForKey}`
                          : `alloc ${allocated} / pend ${pendingForKey}`}
                      </div>
                    </td>

                    {/* FROM (source) with chips */}
                    <td className="space-y-1 pt-2 min-w-[180px]">
                      <div className="text-[10px] text-slate-400 uppercase font-bold tracking-wider">
                        <MapPin size={9} weight="bold" className="inline mr-0.5" /> From
                      </div>
                      <Select value={it.src_godown_id || undefined} onValueChange={(v) => onLocChange(idx, "src", "godown", v)}>
                        <SelectTrigger className="rounded-sm h-7 text-xs" data-testid={`stn-src-godown-${idx}`}>
                          <SelectValue placeholder="Godown" />
                        </SelectTrigger>
                        <SelectContent>{godowns.map((g) => <SelectItem key={g.id} value={g.id}>{g.godown_name}</SelectItem>)}</SelectContent>
                      </Select>
                      <Select disabled={!it.src_godown_id} value={it.src_rack_id || undefined} onValueChange={(v) => onLocChange(idx, "src", "rack", v)}>
                        <SelectTrigger className="rounded-sm h-7 text-xs" data-testid={`stn-src-rack-${idx}`}>
                          <SelectValue placeholder="Rack" />
                        </SelectTrigger>
                        <SelectContent>{srcRacks.map((r) => <SelectItem key={r.id} value={r.id} className="font-mono">{r.rack_no}</SelectItem>)}</SelectContent>
                      </Select>
                      <Select disabled={!it.src_rack_id || srcBoxes.length === 0} value={it.src_box_id || undefined} onValueChange={(v) => onLocChange(idx, "src", "box", v)}>
                        <SelectTrigger className="rounded-sm h-7 text-xs" data-testid={`stn-src-box-${idx}`}>
                          <SelectValue placeholder={srcBoxes.length === 0 ? "—" : "Box"} />
                        </SelectTrigger>
                        <SelectContent>{srcBoxes.map((b) => <SelectItem key={b.id} value={b.id} className="font-mono">{b.box_no}</SelectItem>)}</SelectContent>
                      </Select>
                      {/* Available location chips */}
                      {(it.available_locations || []).filter((L) => (L.available_qty ?? L.current_qty ?? 0) > 0).length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-0.5">
                          {(it.available_locations || []).filter((L) => (L.available_qty ?? L.current_qty ?? 0) > 0).slice(0, 4).map((L, li) => {
                            const isCurrent = L.godown_id === it.src_godown_id && L.rack_id === it.src_rack_id && (L.box_id || "") === (it.src_box_id || "");
                            return (
                              <button key={li} type="button" onClick={() => applySrcChip(idx, L)}
                                className={`text-[10px] px-1.5 py-0.5 rounded-sm border font-mono text-left leading-tight ${isCurrent ? "bg-blue-50 border-blue-300 text-blue-800" : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"}`}
                                title={`Click to use — avail ${L.available_qty ?? L.current_qty}`}
                                data-testid={`stn-src-chip-${idx}-${li}`}>
                                {L.godown_name}/{L.rack_no}{L.box_no ? "/" + L.box_no : ""} ({L.available_qty ?? L.current_qty})
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </td>

                    {/* TO (destination) */}
                    <td className="space-y-1 pt-2 min-w-[180px]">
                      <div className="text-[10px] text-slate-400 uppercase font-bold tracking-wider">
                        <MapPin size={9} weight="bold" className="inline mr-0.5" /> To
                      </div>
                      <Select value={it.dest_godown_id || undefined} onValueChange={(v) => onLocChange(idx, "dest", "godown", v)}>
                        <SelectTrigger className="rounded-sm h-7 text-xs" data-testid={`stn-dest-godown-${idx}`}>
                          <SelectValue placeholder="Godown" />
                        </SelectTrigger>
                        <SelectContent>{godowns.map((g) => <SelectItem key={g.id} value={g.id}>{g.godown_name}</SelectItem>)}</SelectContent>
                      </Select>
                      <Select disabled={!it.dest_godown_id} value={it.dest_rack_id || undefined} onValueChange={(v) => onLocChange(idx, "dest", "rack", v)}>
                        <SelectTrigger className="rounded-sm h-7 text-xs" data-testid={`stn-dest-rack-${idx}`}>
                          <SelectValue placeholder="Rack" />
                        </SelectTrigger>
                        <SelectContent>{destRacks.map((r) => <SelectItem key={r.id} value={r.id} className="font-mono">{r.rack_no}</SelectItem>)}</SelectContent>
                      </Select>
                      <Select disabled={!it.dest_rack_id || destBoxes.length === 0} value={it.dest_box_id || undefined} onValueChange={(v) => onLocChange(idx, "dest", "box", v)}>
                        <SelectTrigger className="rounded-sm h-7 text-xs" data-testid={`stn-dest-box-${idx}`}>
                          <SelectValue placeholder={destBoxes.length === 0 ? "—" : "Box"} />
                        </SelectTrigger>
                        <SelectContent>{destBoxes.map((b) => <SelectItem key={b.id} value={b.id} className="font-mono">{b.box_no}</SelectItem>)}</SelectContent>
                      </Select>
                    </td>

                    {/* Row actions */}
                    <td className="pt-3 text-center">
                      <div className="flex items-center justify-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => splitRow(idx)}
                          title="Add another source row for this item"
                          className="p-1.5 rounded-sm hover:bg-blue-50 text-blue-600"
                          data-testid={`stn-plus-${idx}`}>
                          <Plus size={13} weight="bold" />
                        </button>
                        <button
                          type="button"
                          onClick={() => splitRow(idx)}
                          title="Split this row"
                          className="p-1.5 rounded-sm hover:bg-violet-50 text-violet-600"
                          data-testid={`stn-split-${idx}`}>
                          <ArrowsSplit size={13} weight="bold" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeRow(idx)}
                          disabled={!canDelete}
                          title={canDelete ? "Remove this row" : "Cannot remove — last row for this item"}
                          className={`p-1.5 rounded-sm ${canDelete ? "hover:bg-red-50 text-red-600" : "text-slate-300 cursor-not-allowed"}`}
                          data-testid={`stn-remove-${idx}`}>
                          <Trash size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-slate-400">No items to display.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Footer: narration (left) + save buttons (right) */}
        <div className="p-4 border-t border-slate-200 flex items-start justify-between gap-6">
          <div className="flex-1 max-w-lg">
            <Label className="label-sm block mb-1.5">Narration / Notes</Label>
            <textarea
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
              placeholder="Optional notes about this transfer…"
              rows={2}
              className="w-full rounded-sm border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
              data-testid="stn-narration"
            />
          </div>
          <div className="flex items-center gap-2 pt-6 shrink-0">
            <Button onClick={saveAsDraft} disabled={saving} variant="outline" className="rounded-sm border-slate-300" data-testid="stn-save-draft-footer">
              <FloppyDisk size={14} weight="bold" className="mr-2" /> {saving ? "Saving…" : "Save as Draft"}
            </Button>
            <Button onClick={saveFinal} disabled={saving} className="rounded-sm bg-emerald-700 hover:bg-emerald-800" data-testid="stn-save-final-footer">
              <CheckCircle size={14} weight="bold" className="mr-2" /> {saving ? "Saving…" : "Save Final"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
