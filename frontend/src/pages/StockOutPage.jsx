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
} from "@phosphor-icons/react";

const PAGE_SIZE = 5000;

function fmtDate(iso) {
  if (!iso) return "—";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
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

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="mt-4" data-testid="in-list-view">
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm text-slate-600">
          {total === 0 ? "No issue notes yet." : <>Showing <span className="font-semibold text-slate-900">{rows.length}</span> of <span className="font-semibold text-slate-900">{total}</span> issue notes</>}
        </div>
        <Button onClick={onCreate} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="create-in-button">
          <Plus size={16} weight="bold" className="mr-2" /> Create New Issue Note
        </Button>
      </div>
      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-14">SL NO</th>
              <th>ISSUE NOTE DATE</th>
              <th>ISSUE NOTE NO</th>
              <th>ISSUED TO</th>
              <th className="text-right">ITEMS</th>
              <th className="text-right">TOTAL QUANTITY</th>
              <th>STATUS</th>
              <th className="text-right">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              const totalQty = (r.items || []).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0);
              const isFully = r.status === "FULLY_PICKED";
              const isPartial = r.status === "PARTIALLY_PICKED";
              const hasPicking = isFully || isPartial;
              const label = isFully ? "Fully Picked" : (isPartial ? "Partially Picked" : "Picking Pending");
              const cls = isFully ? "bg-green-100 text-green-800" : (isPartial ? "bg-blue-50 text-blue-800" : "bg-amber-50 text-amber-700");
              return (
                <tr key={r.id} data-testid={`in-row-${r.in_no}`}>
                  <td className="font-mono text-slate-500">{(page - 1) * PAGE_SIZE + idx + 1}</td>
                  <td className="font-mono text-slate-700">{fmtDate(r.in_date)}</td>
                  <td>
                    <button onClick={() => onOpen(r)} className="font-mono font-semibold text-blue-700 hover:underline" data-testid={`in-open-${r.in_no}`}>
                      {r.in_no}
                    </button>
                  </td>
                  <td className="text-slate-700">{r.issued_to || "—"}</td>
                  <td className="text-right font-mono text-slate-600">{(r.items || []).length}</td>
                  <td className="text-right font-mono font-bold text-slate-900">{totalQty}</td>
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${cls}`} data-testid={`in-status-${r.in_no}`}>{label}</span>
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <button onClick={() => onEdit(r)} disabled={hasPicking}
                      title={hasPicking ? "Cannot edit — picking notes exist" : "Edit"}
                      className={`p-1.5 rounded-sm mr-1 ${hasPicking ? "text-slate-300 cursor-not-allowed" : "hover:bg-slate-100"}`}
                      data-testid={`in-edit-${r.in_no}`}>
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => handleDelete(r)} disabled={hasPicking}
                      title={hasPicking ? "Cannot delete — picking notes exist" : "Delete"}
                      className={`p-1.5 rounded-sm ${hasPicking ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                      data-testid={`in-delete-${r.in_no}`}>
                      <Trash size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={8} className="text-center py-12 text-slate-500">{loading ? "Loading…" : "No issue notes. Click 'Create New Issue Note' to begin."}</td></tr>
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

function IssueNoteDetailDialog({ inn, onClose }) {
  return (
    <Dialog open={!!inn} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl rounded-sm" data-testid="in-detail-dialog">
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
            </div>
            <table className="data-table w-full">
              <thead>
                <tr><th className="w-14">SL</th><th>PART NO</th><th>MAKE</th><th>DESCRIPTION</th><th className="text-right">QTY</th></tr>
              </thead>
              <tbody>
                {(inn.items || []).map((it, idx) => (
                  <tr key={idx}>
                    <td className="font-mono text-slate-500">{idx + 1}</td>
                    <td className="font-mono font-semibold">{it.part_no}</td>
                    <td>{it.make}</td>
                    <td className="text-slate-700">{it.description_1 || "—"}</td>
                    <td className="text-right font-mono font-bold">{it.quantity}</td>
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

const emptyIssueItem = () => ({ part_no: "", make: "", quantity: "", makes: [], partLooked: false });

function IssueNoteForm({ editing, onCancel, onSaved }) {
  const isEdit = !!editing;
  const [inNo, setInNo] = useState("");
  const [inDate, setInDate] = useState("");
  const [issuedTo, setIssuedTo] = useState("");
  const [items, setItems] = useState([emptyIssueItem()]);
  const [addCount, setAddCount] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isEdit) {
      setInNo(editing.in_no || "");
      setInDate(editing.in_date || "");
      setIssuedTo(editing.issued_to || "");
      const initial = (editing.items || []).map((it) => ({
        part_no: it.part_no || "", make: it.make || "", quantity: it.quantity ?? "",
        makes: it.make ? [it.make] : [], partLooked: !!it.part_no,
      }));
      setItems(initial.length ? initial : [emptyIssueItem()]);
      // Refresh makes list per row
      initial.forEach((row, idx) => {
        if (!row.part_no) return;
        api.get("/stock-master/lookup/makes", { params: { part_no: row.part_no } })
          .then(({ data }) => setItems((prev) => prev.map((r, i) => i === idx ? { ...r, makes: data.makes || [] } : r)))
          .catch(() => {});
      });
    } else {
      api.get("/issue-notes/next-no").then((r) => { setInNo(r.data.next_in_no); setInDate(r.data.in_date); })
        .catch(() => toast.error("Could not preview issue-note number"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, editing]);

  const addItems = () => {
    const n = Math.max(1, Math.min(500, parseInt(addCount, 10) || 1));
    setItems((p) => [...p, ...Array.from({ length: n }, emptyIssueItem)]);
    setAddCount("");
  };
  const removeItem = (i) => setItems((p) => (p.length === 1 ? p : p.filter((_, idx) => idx !== i)));
  const updateItem = (i, patch) => setItems((p) => p.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  const lookupMakes = async (i, partNo) => {
    const v = (partNo || "").trim();
    if (!v) { updateItem(i, { makes: [], make: "", partLooked: false }); return; }
    try {
      const { data } = await api.get("/stock-master/lookup/makes", { params: { part_no: v } });
      const list = data.makes || [];
      updateItem(i, { makes: list, partLooked: true, make: list.length === 1 ? list[0] : "" });
    } catch { updateItem(i, { makes: [], partLooked: true, make: "" }); }
  };

  const save = async () => {
    if (items.length === 0) { toast.error("Add at least one item"); return; }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.part_no.trim()) { toast.error(`Row ${i + 1}: Part No required`); return; }
      if (!it.make.trim()) { toast.error(`Row ${i + 1}: Make required`); return; }
      const q = parseFloat(it.quantity);
      if (isNaN(q) || q <= 0) { toast.error(`Row ${i + 1}: Quantity > 0`); return; }
    }
    setSaving(true);
    try {
      const payload = {
        issued_to: issuedTo.trim(),
        items: items.map((it) => ({ part_no: it.part_no.trim(), make: it.make.trim(), quantity: parseFloat(it.quantity) })),
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
      </div>

      <div className="bg-white border border-slate-200 rounded-sm">
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <div>
            <div className="label-sm">Items Requested</div>
            <div className="text-xs text-slate-500 mt-0.5">{items.length} row{items.length !== 1 ? "s" : ""}</div>
          </div>
          <div className="flex items-center gap-2">
            <Input type="number" min="1" max="500" value={addCount} onChange={(e) => setAddCount(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addItems(); } }}
              placeholder="Qty" className="rounded-sm font-mono h-9 w-24 text-center" data-testid="in-add-row-count" />
            <Button onClick={addItems} variant="outline" className="rounded-sm" data-testid="in-add-row-button">
              <Plus size={14} weight="bold" className="mr-1" /> Add Row{addCount && parseInt(addCount, 10) > 1 ? "s" : ""}
            </Button>
          </div>
        </div>

        <table className="data-table w-full">
          <thead>
            <tr><th className="w-14">SL</th><th>PART NO</th><th>QUANTITY</th><th>MAKE</th><th className="w-14"></th></tr>
          </thead>
          <tbody>
            {items.map((it, idx) => (
              <tr key={idx} data-testid={`in-item-row-${idx}`}>
                <td className="font-mono text-slate-500">{idx + 1}</td>
                <td>
                  <Input value={it.part_no}
                    onChange={(e) => updateItem(idx, { part_no: e.target.value, partLooked: false, makes: [], make: "" })}
                    onBlur={(e) => lookupMakes(idx, e.target.value)}
                    placeholder="Enter part no"
                    className="rounded-sm font-mono h-8" data-testid={`in-part-no-${idx}`} />
                </td>
                <td className="w-32">
                  <Input type="number" min="0.001" step="any" value={it.quantity}
                    onChange={(e) => updateItem(idx, { quantity: e.target.value })}
                    placeholder="0" className="rounded-sm font-mono h-8 text-right" data-testid={`in-qty-${idx}`} />
                </td>
                <td className="w-64">
                  <Select disabled={!it.partLooked || it.makes.length === 0}
                    value={it.make || undefined} onValueChange={(v) => updateItem(idx, { make: v })}>
                    <SelectTrigger className="rounded-sm h-8" data-testid={`in-make-${idx}`}>
                      <SelectValue placeholder={!it.partLooked ? "Enter Part No first" : (it.makes.length === 0 ? "Not in master" : "Select make")} />
                    </SelectTrigger>
                    <SelectContent>
                      {it.makes.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </td>
                <td>
                  <button onClick={() => removeItem(idx)} disabled={items.length === 1}
                    className={`p-1.5 rounded-sm ${items.length === 1 ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                    data-testid={`in-remove-row-${idx}`}><Trash size={14} /></button>
                </td>
              </tr>
            ))}
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
  const goCreate = () => { setEditing(null); setView("create"); };
  const goEdit = (p) => { setEditing(p); setView("edit"); };
  const goList = () => { setEditing(null); setView("list"); setReloadKey((k) => k + 1); };

  return (
    <>
      {view === "list" && <PickingNoteList reloadKey={reloadKey} onCreate={goCreate} onEdit={goEdit} onOpen={setOpenPn} onRecorded={() => setReloadKey((k) => k + 1)} />}
      {(view === "create" || view === "edit") && <PickingNoteForm editing={editing} onCancel={goList} onSaved={goList} />}
      <PickingNoteDetailDialog pn={openPn} onClose={() => setOpenPn(null)} />
    </>
  );
}

function PickingNoteList({ reloadKey, onCreate, onEdit, onOpen, onRecorded }) {
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
      load(); onRecorded?.();
    } catch (err) { toast.error(formatApiError(err.response?.data?.detail) || "Could not record"); }
    finally { setRecordingId(null); }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="mt-4" data-testid="pn-list-view">
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm text-slate-600">
          {total === 0 ? "No picking notes yet." : <>Showing <span className="font-semibold text-slate-900">{rows.length}</span> of <span className="font-semibold text-slate-900">{total}</span> picking notes</>}
        </div>
        <Button onClick={onCreate} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="create-pn-button">
          <Plus size={16} weight="bold" className="mr-2" /> Create New Picking Note
        </Button>
      </div>
      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-14">SL NO</th>
              <th>PICKING NOTE DATE</th>
              <th>PICKING NOTE NO</th>
              <th>ISSUE NOTE DATE</th>
              <th>ISSUE NOTE NO</th>
              <th>ISSUED TO</th>
              <th className="text-right">ITEMS</th>
              <th className="text-right">QUANTITY</th>
              <th>STATUS</th>
              <th className="text-right">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              const totalQty = (r.items || []).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0);
              const recorded = r.status === "RECORDED";
              return (
                <tr key={r.id} data-testid={`pn-row-${r.pn_no}`}>
                  <td className="font-mono text-slate-500">{(page - 1) * PAGE_SIZE + idx + 1}</td>
                  <td className="font-mono text-slate-700">{fmtDate(r.pn_date)}</td>
                  <td>
                    <button onClick={() => onOpen(r)} className="font-mono font-semibold text-blue-700 hover:underline" data-testid={`pn-open-${r.pn_no}`}>{r.pn_no}</button>
                  </td>
                  <td className="font-mono text-slate-700">{fmtDate(r.issue_note_date)}</td>
                  <td className="font-mono text-slate-700">{r.issue_note_no || "—"}</td>
                  <td className="text-slate-700">{r.issued_to || "—"}</td>
                  <td className="text-right font-mono text-slate-600">{(r.items || []).length}</td>
                  <td className="text-right font-mono font-bold text-slate-900">{totalQty}</td>
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${recorded ? "bg-green-100 text-green-800" : "bg-amber-50 text-amber-700"}`} data-testid={`pn-status-${r.pn_no}`}>
                      {recorded ? "Recorded" : "Draft"}
                    </span>
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <button onClick={() => onEdit(r)} disabled={recorded}
                      className={`p-1.5 rounded-sm mr-1 ${recorded ? "text-slate-300 cursor-not-allowed" : "hover:bg-slate-100"}`}
                      data-testid={`pn-edit-${r.pn_no}`}>
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => handleDelete(r)} disabled={recorded}
                      className={`p-1.5 rounded-sm mr-2 ${recorded ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                      data-testid={`pn-delete-${r.pn_no}`}>
                      <Trash size={14} />
                    </button>
                    <Button onClick={() => handleRecord(r)} disabled={recorded || recordingId === r.id} size="sm"
                      className={`rounded-sm h-7 text-xs ${recorded ? "bg-slate-200 text-slate-500 cursor-not-allowed hover:bg-slate-200" : "bg-emerald-700 hover:bg-emerald-800 text-white"}`}
                      data-testid={`pn-record-${r.pn_no}`}>
                      <CheckCircle size={12} weight="bold" className="mr-1" />
                      {recorded ? "Recorded" : (recordingId === r.id ? "Recording…" : "Record Stock Out")}
                    </Button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={10} className="text-center py-12 text-slate-500">{loading ? "Loading…" : "No picking notes. Click 'Create New Picking Note' to begin."}</td></tr>
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

function PickingNoteDetailDialog({ pn, onClose }) {
  return (
    <Dialog open={!!pn} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl rounded-sm" data-testid="pn-detail-dialog">
        {pn && (
          <>
            <DialogHeader><DialogTitle className="text-2xl font-black font-mono">{pn.pn_no}</DialogTitle></DialogHeader>
            <div className="grid grid-cols-3 gap-4 text-sm border-b border-slate-200 pb-4 mb-4">
              <Detail k="Picking Note Date" v={fmtDate(pn.pn_date)} />
              <Detail k="Issue Note No" v={pn.issue_note_no || "—"} />
              <Detail k="Issued To" v={pn.issued_to || "—"} />
              <Detail k="Status" v={pn.status} />
              <Detail k="Created By" v={pn.created_by || "—"} />
              <Detail k="Created At" v={new Date(pn.created_at).toLocaleString()} />
            </div>
            <table className="data-table w-full text-xs">
              <thead><tr><th>SL</th><th>PART NO</th><th>MAKE</th><th>DESCRIPTION</th><th className="text-right">QTY</th><th>GODOWN</th><th>RACK</th><th>BOX</th></tr></thead>
              <tbody>
                {(pn.items || []).map((it, idx) => (
                  <tr key={idx}>
                    <td className="font-mono text-slate-500">{idx + 1}</td>
                    <td className="font-mono font-semibold">{it.part_no}</td>
                    <td>{it.make}</td>
                    <td className="text-slate-700 max-w-[260px] truncate">{it.description_1 || "—"}</td>
                    <td className="text-right font-mono font-bold">{it.quantity}</td>
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
          const map = {};
          (r.data.items || []).forEach((p) => { map[`${p.part_no}||${p.make}`] = p; });
          setItems((editing.items || []).map((it) => {
            const p = map[`${it.part_no}||${it.make}`] || {};
            return {
              ...it,
              available_locations: p.available_locations || [],
              pending_qty: p.pending_qty ?? 0,
              requested_qty: p.requested_qty ?? 0,
            };
          }));
        }).catch(() => setItems((editing.items || []).map((it) => ({ ...it, available_locations: [], pending_qty: 0, requested_qty: 0 }))));
    } else {
      api.get("/picking-notes/next-no").then((r) => { setPnNo(r.data.next_pn_no); setPnDate(r.data.pn_date); })
        .catch(() => toast.error("Could not preview picking-note number"));
      api.get("/issue-notes", { params: { not_status: "FULLY_PICKED", page_size: 5000 } })
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
      const k = `${r.part_no}||${r.make}`;
      m[k] = (m[k] || 0) + (parseFloat(r.quantity) || 0);
    });
    return m;
  }, [items]);

  const save = async () => {
    if (!selectedInId) { toast.error("Select an Issue Note"); return; }
    if (items.length === 0) { toast.error("No items to pick"); return; }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.godown_id || !it.rack_id) { toast.error(`Row ${i + 1}: pick Godown / Rack`); return; }
      const hasBoxes = (boxesByRack[it.rack_id] || []).length > 0;
      if (hasBoxes && !it.box_id) { toast.error(`Row ${i + 1}: pick Box`); return; }
      const q = parseFloat(it.quantity);
      if (isNaN(q) || q <= 0) { toast.error(`Row ${i + 1}: quantity must be > 0`); return; }
      // Per-location available check (client-side)
      const loc = (it.available_locations || []).find((L) => (L.box_id || "") === (it.box_id || ""));
      if (loc && q > (loc.available_qty ?? loc.current_qty) + 1e-6) {
        toast.error(`Row ${i + 1}: only ${loc.available_qty ?? loc.current_qty} available at ${loc.godown_name}/${loc.rack_no}/${loc.box_no || "—"}`);
        return;
      }
    }
    // Cumulative-vs-pending check
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
        issue_note_id: selectedInId,
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
                <th className="text-right">QTY</th>
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
                    <td className="font-mono font-semibold">{it.part_no}</td>
                    <td>{it.make}</td>
                    <td className="font-mono text-slate-600">{it.model || "—"}</td>
                    <td className="text-slate-700 max-w-[200px] truncate" title={it.description_1}>{it.description_1 || "—"}</td>
                    <td className="text-slate-600">{it.item_category || "—"}</td>
                    <td className="text-right">
                      <Input type="number" min="0.001" step="any" value={it.quantity}
                        onChange={(e) => updateItem(idx, { quantity: e.target.value })}
                        className={`rounded-sm font-mono h-8 text-right w-20 ${overAllocated || overAtLoc ? "border-red-400" : ""}`}
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
