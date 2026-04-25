import React, { useEffect, useState, useCallback } from "react";
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
import {
  Plus, Trash, ArrowLeft, FloppyDisk, FileText, CaretLeft, CaretRight, Pencil, Stack,
} from "@phosphor-icons/react";
import RackingNoteTab from "./RackingNoteTab";
import AssigneeSelect, { AssigneeBadge } from "../components/AssigneeSelect";
import { useAuth } from "../lib/auth";

/* ==============================================================
   STOCK IN  ·  Receipt Note tab
   ============================================================== */

/** Format an ISO date "YYYY-MM-DD" -> "DD-MM-YYYY". Returns "—" for falsy. */
function fmtDate(iso) {
  if (!iso) return "—";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[3]}-${m[2]}-${m[1]}`;
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
          {/* future tabs go here */}
        </TabsList>

        <TabsContent value="receipt-note">
          <ReceiptNoteTab />
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
   List view
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

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mt-4" data-testid="rn-list-view">
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm text-slate-600">
          {total === 0 ? "No receipt notes yet." : <>Showing <span className="font-semibold text-slate-900">{rows.length}</span> of <span className="font-semibold text-slate-900">{total}</span> receipt notes</>}
        </div>
        <Button onClick={onCreate} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="create-rn-button">
          <Plus size={16} weight="bold" className="mr-2" /> Create New Receipt Note
        </Button>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-14">SL NO</th>
              <th>RECEIPT NOTE DATE</th>
              <th>RECEIPT NOTE NO</th>
              <th>INVOICE DATE</th>
              <th>INVOICE NO</th>
              <th className="text-right">ITEMS</th>
              <th className="text-right">TOTAL QUANTITY</th>
              <th>ASSIGNED TO</th>
              <th>STATUS</th>
              <th className="text-right">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              const totalQty = (r.items || []).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0);
              const isFully = r.status === "FULLY_RACKED";
              const isPartial = r.status === "PARTIALLY_RACKED";
              const hasRacking = isFully || isPartial; // any RKN exists -> edit/delete blocked
              const isAssignedToOther = !!r.assigned_to_user_id && r.assigned_to_user_id !== me?.id && !isAdmin;
              const lockEdit = hasRacking || isAssignedToOther;
              const editTitle = hasRacking
                ? "Cannot edit — racking notes exist for this receipt"
                : (isAssignedToOther ? `Locked — assigned to ${r.assigned_to_name || r.assigned_to_email}` : "Edit");
              const deleteTitle = hasRacking
                ? "Cannot delete — racking notes exist for this receipt"
                : (isAssignedToOther ? `Locked — assigned to ${r.assigned_to_name || r.assigned_to_email}` : "Delete");
              const statusLabel = isFully ? "Fully Racked" : (isPartial ? "Partially Racked" : "Racking Pending");
              const statusClass = isFully
                ? "bg-green-100 text-green-800"
                : (isPartial ? "bg-blue-50 text-blue-800" : "bg-amber-50 text-amber-700");
              return (
                <tr key={r.id} data-testid={`rn-row-${r.rn_no}`}>
                  <td className="font-mono text-slate-500">{(page - 1) * PAGE_SIZE + idx + 1}</td>
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
                  <td className="text-right font-mono text-slate-600">{(r.items || []).length}</td>
                  <td className="text-right font-mono font-bold text-slate-900">{totalQty}</td>
                  <td>
                    <AssigneeBadge name={r.assigned_to_name} email={r.assigned_to_email} testid={`rn-assignee-${r.rn_no}`} />
                  </td>
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${statusClass}`}
                      data-testid={`rn-status-${r.rn_no}`}>
                      {statusLabel}
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
            {rows.length === 0 && (
              <tr><td colSpan={10} className="text-center py-12 text-slate-500">{loading ? "Loading…" : "No receipt notes. Click 'Create New Receipt Note' to begin."}</td></tr>
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
   Detail dialog (read-only)
   -------------------------------------------------------------- */
function ReceiptNoteDetailDialog({ rn, onClose }) {
  return (
    <Dialog open={!!rn} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl rounded-sm" data-testid="rn-detail-dialog">
        {rn && (
          <>
            <DialogHeader>
              <DialogTitle className="text-2xl font-black font-mono">{rn.rn_no}</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-4 text-sm border-b border-slate-200 pb-4 mb-4">
              <Detail k="Receipt Note Date" v={fmtDate(rn.rn_date)} />
              <Detail k="Financial Year" v={rn.fy ? `FY ${rn.fy}` : "—"} />
              <Detail k="Invoice Date" v={fmtDate(rn.invoice_date)} />
              <Detail k="Invoice No" v={rn.invoice_no || "—"} />
              <Detail k="Created By" v={rn.created_by || "—"} />
              <Detail k="Created At" v={new Date(rn.created_at).toLocaleString()} />
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
                    <th className="text-right">QUANTITY</th>
                  </tr>
                </thead>
                <tbody>
                  {(rn.items || []).map((it, idx) => (
                    <tr key={idx}>
                      <td className="font-mono text-slate-500">{idx + 1}</td>
                      <td className="font-mono font-semibold">{it.part_no}</td>
                      <td>{it.make}</td>
                      <td className="text-right font-mono font-bold">{it.quantity}</td>
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

/* --------------------------------------------------------------
   Create view — the form
   -------------------------------------------------------------- */
const emptyItem = () => ({ part_no: "", make: "", quantity: "", makes: [], partLooked: false });

function ReceiptNoteCreate({ editing, onCancel, onSaved }) {
  const isEdit = !!editing;
  const [rnNo, setRnNo] = useState("");
  const [rnDate, setRnDate] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [items, setItems] = useState([emptyItem()]);
  const [addCount, setAddCount] = useState(""); // bulk-add quantity
  const [saving, setSaving] = useState(false);
  const [assignedToUserId, setAssignedToUserId] = useState("");

  // Inline "Create New Master" dialog
  const [masterDialog, setMasterDialog] = useState(null); // { rowIdx, part_no }

  // On mount: either populate from `editing` (edit mode) or fetch next preview (create mode)
  useEffect(() => {
    if (isEdit) {
      setRnNo(editing.rn_no || "");
      setRnDate(editing.rn_date || "");
      setInvoiceNo(editing.invoice_no || "");
      setInvoiceDate(editing.invoice_date || "");
      setAssignedToUserId(editing.assigned_to_user_id || "");
      // Hydrate items with empty makes lists; lookup runs in a separate effect once part_nos are set
      const initial = (editing.items || []).map((it) => ({
        part_no: it.part_no || "",
        make: it.make || "",
        quantity: it.quantity ?? "",
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
            // Ensure the current saved make is included even if no longer in master (rare)
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
    // refresh makes list and select the new make
    setItems((prev) => prev.map((r, idx) => idx === i
      ? { ...r, makes: [...new Set([...(r.makes || []), newItem.make])], make: newItem.make, partLooked: true }
      : r));
    setMasterDialog(null);
    toast.success(`Master created: ${newItem.part_no} / ${newItem.make}`);
  };

  const save = async () => {
    if (items.length === 0) { toast.error("Add at least one item"); return; }
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      if (!it.part_no.trim()) { toast.error(`Row ${idx + 1}: Part No is required`); return; }
      if (!it.make.trim()) { toast.error(`Row ${idx + 1}: Make is required`); return; }
      const q = parseFloat(it.quantity);
      if (isNaN(q) || q <= 0) { toast.error(`Row ${idx + 1}: Quantity must be > 0`); return; }
    }
    setSaving(true);
    try {
      const payload = {
        invoice_no: invoiceNo.trim(),
        invoice_date: invoiceDate || "",
        assigned_to_user_id: assignedToUserId || null,
        items: items.map((it) => ({
          part_no: it.part_no.trim(),
          make: it.make.trim(),
          quantity: parseFloat(it.quantity),
        })),
      };
      const { data } = isEdit
        ? await api.put(`/receipt-notes/${editing.id}`, payload)
        : await api.post("/receipt-notes", payload);
      toast.success(`Receipt Note ${data.rn_no} ${isEdit ? "updated" : "saved"}`);
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save receipt note");
    } finally { setSaving(false); }
  };

  return (
    <div className="mt-4 space-y-6" data-testid="rn-create-view">
      <div className="flex items-center justify-between">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="rn-back-button">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
        <Button onClick={save} disabled={saving} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="rn-save-button">
          <FloppyDisk size={14} weight="bold" className="mr-2" /> {saving ? "Saving…" : (isEdit ? "Update Receipt Note" : "Save Receipt Note")}
        </Button>
      </div>

      {/* HEADER */}
      <div className="bg-white border border-slate-200 rounded-sm p-6 grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div>
          <Label className="label-sm">Receipt Note Date</Label>
          <Input value={rnDate} disabled className="mt-2 rounded-sm font-mono bg-slate-50" data-testid="rn-date-input" />
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
            onChange={(e) => setInvoiceDate(e.target.value)}
            className="mt-2 rounded-sm font-mono"
            data-testid="rn-invoice-date-input"
          />
        </div>
        <div>
          <Label className="label-sm">Invoice No</Label>
          <Input
            value={invoiceNo}
            onChange={(e) => setInvoiceNo(e.target.value)}
            placeholder="e.g. INV-1024"
            className="mt-2 rounded-sm font-mono"
            data-testid="rn-invoice-no-input"
          />
        </div>
        <div className="col-span-2 lg:col-span-2">
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
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <div>
            <div className="label-sm">Items Received</div>
            <div className="text-xs text-slate-500 mt-0.5">{items.length} row{items.length !== 1 ? "s" : ""}</div>
          </div>
          <div className="flex items-center gap-2">
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
              <th>QUANTITY</th>
              <th>MAKE</th>
              <th className="w-14"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => (
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
                    value={it.quantity}
                    onChange={(e) => updateItem(idx, { quantity: e.target.value })}
                    placeholder="0"
                    className="rounded-sm font-mono h-8 text-right"
                    data-testid={`rn-qty-${idx}`}
                  />
                </td>
                <td className="w-64">
                  <MakeDropdown
                    value={it.make}
                    makes={it.makes}
                    partLooked={it.partLooked}
                    onChange={(v) => handleMakeChange(idx, v)}
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
            ))}
          </tbody>
        </table>
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
function MakeDropdown({ value, makes, partLooked, onChange, testid }) {
  // If part not yet looked-up, show disabled placeholder
  if (!partLooked) {
    return (
      <Select disabled value="" onValueChange={() => {}}>
        <SelectTrigger className="rounded-sm h-8 text-xs" data-testid={testid}>
          <SelectValue placeholder="Enter Part No first" />
        </SelectTrigger>
      </Select>
    );
  }
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className="rounded-sm h-8" data-testid={testid}>
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
