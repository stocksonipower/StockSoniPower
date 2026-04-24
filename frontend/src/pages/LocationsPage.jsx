import React, { useEffect, useState } from "react";
import { api, formatApiError } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "../components/ui/select";
import { toast } from "sonner";
import { Plus, Trash, Buildings, Stack, Archive } from "@phosphor-icons/react";

export default function LocationsPage() {
  const [godowns, setGodowns] = useState([]);
  const [racks, setRacks] = useState([]);
  const [boxes, setBoxes] = useState([]);
  const [selectedGodown, setSelectedGodown] = useState(null);
  const [selectedRack, setSelectedRack] = useState(null);

  const [newGodown, setNewGodown] = useState("");
  const [newRack, setNewRack] = useState({ rack_no: "", total_boxes: 0 });
  const [newBox, setNewBox] = useState({ box_no: "", box_category: "" });

  const loadGodowns = async () => {
    const { data } = await api.get("/godowns");
    setGodowns(data);
  };
  const loadRacks = async (gid) => {
    const { data } = await api.get("/racks", { params: gid ? { godown_id: gid } : {} });
    setRacks(data);
  };
  const loadBoxes = async (rid) => {
    const { data } = await api.get("/boxes", { params: rid ? { rack_id: rid } : {} });
    setBoxes(data);
  };

  useEffect(() => { loadGodowns(); }, []);
  useEffect(() => {
    if (selectedGodown) loadRacks(selectedGodown);
    else setRacks([]);
    setSelectedRack(null);
    setBoxes([]);
  }, [selectedGodown]);
  useEffect(() => {
    if (selectedRack) loadBoxes(selectedRack);
    else setBoxes([]);
  }, [selectedRack]);

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

  const delGodown = async (id) => { if (window.confirm("Delete godown?")) { await api.delete(`/godowns/${id}`); loadGodowns(); if (selectedGodown === id) setSelectedGodown(null); } };
  const delRack = async (id) => { if (window.confirm("Delete rack?")) { await api.delete(`/racks/${id}`); loadRacks(selectedGodown); if (selectedRack === id) setSelectedRack(null); } };
  const delBox = async (id) => { if (window.confirm("Delete box?")) { await api.delete(`/boxes/${id}`); loadBoxes(selectedRack); } };

  return (
    <div className="p-8 max-w-[1600px] mx-auto" data-testid="locations-page">
      <div className="mb-8">
        <div className="label-sm mb-2">Warehouse</div>
        <h1 className="text-4xl font-black tracking-tight text-slate-900">Locations</h1>
        <p className="text-sm text-slate-600 mt-2">Godown → Rack → Box hierarchy</p>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Godowns */}
        <Column
          title="Godowns"
          icon={Buildings}
          items={godowns}
          selectedId={selectedGodown}
          onSelect={setSelectedGodown}
          renderLabel={(g) => g.godown_name}
          onDelete={delGodown}
          testidPrefix="godown"
          form={
            <div className="flex gap-2">
              <Input value={newGodown} onChange={(e) => setNewGodown(e.target.value)} placeholder="Godown name" className="rounded-sm" data-testid="new-godown-input" />
              <Button onClick={addGodown} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="add-godown-button">
                <Plus size={14} weight="bold" />
              </Button>
            </div>
          }
        />

        {/* Racks */}
        <Column
          title="Racks"
          icon={Stack}
          items={racks}
          selectedId={selectedRack}
          onSelect={setSelectedRack}
          renderLabel={(r) => (
            <>
              <span className="font-mono font-semibold">Rack {r.rack_no}</span>
              <span className="ml-2 text-xs text-slate-500">{r.total_boxes} boxes</span>
            </>
          )}
          onDelete={delRack}
          disabled={!selectedGodown}
          disabledText="Select a godown"
          testidPrefix="rack"
          form={
            <div className="flex gap-2">
              <Input value={newRack.rack_no} onChange={(e) => setNewRack({ ...newRack, rack_no: e.target.value })} placeholder="Rack no." className="rounded-sm" disabled={!selectedGodown} data-testid="new-rack-no-input" />
              <Input value={newRack.total_boxes} onChange={(e) => setNewRack({ ...newRack, total_boxes: e.target.value })} placeholder="Total" type="number" className="rounded-sm w-20" disabled={!selectedGodown} data-testid="new-rack-total-input" />
              <Button onClick={addRack} className="rounded-sm bg-blue-700 hover:bg-blue-800" disabled={!selectedGodown} data-testid="add-rack-button">
                <Plus size={14} weight="bold" />
              </Button>
            </div>
          }
        />

        {/* Boxes */}
        <Column
          title="Boxes"
          icon={Archive}
          items={boxes}
          selectedId={null}
          onSelect={() => {}}
          renderLabel={(b) => (
            <>
              <span className="font-mono font-semibold">Box {b.box_no}</span>
              {b.box_category && <span className="ml-2 text-xs text-slate-500">{b.box_category}</span>}
            </>
          )}
          onDelete={delBox}
          disabled={!selectedRack}
          disabledText="Select a rack"
          testidPrefix="box"
          form={
            <div className="flex gap-2">
              <Input value={newBox.box_no} onChange={(e) => setNewBox({ ...newBox, box_no: e.target.value })} placeholder="Box no." className="rounded-sm" disabled={!selectedRack} data-testid="new-box-no-input" />
              <Input value={newBox.box_category} onChange={(e) => setNewBox({ ...newBox, box_category: e.target.value })} placeholder="Category" className="rounded-sm" disabled={!selectedRack} data-testid="new-box-category-input" />
              <Button onClick={addBox} className="rounded-sm bg-blue-700 hover:bg-blue-800" disabled={!selectedRack} data-testid="add-box-button">
                <Plus size={14} weight="bold" />
              </Button>
            </div>
          }
        />
      </div>
    </div>
  );
}

function Column({ title, icon: Icon, items, selectedId, onSelect, renderLabel, onDelete, form, disabled, disabledText, testidPrefix }) {
  return (
    <div className="bg-white border border-slate-200 rounded-sm flex flex-col h-[calc(100vh-220px)]">
      <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3">
        <Icon size={18} weight="bold" className="text-slate-700" />
        <h2 className="font-bold text-slate-900">{title}</h2>
        <span className="ml-auto text-xs font-mono text-slate-500">{items.length}</span>
      </div>
      <div className="p-3 border-b border-slate-200">{form}</div>
      <div className="flex-1 overflow-y-auto">
        {disabled ? (
          <div className="p-8 text-center text-sm text-slate-400">{disabledText}</div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">No {title.toLowerCase()} yet.</div>
        ) : (
          <ul>
            {items.map((it) => (
              <li
                key={it.id}
                onClick={() => onSelect(it.id)}
                className={`px-4 py-2.5 border-b border-slate-100 flex items-center justify-between cursor-pointer group ${
                  selectedId === it.id ? "bg-slate-900 text-white" : "hover:bg-slate-50 text-slate-800"
                }`}
                data-testid={`${testidPrefix}-item-${it.id}`}
              >
                <div className="flex-1">{renderLabel(it)}</div>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(it.id); }}
                  className={`opacity-0 group-hover:opacity-100 p-1 rounded-sm ${selectedId === it.id ? "text-white hover:bg-slate-700" : "text-red-700 hover:bg-red-50"}`}
                  data-testid={`${testidPrefix}-delete-${it.id}`}
                >
                  <Trash size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
