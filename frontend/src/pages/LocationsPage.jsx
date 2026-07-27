import React, { useEffect, useRef, useState } from "react";
import { api, formatApiError } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../components/ui/dialog";
import { toast } from "sonner";
import { Checkbox } from "../components/ui/checkbox";
import { Plus, Trash, Buildings, Stack, Archive, Pencil, Check, X, UploadSimple, DownloadSimple, ListNumbers } from "@phosphor-icons/react";

export default function LocationsPage() {
  const [godowns, setGodowns] = useState([]);
  const [racks, setRacks] = useState([]);
  const [boxes, setBoxes] = useState([]);
  const [selectedGodown, setSelectedGodown] = useState(null);
  const [selectedRack, setSelectedRack] = useState(null);

  const [newGodown, setNewGodown] = useState("");
  const [newRack, setNewRack] = useState({ rack_no: "", total_boxes: 0 });
  const [newBox, setNewBox] = useState({ box_no: "", box_category: "" });

  const [editing, setEditing] = useState({ kind: null, id: null, data: {} });

  // Multi-select state
  const [selectedGodownIds, setSelectedGodownIds] = useState(new Set());
  const [selectedRackIds, setSelectedRackIds] = useState(new Set());
  const [selectedBoxIds, setSelectedBoxIds] = useState(new Set());

  // Edit-mode toggles (only when ON, checkboxes appear)
  const [editModeGodown, setEditModeGodown] = useState(false);
  const [editModeRack, setEditModeRack] = useState(false);
  const [editModeBox, setEditModeBox] = useState(false);

  const godownFileRef = useRef(null);
  const rackFileRef = useRef(null);
  const boxFileRef = useRef(null);

  // Range dialogs
  const [rackRangeFor, setRackRangeFor] = useState(null);  // godown obj
  const [boxRangeFor, setBoxRangeFor] = useState(null);    // rack obj

  const downloadCsv = async (path, filename) => {
    try {
      const res = await api.get(path, { responseType: "blob" });
      const url = window.URL.createObjectURL(new Blob([res.data], { type: "text/csv" }));
      const a = document.createElement("a"); a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
      toast.success("Template downloaded");
    } catch { toast.error("Could not download template"); }
  };

  const bulkImport = async (e, path, reload, extra = "") => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData(); fd.append("file", file);
    try {
      const { data } = await api.post(path, fd, { headers: { "Content-Type": "multipart/form-data" } });
      let msg = `Inserted ${data.inserted}, skipped ${data.skipped} of ${data.total_rows} rows`;
      if (data.missing_godowns?.length) msg += ` • Missing godowns: ${data.missing_godowns.join(", ")}`;
      if (data.missing_parents?.length) msg += ` • Missing parents: ${data.missing_parents.slice(0, 3).join(", ")}${data.missing_parents.length > 3 ? "…" : ""}`;
      toast.success(msg);
      reload();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally { e.target.value = ""; }
  };

  const loadGodowns = async () => setGodowns((await api.get("/godowns")).data);
  const loadRacks = async (gid) => setRacks((await api.get("/racks", { params: gid ? { godown_id: gid } : {} })).data);
  const loadBoxes = async (rid) => setBoxes((await api.get("/boxes", { params: rid ? { rack_id: rid } : {} })).data);
  // Any box create/delete changes a rack's live box_count, so the rack list (which
  // displays that count) must refresh alongside the box list — never just the boxes.
  const refreshBoxesAndCounts = async (rid) => {
    await loadBoxes(rid);
    if (selectedGodown) await loadRacks(selectedGodown);
  };

  useEffect(() => { loadGodowns(); }, []);
  useEffect(() => {
    if (selectedGodown) loadRacks(selectedGodown); else setRacks([]);
    setSelectedRack(null); setBoxes([]);
  }, [selectedGodown]);
  useEffect(() => {
    if (selectedRack) loadBoxes(selectedRack); else setBoxes([]);
  }, [selectedRack]);

  // ---- Create ----
  const addGodown = async () => {
    if (!newGodown.trim()) return;
    try {
      const { data } = await api.post("/godowns", { godown_name: newGodown });
      setNewGodown(""); toast.success("Godown added"); await loadGodowns();
      // Auto-open rack range wizard for the new godown
      setRackRangeFor(data);
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
  };
  const addRack = async () => {
    if (!selectedGodown || !newRack.rack_no.trim()) { toast.error("Select a godown and enter rack no."); return; }
    try {
      await api.post("/racks", { godown_id: selectedGodown, rack_no: newRack.rack_no, total_boxes: parseInt(newRack.total_boxes) || 0 });
      setNewRack({ rack_no: "", total_boxes: 0 }); toast.success("Rack added"); loadRacks(selectedGodown);
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
  };
  const addBox = async () => {
    if (!selectedRack || !newBox.box_no.trim()) { toast.error("Select a rack and enter box no."); return; }
    try {
      await api.post("/boxes", { rack_id: selectedRack, box_no: newBox.box_no, box_category: newBox.box_category });
      setNewBox({ box_no: "", box_category: "" }); toast.success("Box added"); refreshBoxesAndCounts(selectedRack);
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
  };

  // ---- Delete ----
  const delGodown = async (id) => { if (window.confirm("Delete godown?")) { await api.delete(`/godowns/${id}`); loadGodowns(); if (selectedGodown === id) setSelectedGodown(null); } };
  const delRack = async (id) => { if (window.confirm("Delete rack?")) { await api.delete(`/racks/${id}`); loadRacks(selectedGodown); if (selectedRack === id) setSelectedRack(null); } };
  const delBox = async (id) => { if (window.confirm("Delete box?")) { await api.delete(`/boxes/${id}`); refreshBoxesAndCounts(selectedRack); } };

  // ---- Bulk select helpers ----
  const toggleSet = (set, id) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  };
  const toggleAll = (set, items) => {
    const selectable = items.filter((x) => !x.in_use);
    if (set.size === selectable.length && selectable.length > 0) return new Set();
    return new Set(selectable.map((x) => x.id));
  };

  const bulkDelete = async (kind, ids, reload, clear) => {
    if (ids.size === 0) return;
    if (!window.confirm(`Delete ${ids.size} ${kind}(s)? This cannot be undone.`)) return;
    try {
      const { data } = await api.post(`/${kind}/bulk-delete`, { ids: [...ids] });
      const blocked = data.blocked || 0;
      let msg = `Deleted ${data.deleted} ${kind}`;
      if (blocked) msg += ` • ${blocked} skipped (in use by stock entries)`;
      blocked ? toast.warning(msg) : toast.success(msg);
      clear(new Set());
      reload();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  // ---- Edit ----
  const startEdit = (kind, item) => {
    if (kind === "godown") setEditing({ kind, id: item.id, data: { godown_name: item.godown_name } });
    else if (kind === "rack") setEditing({ kind, id: item.id, data: { rack_no: item.rack_no, total_boxes: item.total_boxes } });
    else if (kind === "box") setEditing({ kind, id: item.id, data: { box_no: item.box_no, box_category: item.box_category || "" } });
  };
  const cancelEdit = () => setEditing({ kind: null, id: null, data: {} });
  const saveEdit = async () => {
    try {
      if (editing.kind === "godown") {
        if (!editing.data.godown_name?.trim()) return toast.error("Name required");
        await api.put(`/godowns/${editing.id}`, { godown_name: editing.data.godown_name });
        loadGodowns();
      } else if (editing.kind === "rack") {
        if (!editing.data.rack_no?.trim()) return toast.error("Rack no required");
        await api.put(`/racks/${editing.id}`, {
          rack_no: editing.data.rack_no,
          total_boxes: parseInt(editing.data.total_boxes) || 0,
        });
        loadRacks(selectedGodown);
      } else if (editing.kind === "box") {
        if (!editing.data.box_no?.trim()) return toast.error("Box no required");
        await api.put(`/boxes/${editing.id}`, {
          box_no: editing.data.box_no,
          box_category: editing.data.box_category || "",
        });
        loadBoxes(selectedRack);
      }
      toast.success("Updated"); cancelEdit();
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
  };

  const isEditing = (kind, id) => editing.kind === kind && editing.id === id;

  // Reset child selections when parent changes
  useEffect(() => { setSelectedRackIds(new Set()); setSelectedBoxIds(new Set()); }, [selectedGodown]);
  useEffect(() => { setSelectedBoxIds(new Set()); }, [selectedRack]);

  return (
    <div className="p-8 max-w-[1600px] mx-auto" data-testid="location-master-page">
      <div className="mb-8">
        <div className="label-sm mb-2">Warehouse</div>
        <h1 className="text-4xl font-black tracking-tight text-slate-900">Location Master</h1>
        <p className="text-sm text-slate-600 mt-2"> </p>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* ====== GODOWNS ====== */}
        <ColumnCard
          title="Godowns" icon={Buildings} count={godowns.length}
          toolbar={
            <ToolbarBtn
              onClick={() => { setEditModeGodown((v) => !v); setSelectedGodownIds(new Set()); }}
              icon={Pencil}
              label={editModeGodown ? "Done" : "Edit"}
              active={editModeGodown}
              testid="godown-edit-toggle"
            />
          }
          form={
            <div className="flex gap-2">
              <Input value={newGodown} onChange={(e) => setNewGodown(e.target.value)} placeholder="Godown name" className="rounded-sm" data-testid="new-godown-input" onKeyDown={(e) => e.key === "Enter" && addGodown()} />
              <Button onClick={addGodown} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="add-godown-button">
                <Plus size={14} weight="bold" />
              </Button>
            </div>
          }
        >
          {godowns.length === 0 ? (
            <EmptyState text="No godowns yet. Add one above." />
          ) : (
            <>
              {editModeGodown && (
                <SelectAllBar
                  count={selectedGodownIds.size}
                  totalSelectable={godowns.filter((x) => !x.in_use).length}
                  onToggleAll={() => setSelectedGodownIds((s) => toggleAll(s, godowns))}
                  onBulkDelete={() => bulkDelete("godowns", selectedGodownIds, loadGodowns, setSelectedGodownIds)}
                  testidPrefix="godown"
                />
              )}
              <ul>
                {godowns.map((g) => (
                  <li
                    key={g.id}
                    className={`px-4 py-2.5 border-b border-slate-100 flex items-center gap-2 group ${
                      selectedGodown === g.id ? "bg-slate-900 text-white" : "hover:bg-slate-50 text-slate-800"
                    }`}
                    data-testid={`godown-item-${g.id}`}
                  >
                    {editModeGodown && (
                      <Checkbox
                        checked={selectedGodownIds.has(g.id)}
                        disabled={g.in_use}
                        onCheckedChange={() => !g.in_use && setSelectedGodownIds((s) => toggleSet(s, g.id))}
                        onClick={(e) => e.stopPropagation()}
                        className={selectedGodown === g.id ? "border-white data-[state=checked]:bg-white data-[state=checked]:text-slate-900" : ""}
                        data-testid={`select-godown-${g.id}`}
                        title={g.in_use ? "In use by stock entries" : ""}
                      />
                    )}
                    {isEditing("godown", g.id) ? (
                    <>
                      <Input
                        value={editing.data.godown_name}
                        onChange={(e) => setEditing({ ...editing, data: { ...editing.data, godown_name: e.target.value } })}
                        className="rounded-sm h-8 text-sm"
                        autoFocus
                        onKeyDown={(e) => e.key === "Enter" && saveEdit()}
                        data-testid={`edit-godown-input-${g.id}`}
                      />
                      <IconBtn onClick={saveEdit} dark={selectedGodown === g.id} icon={Check} color="green" testid={`save-godown-${g.id}`} />
                      <IconBtn onClick={cancelEdit} dark={selectedGodown === g.id} icon={X} testid={`cancel-godown-${g.id}`} />
                    </>
                  ) : (
                    <>
                      <div className="flex-1 cursor-pointer" onClick={() => setSelectedGodown(g.id)}>
                        <span className="font-semibold">{g.godown_name}</span>
                      </div>
                      <div className="opacity-0 group-hover:opacity-100 flex gap-1">
                        <IconBtn onClick={() => setRackRangeFor(g)} dark={selectedGodown === g.id} icon={ListNumbers} testid={`range-racks-${g.id}`} title="Add Rack Range" />
                        <IconBtn onClick={() => startEdit("godown", g)} dark={selectedGodown === g.id} icon={Pencil} testid={`edit-godown-${g.id}`} />
                        <IconBtn onClick={() => delGodown(g.id)} dark={selectedGodown === g.id} icon={Trash} color="red" testid={`delete-godown-${g.id}`} />
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
            </>
          )}
        </ColumnCard>

        {/* ====== RACKS ====== */}
        <ColumnCard
          title="Racks" icon={Stack} count={racks.length}
          disabled={!selectedGodown}
          disabledText="Select a godown"
          toolbar={
            <ToolbarBtn
              onClick={() => { setEditModeRack((v) => !v); setSelectedRackIds(new Set()); }}
              icon={Pencil}
              label={editModeRack ? "Done" : "Edit"}
              active={editModeRack}
              testid="rack-edit-toggle"
            />
          }
          form={
            <div className="flex gap-2">
              <Input value={newRack.rack_no} onChange={(e) => setNewRack({ ...newRack, rack_no: e.target.value })} placeholder="Rack no." className="rounded-sm" disabled={!selectedGodown} data-testid="new-rack-no-input" />
              <Input value={newRack.total_boxes} onChange={(e) => setNewRack({ ...newRack, total_boxes: e.target.value })} placeholder="Total" type="number" className="rounded-sm w-20" disabled={!selectedGodown} data-testid="new-rack-total-input" />
              <Button onClick={addRack} className="rounded-sm bg-blue-700 hover:bg-blue-800" disabled={!selectedGodown} data-testid="add-rack-button">
                <Plus size={14} weight="bold" />
              </Button>
            </div>
          }
        >
          {!selectedGodown ? null : racks.length === 0 ? (
            <EmptyState text="No racks. Add one above." />
          ) : (
            <>
              {editModeRack && (
                <SelectAllBar
                  count={selectedRackIds.size}
                  totalSelectable={racks.filter((x) => !x.in_use).length}
                  onToggleAll={() => setSelectedRackIds((s) => toggleAll(s, racks))}
                  onBulkDelete={() => bulkDelete("racks", selectedRackIds, () => loadRacks(selectedGodown), setSelectedRackIds)}
                  testidPrefix="rack"
                />
              )}
              <ul>
              {racks.map((r) => (
                <li
                  key={r.id}
                  className={`px-4 py-2.5 border-b border-slate-100 flex items-center gap-2 group ${
                    selectedRack === r.id ? "bg-slate-900 text-white" : "hover:bg-slate-50 text-slate-800"
                  }`}
                  data-testid={`rack-item-${r.id}`}
                >
                  {editModeRack && (
                    <Checkbox
                      checked={selectedRackIds.has(r.id)}
                      disabled={r.in_use}
                      onCheckedChange={() => !r.in_use && setSelectedRackIds((s) => toggleSet(s, r.id))}
                      onClick={(e) => e.stopPropagation()}
                      className={selectedRack === r.id ? "border-white data-[state=checked]:bg-white data-[state=checked]:text-slate-900" : ""}
                      data-testid={`select-rack-${r.id}`}
                      title={r.in_use ? "In use by stock entries" : ""}
                    />
                  )}
                  {isEditing("rack", r.id) ? (
                    <>
                      <Input
                        value={editing.data.rack_no}
                        onChange={(e) => setEditing({ ...editing, data: { ...editing.data, rack_no: e.target.value } })}
                        placeholder="Rack no."
                        className="rounded-sm h-8 text-sm font-mono flex-1"
                        autoFocus
                        data-testid={`edit-rack-no-input-${r.id}`}
                      />
                      <Input
                        type="number"
                        value={editing.data.total_boxes}
                        onChange={(e) => setEditing({ ...editing, data: { ...editing.data, total_boxes: e.target.value } })}
                        className="rounded-sm h-8 text-sm w-16 font-mono"
                        data-testid={`edit-rack-total-input-${r.id}`}
                      />
                      <IconBtn onClick={saveEdit} dark={selectedRack === r.id} icon={Check} color="green" testid={`save-rack-${r.id}`} />
                      <IconBtn onClick={cancelEdit} dark={selectedRack === r.id} icon={X} testid={`cancel-rack-${r.id}`} />
                    </>
                  ) : (
                    <>
                      <div className="flex-1 cursor-pointer" onClick={() => setSelectedRack(r.id)}>
                        <span className="font-mono font-semibold">Rack {r.rack_no}</span>
                        <span className={`ml-2 text-xs ${selectedRack === r.id ? "text-slate-300" : "text-slate-500"}`}>{r.box_count ?? 0} boxes</span>
                      </div>
                      <div className="opacity-0 group-hover:opacity-100 flex gap-1">
                        <IconBtn onClick={() => setBoxRangeFor(r)} dark={selectedRack === r.id} icon={ListNumbers} testid={`range-boxes-${r.id}`} title="Add Box Range" />
                        <IconBtn onClick={() => startEdit("rack", r)} dark={selectedRack === r.id} icon={Pencil} testid={`edit-rack-${r.id}`} />
                        <IconBtn onClick={() => delRack(r.id)} dark={selectedRack === r.id} icon={Trash} color="red" testid={`delete-rack-${r.id}`} />
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
            </>
          )}
        </ColumnCard>

        {/* ====== BOXES ====== */}
        <ColumnCard
          title="Boxes" icon={Archive} count={boxes.length}
          disabled={!selectedRack}
          disabledText="Select a rack"
          toolbar={
            <ToolbarBtn
              onClick={() => { setEditModeBox((v) => !v); setSelectedBoxIds(new Set()); }}
              icon={Pencil}
              label={editModeBox ? "Done" : "Edit"}
              active={editModeBox}
              testid="box-edit-toggle"
            />
          }
          form={
            <div className="flex gap-2">
              <Input value={newBox.box_no} onChange={(e) => setNewBox({ ...newBox, box_no: e.target.value })} placeholder="Box no." className="rounded-sm" disabled={!selectedRack} data-testid="new-box-no-input" />
              <Input value={newBox.box_category} onChange={(e) => setNewBox({ ...newBox, box_category: e.target.value })} placeholder="Category" className="rounded-sm" disabled={!selectedRack} data-testid="new-box-category-input" />
              <Button onClick={addBox} className="rounded-sm bg-blue-700 hover:bg-blue-800" disabled={!selectedRack} data-testid="add-box-button">
                <Plus size={14} weight="bold" />
              </Button>
            </div>
          }
        >
          {!selectedRack ? null : boxes.length === 0 ? (
            <EmptyState text="No boxes. Add one above." />
          ) : (
            <>
              {editModeBox && (
                <SelectAllBar
                  count={selectedBoxIds.size}
                  totalSelectable={boxes.filter((x) => !x.in_use).length}
                  onToggleAll={() => setSelectedBoxIds((s) => toggleAll(s, boxes))}
                  onBulkDelete={() => bulkDelete("boxes", selectedBoxIds, () => refreshBoxesAndCounts(selectedRack), setSelectedBoxIds)}
                  testidPrefix="box"
                />
              )}
              <ul>
                {boxes.map((b) => (
                  <li
                    key={b.id}
                    className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2 group hover:bg-slate-50 text-slate-800"
                    data-testid={`box-item-${b.id}`}
                  >
                    {editModeBox && (
                      <Checkbox
                        checked={selectedBoxIds.has(b.id)}
                        disabled={b.in_use}
                        onCheckedChange={() => !b.in_use && setSelectedBoxIds((s) => toggleSet(s, b.id))}
                        onClick={(e) => e.stopPropagation()}
                        data-testid={`select-box-${b.id}`}
                        title={b.in_use ? "In use by stock entries" : ""}
                      />
                    )}
                    {isEditing("box", b.id) ? (
                    <>
                      <Input
                        value={editing.data.box_no}
                        onChange={(e) => setEditing({ ...editing, data: { ...editing.data, box_no: e.target.value } })}
                        placeholder="Box no."
                        className="rounded-sm h-8 text-sm font-mono w-24"
                        autoFocus
                        data-testid={`edit-box-no-input-${b.id}`}
                      />
                      <Input
                        value={editing.data.box_category}
                        onChange={(e) => setEditing({ ...editing, data: { ...editing.data, box_category: e.target.value } })}
                        placeholder="Category"
                        className="rounded-sm h-8 text-sm flex-1"
                        data-testid={`edit-box-category-input-${b.id}`}
                      />
                      <IconBtn onClick={saveEdit} icon={Check} color="green" testid={`save-box-${b.id}`} />
                      <IconBtn onClick={cancelEdit} icon={X} testid={`cancel-box-${b.id}`} />
                    </>
                  ) : (
                    <>
                      <div className="flex-1">
                        <span className="font-mono font-semibold">Box {b.box_no}</span>
                        {b.box_category && <span className="ml-2 text-xs text-slate-500">{b.box_category}</span>}
                      </div>
                      <div className="opacity-0 group-hover:opacity-100 flex gap-1">
                        <IconBtn onClick={() => startEdit("box", b)} icon={Pencil} testid={`edit-box-${b.id}`} />
                        <IconBtn onClick={() => delBox(b.id)} icon={Trash} color="red" testid={`delete-box-${b.id}`} />
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
            </>
          )}
        </ColumnCard>
      </div>

      {rackRangeFor && (
        <RackRangeDialog
          godown={rackRangeFor}
          onClose={() => setRackRangeFor(null)}
          onSuccess={() => {
            setRackRangeFor(null);
            if (selectedGodown === rackRangeFor.id) loadRacks(selectedGodown);
            else { setSelectedGodown(rackRangeFor.id); }
          }}
        />
      )}

      {boxRangeFor && (
        <BoxRangeDialog
          rack={boxRangeFor}
          onClose={() => setBoxRangeFor(null)}
          onSuccess={() => {
            setBoxRangeFor(null);
            // A range-create adds boxes, which changes the rack's live box_count.
            if (selectedGodown) loadRacks(selectedGodown);
            if (selectedRack === boxRangeFor.id) loadBoxes(selectedRack);
            else { setSelectedRack(boxRangeFor.id); }
          }}
        />
      )}
    </div>
  );
}

/* ============= Range Dialogs ============= */
function RackRangeDialog({ godown, onClose, onSuccess }) {
  const [start, setStart] = useState("1");
  const [end, setEnd] = useState("");
  const [prefix, setPrefix] = useState("");
  const [totalBoxes, setTotalBoxes] = useState("0");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const s = parseInt(start), e = parseInt(end);
    if (!s || !e || e < s) { toast.error("Enter valid Start and End numbers (End ≥ Start)"); return; }
    setSaving(true);
    try {
      const { data } = await api.post("/racks/range", {
        godown_id: godown.id,
        start: s, end: e,
        prefix: prefix || "",
        total_boxes: parseInt(totalBoxes) || 0,
      });
      toast.success(`Created ${data.inserted} rack(s)${data.skipped ? `, ${data.skipped} skipped` : ""}`);
      onSuccess();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={true} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="rounded-sm max-w-md">
        <DialogHeader>
          <DialogTitle className="text-xl font-black">Add Racks to {godown.godown_name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Enter the starting and ending rack numbers. All numbers in between will be created.</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="label-sm">Starting No. *</Label>
              <Input type="number" min="1" value={start} onChange={(e) => setStart(e.target.value)} className="mt-1 rounded-sm font-mono" autoFocus data-testid="rack-range-start" />
            </div>
            <div>
              <Label className="label-sm">Ending No. *</Label>
              <Input type="number" min="1" value={end} onChange={(e) => setEnd(e.target.value)} placeholder="e.g. 35" className="mt-1 rounded-sm font-mono" data-testid="rack-range-end" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="label-sm">Prefix (optional)</Label>
              <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="e.g. R → R1, R2…" className="mt-1 rounded-sm" data-testid="rack-range-prefix" />
            </div>
            <div>
              <Label className="label-sm">Total Boxes / Rack</Label>
              <Input type="number" min="0" value={totalBoxes} onChange={(e) => setTotalBoxes(e.target.value)} className="mt-1 rounded-sm font-mono" data-testid="rack-range-total" />
            </div>
          </div>
          <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-sm p-2">
            Will create racks: <span className="font-mono font-semibold">{prefix}{start || "?"}</span> through <span className="font-mono font-semibold">{prefix}{end || "?"}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="rounded-sm">Skip</Button>
          <Button onClick={submit} disabled={saving} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="rack-range-submit">
            {saving ? "Creating…" : "Create Racks"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BoxRangeDialog({ rack, onClose, onSuccess }) {
  const [start, setStart] = useState("1");
  const [end, setEnd] = useState("");
  const [prefix, setPrefix] = useState("");
  const [category, setCategory] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const s = parseInt(start), e = parseInt(end);
    if (!s || !e || e < s) { toast.error("Enter valid Start and End numbers (End ≥ Start)"); return; }
    setSaving(true);
    try {
      const { data } = await api.post("/boxes/range", {
        rack_id: rack.id,
        start: s, end: e,
        prefix: prefix || "",
        box_category: category || "",
      });
      toast.success(`Created ${data.inserted} box(es)${data.skipped ? `, ${data.skipped} skipped` : ""}. Categories can be edited per box.`);
      onSuccess();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={true} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="rounded-sm max-w-md">
        <DialogHeader>
          <DialogTitle className="text-xl font-black">Add Boxes to Rack {rack.rack_no}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Enter the starting and ending box numbers. Each box's category can be edited individually after creation.</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="label-sm">Starting No. *</Label>
              <Input type="number" min="1" value={start} onChange={(e) => setStart(e.target.value)} className="mt-1 rounded-sm font-mono" autoFocus data-testid="box-range-start" />
            </div>
            <div>
              <Label className="label-sm">Ending No. *</Label>
              <Input type="number" min="1" value={end} onChange={(e) => setEnd(e.target.value)} placeholder="e.g. 12" className="mt-1 rounded-sm font-mono" data-testid="box-range-end" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="label-sm">Prefix (optional)</Label>
              <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="e.g. B → B1, B2…" className="mt-1 rounded-sm" data-testid="box-range-prefix" />
            </div>
            <div>
              <Label className="label-sm">Default Category (optional)</Label>
              <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="set per-box later" className="mt-1 rounded-sm" data-testid="box-range-category" />
            </div>
          </div>
          <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-sm p-2">
            Will create boxes: <span className="font-mono font-semibold">{prefix}{start || "?"}</span> through <span className="font-mono font-semibold">{prefix}{end || "?"}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="rounded-sm">Skip</Button>
          <Button onClick={submit} disabled={saving} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="box-range-submit">
            {saving ? "Creating…" : "Create Boxes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


function ColumnCard({ title, icon: Icon, count, form, disabled, disabledText, toolbar, children }) {
  return (
    <div className="bg-white border border-slate-200 rounded-sm flex flex-col h-[calc(100vh-220px)]">
      <div className="px-5 py-3 border-b border-slate-200 flex items-center gap-3">
        <Icon size={18} weight="bold" className="text-slate-700" />
        <h2 className="font-bold text-slate-900">{title}</h2>
        <span className="text-xs font-mono text-slate-500">{count}</span>
        <div className="ml-auto flex gap-1">{toolbar}</div>
      </div>
      <div className="p-3 border-b border-slate-200">{form}</div>
      <div className="flex-1 overflow-y-auto">
        {disabled ? <div className="p-8 text-center text-sm text-slate-400">{disabledText}</div> : children}
      </div>
    </div>
  );
}

function ToolbarBtn({ onClick, icon: Icon, label, testid, active }) {
  const cls = active
    ? "bg-slate-900 text-white border-slate-900"
    : "text-slate-600 hover:text-slate-900 hover:bg-slate-100 border-slate-200";
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider rounded-sm border ${cls}`}
      data-testid={testid}
      title={label}
    >
      <Icon size={12} weight="bold" /> {label}
    </button>
  );
}

function EmptyState({ text }) {
  return <div className="p-8 text-center text-sm text-slate-400">{text}</div>;
}

function SelectAllBar({ count, totalSelectable, onToggleAll, onBulkDelete, testidPrefix }) {
  const allChecked = count === totalSelectable && totalSelectable > 0;
  const someChecked = count > 0 && count < totalSelectable;
  return (
    <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 flex items-center gap-2 sticky top-0 z-10">
      <Checkbox
        checked={allChecked}
        data-state={allChecked ? "checked" : someChecked ? "indeterminate" : "unchecked"}
        onCheckedChange={onToggleAll}
        disabled={totalSelectable === 0}
        data-testid={`select-all-${testidPrefix}`}
      />
      <span className="text-[11px] uppercase tracking-[0.15em] font-bold text-slate-500">
        {count > 0 ? `${count} selected` : `Select all (${totalSelectable})`}
      </span>
      {count > 0 && (
        <button
          onClick={onBulkDelete}
          className="ml-auto flex items-center gap-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-red-700 hover:bg-red-50 rounded-sm border border-red-200"
          data-testid={`bulk-delete-${testidPrefix}`}
        >
          <Trash size={12} weight="bold" /> Delete {count}
        </button>
      )}
    </div>
  );
}

function IconBtn({ onClick, icon: Icon, color = "slate", dark = false, testid, title }) {
  const colorClass = color === "red"
    ? (dark ? "text-white hover:bg-red-600" : "text-red-700 hover:bg-red-50")
    : color === "green"
    ? (dark ? "text-white hover:bg-green-600" : "text-green-700 hover:bg-green-50")
    : (dark ? "text-white hover:bg-slate-700" : "text-slate-600 hover:bg-slate-100");
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`p-1.5 rounded-sm ${colorClass}`}
      data-testid={testid}
      title={title}
    >
      <Icon size={14} weight="bold" />
    </button>
  );
}
