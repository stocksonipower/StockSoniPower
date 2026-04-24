import React, { useEffect, useRef, useState } from "react";
import { api, formatApiError } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { toast } from "sonner";
import { Plus, Trash, Buildings, Stack, Archive, Pencil, Check, X, UploadSimple, DownloadSimple } from "@phosphor-icons/react";

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

  const godownFileRef = useRef(null);
  const rackFileRef = useRef(null);
  const boxFileRef = useRef(null);

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
      await api.post("/godowns", { godown_name: newGodown });
      setNewGodown(""); toast.success("Godown added"); loadGodowns();
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
      setNewBox({ box_no: "", box_category: "" }); toast.success("Box added"); loadBoxes(selectedRack);
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
  };

  // ---- Delete ----
  const delGodown = async (id) => { if (window.confirm("Delete godown?")) { await api.delete(`/godowns/${id}`); loadGodowns(); if (selectedGodown === id) setSelectedGodown(null); } };
  const delRack = async (id) => { if (window.confirm("Delete rack?")) { await api.delete(`/racks/${id}`); loadRacks(selectedGodown); if (selectedRack === id) setSelectedRack(null); } };
  const delBox = async (id) => { if (window.confirm("Delete box?")) { await api.delete(`/boxes/${id}`); loadBoxes(selectedRack); } };

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

  return (
    <div className="p-8 max-w-[1600px] mx-auto" data-testid="location-master-page">
      <div className="mb-8">
        <div className="label-sm mb-2">Warehouse</div>
        <h1 className="text-4xl font-black tracking-tight text-slate-900">Location Master</h1>
        <p className="text-sm text-slate-600 mt-2">Godown → Rack → Box hierarchy. Click any item to drill down, hover to edit or delete.</p>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* ====== GODOWNS ====== */}
        <ColumnCard
          title="Godowns" icon={Buildings} count={godowns.length}
          toolbar={
            <>
              <input ref={godownFileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden"
                onChange={(e) => bulkImport(e, "/godowns/bulk-upload", loadGodowns)} data-testid="godown-bulk-upload-input" />
              <ToolbarBtn onClick={() => downloadCsv("/godowns/download/template", "godowns_template.csv")} icon={DownloadSimple} label="Template" testid="godown-template-btn" />
              <ToolbarBtn onClick={() => godownFileRef.current?.click()} icon={UploadSimple} label="Import" testid="godown-import-btn" />
            </>
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
            <ul>
              {godowns.map((g) => (
                <li
                  key={g.id}
                  className={`px-4 py-2.5 border-b border-slate-100 flex items-center gap-2 group ${
                    selectedGodown === g.id ? "bg-slate-900 text-white" : "hover:bg-slate-50 text-slate-800"
                  }`}
                  data-testid={`godown-item-${g.id}`}
                >
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
                        <IconBtn onClick={() => startEdit("godown", g)} dark={selectedGodown === g.id} icon={Pencil} testid={`edit-godown-${g.id}`} />
                        <IconBtn onClick={() => delGodown(g.id)} dark={selectedGodown === g.id} icon={Trash} color="red" testid={`delete-godown-${g.id}`} />
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </ColumnCard>

        {/* ====== RACKS ====== */}
        <ColumnCard
          title="Racks" icon={Stack} count={racks.length}
          disabled={!selectedGodown}
          disabledText="Select a godown"
          toolbar={
            <>
              <input ref={rackFileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden"
                onChange={(e) => bulkImport(e, "/racks/bulk-upload", () => selectedGodown && loadRacks(selectedGodown))} data-testid="rack-bulk-upload-input" />
              <ToolbarBtn onClick={() => downloadCsv("/racks/download/template", "racks_template.csv")} icon={DownloadSimple} label="Template" testid="rack-template-btn" />
              <ToolbarBtn onClick={() => rackFileRef.current?.click()} icon={UploadSimple} label="Import" testid="rack-import-btn" />
            </>
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
            <ul>
              {racks.map((r) => (
                <li
                  key={r.id}
                  className={`px-4 py-2.5 border-b border-slate-100 flex items-center gap-2 group ${
                    selectedRack === r.id ? "bg-slate-900 text-white" : "hover:bg-slate-50 text-slate-800"
                  }`}
                  data-testid={`rack-item-${r.id}`}
                >
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
                        <span className={`ml-2 text-xs ${selectedRack === r.id ? "text-slate-300" : "text-slate-500"}`}>{r.total_boxes} boxes</span>
                      </div>
                      <div className="opacity-0 group-hover:opacity-100 flex gap-1">
                        <IconBtn onClick={() => startEdit("rack", r)} dark={selectedRack === r.id} icon={Pencil} testid={`edit-rack-${r.id}`} />
                        <IconBtn onClick={() => delRack(r.id)} dark={selectedRack === r.id} icon={Trash} color="red" testid={`delete-rack-${r.id}`} />
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </ColumnCard>

        {/* ====== BOXES ====== */}
        <ColumnCard
          title="Boxes" icon={Archive} count={boxes.length}
          disabled={!selectedRack}
          disabledText="Select a rack"
          toolbar={
            <>
              <input ref={boxFileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden"
                onChange={(e) => bulkImport(e, "/boxes/bulk-upload", () => selectedRack && loadBoxes(selectedRack))} data-testid="box-bulk-upload-input" />
              <ToolbarBtn onClick={() => downloadCsv("/boxes/download/template", "boxes_template.csv")} icon={DownloadSimple} label="Template" testid="box-template-btn" />
              <ToolbarBtn onClick={() => boxFileRef.current?.click()} icon={UploadSimple} label="Import" testid="box-import-btn" />
            </>
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
            <ul>
              {boxes.map((b) => (
                <li
                  key={b.id}
                  className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2 group hover:bg-slate-50 text-slate-800"
                  data-testid={`box-item-${b.id}`}
                >
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
          )}
        </ColumnCard>
      </div>
    </div>
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

function ToolbarBtn({ onClick, icon: Icon, label, testid }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-sm border border-slate-200"
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

function IconBtn({ onClick, icon: Icon, color = "slate", dark = false, testid }) {
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
    >
      <Icon size={14} weight="bold" />
    </button>
  );
}
