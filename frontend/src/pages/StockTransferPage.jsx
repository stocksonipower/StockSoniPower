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
  Pencil, CheckCircle, ArrowsLeftRight, Package, MapPin,
  DownloadSimple, ArrowsClockwise,
} from "@phosphor-icons/react";
import { useAuth } from "../lib/auth";
import AssigneeSelect, { AssigneeBadge } from "../components/AssigneeSelect";
import { useTableSortFilter, ColumnHeader } from "../components/DataTable";
import { exportToExcel } from "../lib/exportExcel";

const PAGE_SIZE = 5000;

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

  const statusLabel = (r) => r.status === "FULLY_TRANSFERRED" ? "Fully Transferred" : (r.status === "PARTIALLY_TRANSFERRED" ? "Partially Transferred" : "Pending");

  const columns = useMemo(() => [
    { key: "str_date", label: "Request Date", value: (r) => fmtDate(r.str_date) },
    { key: "str_no", label: "Request No", value: (r) => r.str_no || "" },
    { key: "purpose", label: "Purpose", value: (r) => r.purpose || "" },
    { key: "items_count", label: "Items", value: (r) => (r.items || []).length },
    { key: "qty_total", label: "Total Qty", value: (r) => (r.items || []).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0) },
    { key: "assigned_to", label: "Assigned To", value: (r) => r.assigned_to_name || r.assigned_to_email || "" },
    { key: "status", label: "Status", value: statusLabel },
  ], []);
  const { filteredRows, getColumnHeaderProps } = useTableSortFilter(rows, columns);

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
        <div className="text-sm text-slate-600">
          {total === 0 ? "No transfer requests yet." : <>Showing <span className="font-semibold text-slate-900">{filteredRows.length}</span> of <span className="font-semibold text-slate-900">{total}</span> transfer requests</>}
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
      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto overflow-visible">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-14">SL NO</th>
              <ColumnHeader {...getColumnHeaderProps("str_date")} label="REQUEST DATE" testid="str-col-date" />
              <ColumnHeader {...getColumnHeaderProps("str_no")} label="REQUEST NO" testid="str-col-no" />
              <ColumnHeader {...getColumnHeaderProps("purpose")} label="PURPOSE" testid="str-col-purpose" />
              <ColumnHeader {...getColumnHeaderProps("items_count")} align="right" label="ITEMS" testid="str-col-items" />
              <ColumnHeader {...getColumnHeaderProps("qty_total")} align="right" label="TOTAL QTY" testid="str-col-qty" />
              <ColumnHeader {...getColumnHeaderProps("assigned_to")} label="ASSIGNED TO" testid="str-col-assigned" />
              <ColumnHeader {...getColumnHeaderProps("status")} label="STATUS" testid="str-col-status" />
              <th className="text-right">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r, idx) => {
              const totalQty = (r.items || []).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0);
              const isFully = r.status === "FULLY_TRANSFERRED";
              const isPartial = r.status === "PARTIALLY_TRANSFERRED";
              const hasNotes = isFully || isPartial;
              const lockedToOther = !!r.assigned_to_user_id && r.assigned_to_user_id !== me?.id && !isAdmin;
              const lock = hasNotes || lockedToOther;
              const editTitle = hasNotes ? "Cannot edit — transfer notes exist"
                : (lockedToOther ? `Locked — assigned to ${r.assigned_to_name || r.assigned_to_email}` : "Edit");
              const deleteTitle = hasNotes ? "Cannot delete — transfer notes exist"
                : (lockedToOther ? `Locked — assigned to ${r.assigned_to_name || r.assigned_to_email}` : "Delete");
              const label = isFully ? "Fully Transferred" : (isPartial ? "Partially Transferred" : "Pending");
              const cls = isFully ? "bg-green-100 text-green-800" : (isPartial ? "bg-blue-50 text-blue-800" : "bg-amber-50 text-amber-700");
              return (
                <tr key={r.id} data-testid={`str-row-${r.str_no}`}>
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td className="font-mono text-slate-700">{fmtDate(r.str_date)}</td>
                  <td>
                    <button onClick={() => onOpen(r)} className="font-mono font-semibold text-blue-700 hover:underline" data-testid={`str-open-${r.str_no}`}>
                      {r.str_no}
                    </button>
                  </td>
                  <td className="text-slate-700 max-w-[280px] truncate">{r.purpose || "—"}</td>
                  <td className="text-right font-mono text-slate-600">{(r.items || []).length}</td>
                  <td className="text-right font-mono font-bold text-slate-900">{totalQty}</td>
                  <td>
                    <AssigneeBadge name={r.assigned_to_name} email={r.assigned_to_email} testid={`str-assignee-${r.str_no}`} />
                  </td>
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${cls}`} data-testid={`str-status-${r.str_no}`}>{label}</span>
                  </td>
                  <td className="text-right whitespace-nowrap">
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
              <tr><td colSpan={9} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? "No transfer requests. Click 'Create New Transfer Request' to begin." : "No rows match the current filters.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between mt-3 text-xs text-slate-600">
        <span>{total > 0 && <>Page {page} of {totalPages}</>}</span>
        <div className="flex items-center gap-2">
          <Button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading} variant="outline" size="sm" className="rounded-sm h-7"><CaretLeft size={12} weight="bold" className="mr-1" /> Prev</Button>
          <Button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages || loading} variant="outline" size="sm" className="rounded-sm h-7">Next <CaretRight size={12} weight="bold" className="ml-1" /></Button>
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
              <Detail k="Status" v={s.status} />
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
                  <th className="text-right">QTY</th><th>PREFERRED DEST</th>
                </tr>
              </thead>
              <tbody>
                {(s.items || []).map((it, idx) => (
                  <tr key={idx}>
                    <td className="font-mono text-slate-500">{idx + 1}</td>
                    <td className="font-mono font-semibold">{it.part_no}</td>
                    <td>{it.make}</td>
                    <td className="text-slate-700 max-w-[260px] truncate">{it.description_1 || "—"}</td>
                    <td className="text-right font-mono font-bold">{it.quantity}</td>
                    <td className="font-mono text-slate-600">
                      {it.dest_godown_name || it.dest_rack_no || it.dest_box_no
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
            setItems((prev) => prev.map((r, i) => i === idx ? { ...r, makes: makesArr, available_qty: found?.available_qty || 0 } : r));
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
        available_qty: auto ? auto.available_qty : 0,
      });
    } catch { updateItem(i, { makes: [], partLooked: true, make: "", available_qty: 0 }); }
  };

  const onMakeChange = (i, makeVal) => {
    const row = items[i];
    const found = (row.makes || []).find((m) => m.make === makeVal);
    updateItem(i, { make: makeVal, available_qty: found?.available_qty || 0 });
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

  const save = async () => {
    if (items.length === 0) { toast.error("Add at least one item"); return; }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.part_no.trim()) { toast.error(`Row ${i + 1}: Part No required`); return; }
      if (!it.make.trim()) { toast.error(`Row ${i + 1}: Make required`); return; }
      const q = parseFloat(it.quantity);
      if (isNaN(q) || q <= 0) { toast.error(`Row ${i + 1}: Quantity > 0`); return; }
      if (q > (it.available_qty || 0) + 1e-6) {
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
          part_no: it.part_no.trim(), make: it.make.trim(), quantity: parseFloat(it.quantity),
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
            <div className="label-sm">Items to Transfer</div>
            <div className="text-xs text-slate-500 mt-0.5">{items.length} row{items.length !== 1 ? "s" : ""} · destination is optional (Transfer Note can finalise)</div>
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
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="w-14">SL</th><th>PART NO</th><th>MAKE</th><th>QTY</th>
                <th>PREFERRED DEST GODOWN</th><th>RACK</th><th>BOX</th><th className="w-14"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => {
                const overStock = it.available_qty !== undefined && (parseFloat(it.quantity) || 0) > (it.available_qty || 0) + 1e-6;
                const destRacks = racksByGodown[it.dest_godown_id] || [];
                const destBoxes = boxesByRack[it.dest_rack_id] || [];
                return (
                  <tr key={idx} data-testid={`str-item-row-${idx}`} className={overStock ? "bg-red-50" : ""}>
                    <td className="font-mono text-slate-500">{idx + 1}</td>
                    <td>
                      <Input value={it.part_no}
                        onChange={(e) => updateItem(idx, { part_no: e.target.value, partLooked: false, makes: [], make: "", available_qty: 0 })}
                        onBlur={(e) => lookupMakes(idx, e.target.value)}
                        placeholder="Enter part no" className="rounded-sm font-mono h-8" data-testid={`str-part-no-${idx}`} />
                    </td>
                    <td className="w-56">
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
                    <td className="w-28">
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
  const goCreate = () => { setEditing(null); setView("create"); };
  const goEdit = (s) => { setEditing(s); setView("edit"); };
  const goList = () => { setEditing(null); setView("list"); setReloadKey((k) => k + 1); };

  return (
    <>
      {view === "list" && <TransferNoteList reloadKey={reloadKey} onCreate={goCreate} onEdit={goEdit} onOpen={setOpenStn} onRecorded={() => setReloadKey((k) => k + 1)} />}
      {(view === "create" || view === "edit") && <TransferNoteForm editing={editing} onCancel={goList} onSaved={goList} />}
      <TransferNoteDetailDialog stn={openStn} onClose={() => setOpenStn(null)} />
    </>
  );
}

function TransferNoteList({ reloadKey, onCreate, onEdit, onOpen, onRecorded }) {
  const { user: me, isAdmin } = useAuth();
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [recordingId, setRecordingId] = useState(null);

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

  const handleRecord = async (stn) => {
    if (!window.confirm(`Record ${stn.stn_no} as Stock Transfer?\n\n${stn.items.length} item(s) — 1 OUT + 1 IN transaction will be created per item.`)) return;
    setRecordingId(stn.id);
    try {
      const { data } = await api.post(`/transfer-notes/${stn.id}/record`);
      toast.success(`Recorded · ${data.transactions_created} transaction(s) created`);
      load(); onRecorded?.();
    } catch (err) { toast.error(formatApiError(err.response?.data?.detail) || "Could not record"); }
    finally { setRecordingId(null); }
  };

  const columns = useMemo(() => [
    { key: "stn_date", label: "STN Date", value: (r) => fmtDate(r.stn_date) },
    { key: "stn_no", label: "STN No", value: (r) => r.stn_no || "" },
    { key: "str_no", label: "Request No", value: (r) => r.transfer_request_no || "" },
    { key: "items_count", label: "Items", value: (r) => (r.items || []).length },
    { key: "qty_total", label: "Qty", value: (r) => (r.items || []).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0) },
    { key: "assigned_to", label: "Assigned To", value: (r) => r.parent_assigned_to_name || r.parent_assigned_to_email || "" },
    { key: "status", label: "Status", value: (r) => r.status === "RECORDED" ? "Recorded" : "Draft" },
  ], []);
  const { filteredRows, getColumnHeaderProps } = useTableSortFilter(rows, columns);

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
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div className="text-sm text-slate-600">
          {total === 0 ? "No transfer notes yet." : <>Showing <span className="font-semibold text-slate-900">{filteredRows.length}</span> of <span className="font-semibold text-slate-900">{total}</span> transfer notes</>}
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleExport} variant="outline" className="rounded-sm border-slate-300" data-testid="stn-export-button">
            <DownloadSimple size={14} weight="bold" className="mr-2" /> Export
          </Button>
          <Button onClick={load} variant="outline" className="rounded-sm border-slate-300" disabled={loading} data-testid="stn-refresh-button">
            <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button onClick={onCreate} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="create-stn-button">
            <Plus size={16} weight="bold" className="mr-2" /> Create New Transfer Note
          </Button>
        </div>
      </div>
      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto overflow-visible">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-14">SL NO</th>
              <ColumnHeader {...getColumnHeaderProps("stn_date")} label="STN DATE" testid="stn-col-date" />
              <ColumnHeader {...getColumnHeaderProps("stn_no")} label="STN NO" testid="stn-col-no" />
              <ColumnHeader {...getColumnHeaderProps("str_no")} label="REQUEST NO" testid="stn-col-str-no" />
              <ColumnHeader {...getColumnHeaderProps("items_count")} align="right" label="ITEMS" testid="stn-col-items" />
              <ColumnHeader {...getColumnHeaderProps("qty_total")} align="right" label="QTY" testid="stn-col-qty" />
              <ColumnHeader {...getColumnHeaderProps("assigned_to")} label="ASSIGNED TO" testid="stn-col-assigned" />
              <ColumnHeader {...getColumnHeaderProps("status")} label="STATUS" testid="stn-col-status" />
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
              const lock = recorded || lockedToOther;
              const editTitle = recorded ? "Already recorded" : (lockedToOther ? `Locked — assigned to ${aName || aEmail}` : "Edit");
              const deleteTitle = recorded ? "Already recorded" : (lockedToOther ? `Locked — assigned to ${aName || aEmail}` : "Delete");
              const recordTitle = recorded ? "Already recorded" : (lockedToOther ? `Locked — assigned to ${aName || aEmail}` : "Record as Stock Transfer");
              return (
                <tr key={r.id} data-testid={`stn-row-${r.stn_no}`}>
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td className="font-mono text-slate-700">{fmtDate(r.stn_date)}</td>
                  <td>
                    <button onClick={() => onOpen(r)} className="font-mono font-semibold text-blue-700 hover:underline" data-testid={`stn-open-${r.stn_no}`}>{r.stn_no}</button>
                  </td>
                  <td className="font-mono text-slate-700">{r.transfer_request_no || "—"}</td>
                  <td className="text-right font-mono text-slate-600">{(r.items || []).length}</td>
                  <td className="text-right font-mono font-bold text-slate-900">{totalQty}</td>
                  <td>
                    <AssigneeBadge name={aName} email={aEmail} testid={`stn-assignee-${r.stn_no}`} />
                  </td>
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${recorded ? "bg-green-100 text-green-800" : "bg-amber-50 text-amber-700"}`} data-testid={`stn-status-${r.stn_no}`}>
                      {recorded ? "Recorded" : "Draft"}
                    </span>
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <button onClick={() => onEdit(r)} disabled={lock} title={editTitle}
                      className={`p-1.5 rounded-sm mr-1 ${lock ? "text-slate-300 cursor-not-allowed" : "hover:bg-slate-100"}`}
                      data-testid={`stn-edit-${r.stn_no}`}>
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => handleDelete(r)} disabled={lock} title={deleteTitle}
                      className={`p-1.5 rounded-sm mr-2 ${lock ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                      data-testid={`stn-delete-${r.stn_no}`}>
                      <Trash size={14} />
                    </button>
                    <Button onClick={() => handleRecord(r)} disabled={lock || recordingId === r.id} size="sm"
                      title={recordTitle}
                      className={`rounded-sm h-7 text-xs ${lock ? "bg-slate-200 text-slate-500 cursor-not-allowed hover:bg-slate-200" : "bg-emerald-700 hover:bg-emerald-800 text-white"}`}
                      data-testid={`stn-record-${r.stn_no}`}>
                      <CheckCircle size={12} weight="bold" className="mr-1" />
                      {recorded ? "Recorded" : (recordingId === r.id ? "Recording…" : "Record Transfer")}
                    </Button>
                  </td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && (
              <tr><td colSpan={9} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? "No transfer notes." : "No rows match the current filters.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between mt-3 text-xs text-slate-600">
        <span>{total > 0 && <>Page {page} of {totalPages}</>}</span>
        <div className="flex items-center gap-2">
          <Button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading} variant="outline" size="sm" className="rounded-sm h-7"><CaretLeft size={12} weight="bold" className="mr-1" /> Prev</Button>
          <Button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages || loading} variant="outline" size="sm" className="rounded-sm h-7">Next <CaretRight size={12} weight="bold" className="ml-1" /></Button>
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
            <DialogHeader><DialogTitle className="text-2xl font-black font-mono">{stn.stn_no}</DialogTitle></DialogHeader>
            <div className="grid grid-cols-3 gap-4 text-sm border-b border-slate-200 pb-4 mb-4">
              <Detail k="STN Date" v={fmtDate(stn.stn_date)} />
              <Detail k="Request No" v={stn.transfer_request_no || "—"} />
              <Detail k="Status" v={stn.status} />
              <Detail k="Created By" v={stn.created_by || "—"} />
              <Detail k="Created At" v={new Date(stn.created_at).toLocaleString()} />
              <div>
                <div className="label-sm">Assigned To (from Request)</div>
                <div className="mt-1"><AssigneeBadge name={stn.parent_assigned_to_name} email={stn.parent_assigned_to_email} /></div>
              </div>
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
                    <td className="font-mono font-semibold">{it.part_no}</td>
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

function TransferNoteForm({ editing, onCancel, onSaved }) {
  const isEdit = !!editing;
  const [stnNo, setStnNo] = useState("");
  const [stnDate, setStnDate] = useState("");
  const [pendingStrs, setPendingStrs] = useState([]);
  const [selectedStrId, setSelectedStrId] = useState("");
  const [items, setItems] = useState([]);
  const [saving, setSaving] = useState(false);

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
          setItems((editing.items || []).map((it) => {
            const p = map[`${it.part_no}||${it.make}`] || {};
            return { ...it, available_locations: p.available_locations || [], pending_qty: p.pending_qty ?? 0, requested_qty: p.requested_qty ?? 0 };
          }));
        }).catch(() => setItems((editing.items || []).map((it) => ({ ...it, available_locations: [], pending_qty: 0, requested_qty: 0 }))));
    } else {
      api.get("/transfer-notes/next-no").then((r) => { setStnNo(r.data.next_stn_no); setStnDate(r.data.stn_date); })
        .catch(() => toast.error("Could not preview transfer-note number"));
      api.get("/transfer-requests", { params: { not_status: "FULLY_TRANSFERRED", page_size: 5000 } })
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
    if (!id) { setItems([]); return; }
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
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.src_godown_id || !it.src_rack_id) { toast.error(`Row ${i + 1}: pick Source Godown / Rack`); return; }
      if (!it.dest_godown_id || !it.dest_rack_id) { toast.error(`Row ${i + 1}: pick Destination Godown / Rack`); return; }
      const srcHasBoxes = (boxesByRack[it.src_rack_id] || []).length > 0;
      if (srcHasBoxes && !it.src_box_id) { toast.error(`Row ${i + 1}: pick Source Box`); return; }
      const destHasBoxes = (boxesByRack[it.dest_rack_id] || []).length > 0;
      if (destHasBoxes && !it.dest_box_id) { toast.error(`Row ${i + 1}: pick Destination Box`); return; }
      const q = parseFloat(it.quantity);
      if (isNaN(q) || q <= 0) { toast.error(`Row ${i + 1}: quantity must be > 0`); return; }
      if (it.src_godown_id === it.dest_godown_id && it.src_rack_id === it.dest_rack_id && (it.src_box_id || "") === (it.dest_box_id || "")) {
        toast.error(`Row ${i + 1}: source and destination are identical`); return;
      }
    }
    setSaving(true);
    try {
      const payload = {
        transfer_request_id: selectedStrId,
        items: items.map((it) => ({
          part_no: it.part_no, make: it.make, quantity: parseFloat(it.quantity),
          model: it.model || "", old_part_no: it.old_part_no || "", make_part_no: it.make_part_no || "",
          description_1: it.description_1 || "", description_2: it.description_2 || "",
          remarks_oem: it.remarks_oem || "", remarks_others: it.remarks_others || "",
          item_category: it.item_category || "",
          src_godown_id: it.src_godown_id, src_godown_name: it.src_godown_name || "",
          src_rack_id: it.src_rack_id, src_rack_no: it.src_rack_no || "",
          src_box_id: it.src_box_id || "", src_box_no: it.src_box_no || "", src_box_category: it.src_box_category || "",
          dest_godown_id: it.dest_godown_id, dest_godown_name: it.dest_godown_name || "",
          dest_rack_id: it.dest_rack_id, dest_rack_no: it.dest_rack_no || "",
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
          <div className="p-4 border-b border-slate-200 flex items-center gap-2">
            <Package size={16} weight="bold" className="text-slate-500" />
            <div className="label-sm">Items to Transfer ({items.length})</div>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table w-full text-xs">
              <thead>
                <tr>
                  <th className="w-10">SL</th>
                  <th>PART / MAKE</th>
                  <th className="text-right">REQ / PEND / NOW</th>
                  <th>SOURCE</th>
                  <th>DESTINATION</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => {
                  const srcRacks = racksByGodown[it.src_godown_id] || [];
                  const srcBoxes = boxesByRack[it.src_rack_id] || [];
                  const destRacks = racksByGodown[it.dest_godown_id] || [];
                  const destBoxes = boxesByRack[it.dest_rack_id] || [];
                  const overPending = (parseFloat(it.quantity) || 0) > (it.pending_qty || 0) + 1e-6;
                  return (
                    <tr key={idx} data-testid={`stn-item-row-${idx}`} className={overPending ? "bg-red-50 align-top" : "align-top"}>
                      <td className="font-mono text-slate-500 pt-3">{idx + 1}</td>
                      <td className="pt-3">
                        <div className="font-mono font-semibold">{it.part_no}</div>
                        <div className="text-slate-600">{it.make}</div>
                        <div className="text-[10px] text-slate-500 mt-0.5">{it.description_1 || ""}</div>
                      </td>
                      <td className="text-right pt-3">
                        <div className="font-mono text-[11px] text-slate-500">req {it.requested_qty} · pend <b className="text-slate-900">{it.pending_qty}</b></div>
                        <Input type="number" min="0.001" step="any" value={it.quantity}
                          onChange={(e) => updateItem(idx, { quantity: e.target.value })}
                          className={`rounded-sm font-mono h-8 text-right mt-1 w-24 ml-auto ${overPending ? "border-red-400" : ""}`}
                          data-testid={`stn-qty-${idx}`} />
                        {overPending && <div className="text-[10px] text-red-600 font-bold mt-0.5">over {it.quantity}/{it.pending_qty}</div>}
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
                                {L.godown_name}/{L.rack_no}{L.box_no ? "/" + L.box_no : ""} ({L.available_qty})
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
