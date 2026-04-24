import React, { useEffect, useRef, useState } from "react";
import { api, formatApiError } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "../components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "../components/ui/dialog";
import { toast } from "sonner";
import { ArrowDown, Plus, Trash, MagnifyingGlass, X, Image as ImgIcon, Warning } from "@phosphor-icons/react";

/**
 * Stock-In Entry page — new flow.
 * 1. User types one or more PART NOs (only part_no is typeable)
 * 2. Click "Generate Location Summary"
 * 3. Table fills all other fields from Stock Master + current stock locations (from transactions aggregation)
 * 4. Inline Qty + Record IN button per row adds stock to that exact location
 *    (for "not yet in any location" rows, the user picks godown/rack/box inline first)
 */

export default function StockInPage() {
  const [inputs, setInputs] = useState([""]);
  const [rows, setRows] = useState([]);     // flattened display rows
  const [loading, setLoading] = useState(false);
  const [hasGenerated, setHasGenerated] = useState(false);

  const addInput = () => setInputs((p) => [...p, ""]);
  const removeInput = (i) => setInputs((p) => p.filter((_, idx) => idx !== i));
  const setInput = (i, v) => setInputs((p) => p.map((x, idx) => (idx === i ? v : x)));

  const generate = async () => {
    const part_nos = inputs.map((s) => s.trim()).filter(Boolean);
    if (part_nos.length === 0) { toast.error("Enter at least one part number"); return; }
    setLoading(true);
    try {
      const { data } = await api.post("/stock-in/lookup", { part_nos });
      // flatten: for each result, either 1 row (0 or 1 location) or N rows (multi-location)
      const flat = [];
      data.forEach((r) => {
        if (r.not_found) {
          flat.push({ ...r, location: null, isFirstOfGroup: true, groupSize: 1 });
        } else if (!r.locations || r.locations.length === 0) {
          flat.push({ ...r, location: null, isFirstOfGroup: true, groupSize: 1 });
        } else {
          r.locations.forEach((loc, idx) => {
            flat.push({
              ...r,
              location: loc,
              isFirstOfGroup: idx === 0,
              groupSize: r.locations.length,
            });
          });
        }
      });
      setRows(flat);
      setHasGenerated(true);
      if (flat.length === 0) toast.info("No results");
      else toast.success(`${data.length} part number(s) resolved`);
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally { setLoading(false); }
  };

  const clearAll = () => { setInputs([""]); setRows([]); setHasGenerated(false); };

  return (
    <div className="p-8 max-w-[1800px] mx-auto" data-testid="stock-in-page">
      <div className="mb-6 flex items-center gap-4">
        <div className="h-12 w-12 rounded-sm flex items-center justify-center bg-green-50 text-green-700">
          <ArrowDown size={24} weight="bold" />
        </div>
        <div>
          <div className="label-sm mb-1">Transaction</div>
          <h1 className="text-4xl font-black tracking-tight text-slate-900">Stock In</h1>
        </div>
      </div>

      {/* ---------- Part No. entry ---------- */}
      <div className="bg-white border border-slate-200 rounded-sm p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div className="label-sm">Part Numbers</div>
          <div className="text-xs text-slate-500">Type one part number per field. Only PART NO is typeable.</div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
          {inputs.map((val, i) => (
            <div key={i} className="flex gap-1">
              <Input
                value={val}
                onChange={(e) => setInput(i, e.target.value)}
                placeholder={`Part No. #${i + 1}`}
                className="rounded-sm font-mono"
                data-testid={`part-no-input-${i}`}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (i === inputs.length - 1) addInput();
                    setTimeout(() => document.querySelector(`[data-testid="part-no-input-${i + 1}"]`)?.focus(), 50);
                  }
                }}
              />
              {inputs.length > 1 && (
                <button
                  onClick={() => removeInput(i)}
                  className="p-2 text-slate-500 hover:bg-slate-100 rounded-sm"
                  data-testid={`remove-part-${i}`}
                >
                  <X size={14} weight="bold" />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="mt-4 flex gap-2 flex-wrap">
          <Button onClick={addInput} variant="outline" className="rounded-sm border-slate-300" data-testid="add-part-row">
            <Plus size={14} weight="bold" className="mr-2" /> Add Row
          </Button>
          <Button
            onClick={generate}
            disabled={loading}
            className="rounded-sm bg-blue-700 hover:bg-blue-800"
            data-testid="generate-summary-button"
          >
            <MagnifyingGlass size={14} weight="bold" className="mr-2" />
            {loading ? "Generating…" : "Generate Location Summary"}
          </Button>
          {hasGenerated && (
            <Button onClick={clearAll} variant="ghost" className="rounded-sm" data-testid="clear-button">
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* ---------- Summary Table ---------- */}
      {hasGenerated && (
        <SummaryTable rows={rows} onRecorded={generate} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Summary Table                                                      */
/* ------------------------------------------------------------------ */
function SummaryTable({ rows, onRecorded }) {
  const firstMultiIndex = rows.findIndex((r) => r.groupSize > 1 && r.isFirstOfGroup);

  return (
    <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto" data-testid="summary-table-wrap">
      <table className="data-table w-full">
        <thead>
          <tr>
            <th className="w-14">SL NO</th>
            <th>PART NO</th>
            <th>OLD PART NO</th>
            <th>MAKE PART NO</th>
            <th>OEM</th>
            <th>DESCRIPTION 1</th>
            <th>DESCRIPTION 2</th>
            <th>REMARKS</th>
            <th>MAKE</th>
            <th>CATEGORY</th>
            <th>IMAGE</th>
            <th>GODOWN QTY</th>
            <th>GODOWN</th>
            <th>RACK NO</th>
            <th>BOX NO</th>
            <th className="text-right">ACTION</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={16} className="text-center py-12 text-slate-500">No results. Enter part numbers and click Generate.</td></tr>
          )}
          {rows.map((r, i) => {
            const showMultiDivider = i === firstMultiIndex && firstMultiIndex !== -1;
            return (
              <React.Fragment key={i}>
                {showMultiDivider && (
                  <tr className="bg-slate-100">
                    <td colSpan={16} className="py-2 px-3 text-[10px] uppercase tracking-[0.2em] font-bold text-slate-600">
                      Multi-location items
                    </td>
                  </tr>
                )}
                <SummaryRow row={r} idx={i} onRecorded={onRecorded} />
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One row                                                            */
/* ------------------------------------------------------------------ */
function SummaryRow({ row, idx, onRecorded }) {
  const [open, setOpen] = useState(false);
  const showItemCols = row.isFirstOfGroup; // collapse duplicate cols on subsequent rows of same item

  if (row.not_found) {
    return (
      <tr className="bg-red-50/40" data-testid={`row-${idx}-notfound`}>
        <td className="font-mono text-slate-500">{idx + 1}</td>
        <td className="font-mono font-bold text-red-700">{row.part_no}</td>
        <td colSpan={13} className="text-red-700 text-sm">
          <div className="flex items-center gap-2">
            <Warning size={14} weight="bold" /> Not found in Stock Master
          </div>
        </td>
        <td></td>
      </tr>
    );
  }

  const dash = <span className="text-slate-300">—</span>;
  const mono = (v) => <span className="font-mono">{v || dash}</span>;

  const rowClass = row.groupSize > 1 ? "bg-amber-50/30" : "";
  return (
    <>
      <tr className={rowClass} data-testid={`row-${idx}`}>
        <td className="font-mono text-slate-500">{idx + 1}</td>
        <td>{showItemCols ? mono(row.part_no) : <span className="text-slate-300">↳</span>}</td>
        <td>{showItemCols ? mono(row.old_part_no) : ""}</td>
        <td>{showItemCols ? mono(row.make_part_no) : ""}</td>
        <td>{showItemCols ? mono(row.oem) : ""}</td>
        <td className="text-slate-700 max-w-[180px] truncate">{showItemCols ? (row.description_1 || dash) : ""}</td>
        <td className="text-slate-700 max-w-[180px] truncate">{showItemCols ? (row.description_2 || dash) : ""}</td>
        <td className="text-slate-600 max-w-[160px] truncate">{showItemCols ? (row.remarks || dash) : ""}</td>
        <td>{showItemCols ? (row.make || dash) : ""}</td>
        <td>{showItemCols ? (row.item_category || dash) : ""}</td>
        <td>
          {showItemCols && row.image ? (
            <img src={row.image} alt="" className="h-10 w-10 object-cover rounded-sm border border-slate-200" />
          ) : showItemCols ? (
            <div className="h-10 w-10 flex items-center justify-center bg-slate-50 border border-slate-200 rounded-sm text-slate-400">
              <ImgIcon size={14} />
            </div>
          ) : ""}
        </td>
        {/* Location columns */}
        {row.location ? (
          <>
            <td className="font-mono font-bold text-slate-900">{row.location.quantity}</td>
            <td>{row.location.godown_name}</td>
            <td className="font-mono">{row.location.rack_no}</td>
            <td className="font-mono">{row.location.box_no}</td>
          </>
        ) : (
          <>
            <td className="text-slate-400 font-mono">0</td>
            <td colSpan={3} className="text-xs text-slate-500 italic">No existing stock — assign location on record</td>
          </>
        )}
        <td className="text-right">
          <Button
            size="sm"
            variant="outline"
            className="rounded-sm h-7 text-xs border-slate-300"
            onClick={() => setOpen(true)}
            data-testid={`record-in-${idx}`}
          >
            + Record IN
          </Button>
        </td>
      </tr>

      {open && (
        <RecordDialog
          row={row}
          onClose={() => setOpen(false)}
          onSuccess={() => { setOpen(false); onRecorded(); }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Record Stock-IN dialog                                             */
/* ------------------------------------------------------------------ */
function RecordDialog({ row, onClose, onSuccess }) {
  const [qty, setQty] = useState("");
  const [godowns, setGodowns] = useState([]);
  const [racks, setRacks] = useState([]);
  const [boxes, setBoxes] = useState([]);
  const [godownId, setGodownId] = useState(row.location?.godown_id || "");
  const [rackId, setRackId] = useState(row.location?.rack_id || "");
  const [boxId, setBoxId] = useState(row.location?.box_id || "");
  const [saving, setSaving] = useState(false);
  const lockedLocation = !!row.location;

  useEffect(() => { api.get("/godowns").then((r) => setGodowns(r.data)); }, []);
  useEffect(() => {
    if (godownId) api.get("/racks", { params: { godown_id: godownId } }).then((r) => setRacks(r.data));
    else setRacks([]);
    if (!lockedLocation) { setRackId(""); setBoxId(""); }
  }, [godownId, lockedLocation]);
  useEffect(() => {
    if (rackId) api.get("/boxes", { params: { rack_id: rackId } }).then((r) => setBoxes(r.data));
    else setBoxes([]);
    if (!lockedLocation) setBoxId("");
  }, [rackId, lockedLocation]);

  const submit = async () => {
    const q = parseInt(qty);
    if (!q || q <= 0) { toast.error("Quantity must be > 0"); return; }
    if (!godownId || !rackId || !boxId) { toast.error("Select godown, rack and box"); return; }
    setSaving(true);
    try {
      await api.post("/stock-in", {
        part_no: row.part_no,
        make: row.make,
        quantity: q,
        godown_id: godownId,
        rack_id: rackId,
        box_id: boxId,
      });
      toast.success(`Recorded ${q} units of ${row.part_no} IN`);
      onSuccess();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={true} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="rounded-sm max-w-md">
        <DialogHeader>
          <DialogTitle className="text-xl font-black">Record Stock IN</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="bg-slate-50 border border-slate-200 rounded-sm p-3 text-sm">
            <div className="font-mono font-bold text-slate-900">{row.part_no} · {row.make}</div>
            {row.description_1 && <div className="text-xs text-slate-600 mt-1">{row.description_1}</div>}
          </div>
          <div>
            <Label className="label-sm">Godown *</Label>
            <Select value={godownId} onValueChange={setGodownId} disabled={lockedLocation}>
              <SelectTrigger className="mt-1 rounded-sm" data-testid="dialog-godown">
                <SelectValue placeholder="Select godown" />
              </SelectTrigger>
              <SelectContent>
                {godowns.map((g) => <SelectItem key={g.id} value={g.id}>{g.godown_name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="label-sm">Rack *</Label>
            <Select value={rackId} onValueChange={setRackId} disabled={lockedLocation || !godownId}>
              <SelectTrigger className="mt-1 rounded-sm" data-testid="dialog-rack">
                <SelectValue placeholder={godownId ? "Select rack" : "Pick godown first"} />
              </SelectTrigger>
              <SelectContent>
                {racks.map((r) => <SelectItem key={r.id} value={r.id}>Rack {r.rack_no}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="label-sm">Box *</Label>
            <Select value={boxId} onValueChange={setBoxId} disabled={lockedLocation || !rackId}>
              <SelectTrigger className="mt-1 rounded-sm" data-testid="dialog-box">
                <SelectValue placeholder={rackId ? "Select box" : "Pick rack first"} />
              </SelectTrigger>
              <SelectContent>
                {boxes.map((b) => <SelectItem key={b.id} value={b.id}>Box {b.box_no}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="label-sm">Quantity *</Label>
            <Input
              type="number"
              min="1"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="0"
              className="mt-1 rounded-sm font-mono text-lg"
              autoFocus
              data-testid="dialog-qty"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="rounded-sm">Cancel</Button>
          <Button onClick={submit} disabled={saving} className="rounded-sm bg-green-700 hover:bg-green-800" data-testid="dialog-submit">
            {saving ? "Recording…" : "Record IN"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
