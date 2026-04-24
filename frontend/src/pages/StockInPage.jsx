import React, { useEffect, useState } from "react";
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
import { ArrowDown, Plus, Trash, MagnifyingGlass, Image as ImgIcon, Warning } from "@phosphor-icons/react";

/*
  STOCK IN ENTRY
  --------------
  Top grid (editable):
    SL NO (auto) · PART NO (input) · MAKE (select filtered by part_no) · QUANTITY IN (input)

  Click "Generate Summary" →
  Bottom Report shows stock master details + existing location/qty + QTY IN for each entry.
  Single/zero-location items first, multi-location items below.
  "Record IN" button per row commits the stock-in to a chosen location.
*/

const emptyRow = () => ({ part_no: "", make: "", quantity: "", makes: [] });

export default function StockInPage() {
  const [rows, setRows] = useState([emptyRow()]);
  const [report, setReport] = useState([]);        // flattened display rows
  const [hasReport, setHasReport] = useState(false);
  const [loading, setLoading] = useState(false);

  const addRow = () => setRows((p) => [...p, emptyRow()]);
  const removeRow = (i) => setRows((p) => (p.length === 1 ? p : p.filter((_, idx) => idx !== i)));
  const updateRow = (i, patch) => setRows((p) => p.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  // When part_no changes → fetch available makes
  const handlePartNoBlur = async (i, value) => {
    const part_no = (value || "").trim();
    if (!part_no) { updateRow(i, { makes: [], make: "" }); return; }
    try {
      const { data } = await api.get("/stock-master/lookup/makes", { params: { part_no } });
      const makes = data.makes || [];
      updateRow(i, { makes, make: makes.length === 1 ? makes[0] : rows[i].make });
    } catch { updateRow(i, { makes: [] }); }
  };

  const generate = async () => {
    const entries = rows
      .filter((r) => r.part_no.trim() && r.make && parseInt(r.quantity) > 0)
      .map((r) => ({ part_no: r.part_no.trim(), make: r.make, quantity: parseInt(r.quantity) }));
    if (entries.length === 0) { toast.error("Enter at least one row with Part No., Make and Quantity"); return; }
    setLoading(true);
    try {
      const { data } = await api.post("/stock-in/lookup", {
        entries: entries.map((e) => ({ part_no: e.part_no, make: e.make })),
      });
      // Merge user-entered qty_in back into the response by (part_no, make)
      const qtyMap = new Map(entries.map((e) => [`${e.part_no}|${e.make}`, e.quantity]));
      const flat = [];
      data.forEach((r) => {
        const qty_in = qtyMap.get(`${r.part_no}|${r.make}`) ?? 0;
        if (r.not_found || !r.locations || r.locations.length === 0) {
          flat.push({ ...r, qty_in, location: null, isFirstOfGroup: true, groupSize: 1 });
        } else {
          r.locations.forEach((loc, idx) => {
            flat.push({
              ...r,
              qty_in,
              location: loc,
              isFirstOfGroup: idx === 0,
              groupSize: r.locations.length,
            });
          });
        }
      });
      setReport(flat);
      setHasReport(true);
      toast.success(`${data.length} line(s) resolved`);
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally { setLoading(false); }
  };

  const clearAll = () => { setRows([emptyRow()]); setReport([]); setHasReport(false); };

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

      {/* ---------- ENTRY GRID ---------- */}
      <div className="bg-white border border-slate-200 rounded-sm overflow-hidden mb-4" data-testid="entry-grid">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-14">SL NO</th>
              <th>PART NO</th>
              <th>MAKE</th>
              <th>QUANTITY IN</th>
              <th className="w-16 text-right">—</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} data-testid={`entry-row-${i}`}>
                <td className="font-mono text-slate-500">{i + 1}</td>
                <td>
                  <Input
                    value={r.part_no}
                    onChange={(e) => updateRow(i, { part_no: e.target.value })}
                    onBlur={(e) => handlePartNoBlur(i, e.target.value)}
                    placeholder="Enter part number"
                    className="rounded-sm font-mono h-9"
                    data-testid={`entry-part-no-${i}`}
                  />
                </td>
                <td>
                  <Select
                    value={r.make}
                    onValueChange={(v) => updateRow(i, { make: v })}
                    disabled={!r.makes?.length}
                  >
                    <SelectTrigger className="rounded-sm h-9" data-testid={`entry-make-${i}`}>
                      <SelectValue placeholder={r.makes?.length ? "Select make" : (r.part_no ? "No makes found" : "Enter part no. first")} />
                    </SelectTrigger>
                    <SelectContent>
                      {(r.makes || []).map((m) => (
                        <SelectItem key={m} value={m} data-testid={`entry-make-option-${i}-${m}`}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td>
                  <Input
                    type="number"
                    min="1"
                    value={r.quantity}
                    onChange={(e) => updateRow(i, { quantity: e.target.value })}
                    placeholder="0"
                    className="rounded-sm font-mono h-9 w-32"
                    data-testid={`entry-qty-${i}`}
                  />
                </td>
                <td className="text-right">
                  <button
                    onClick={() => removeRow(i)}
                    disabled={rows.length === 1}
                    className="p-1.5 rounded-sm text-red-700 hover:bg-red-50 disabled:text-slate-300 disabled:hover:bg-transparent"
                    data-testid={`entry-remove-${i}`}
                  >
                    <Trash size={14} weight="bold" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex gap-2 flex-wrap mb-8">
        <Button onClick={addRow} variant="outline" className="rounded-sm border-slate-300" data-testid="add-entry-row">
          <Plus size={14} weight="bold" className="mr-2" /> Add Row
        </Button>
        <Button
          onClick={generate}
          disabled={loading}
          className="rounded-sm bg-blue-700 hover:bg-blue-800"
          data-testid="generate-summary-button"
        >
          <MagnifyingGlass size={14} weight="bold" className="mr-2" />
          {loading ? "Generating…" : "Generate Summary"}
        </Button>
        {hasReport && (
          <Button onClick={clearAll} variant="ghost" className="rounded-sm" data-testid="clear-button">Clear</Button>
        )}
      </div>

      {/* ---------- REPORT ---------- */}
      {hasReport && <ReportTable rows={report} onRecorded={generate} />}
    </div>
  );
}

/* ================================================================= */
function ReportTable({ rows, onRecorded }) {
  const firstMultiIndex = rows.findIndex((r) => r.groupSize > 1 && r.isFirstOfGroup);
  return (
    <div>
      <div className="label-sm mb-2">Report</div>
      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto" data-testid="report-table-wrap">
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
              <th>QTY IN</th>
              <th>GODOWN QTY</th>
              <th>GODOWN</th>
              <th>RACK NO</th>
              <th>BOX NO</th>
              <th className="text-right">ACTION</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={17} className="text-center py-12 text-slate-500">No results.</td></tr>
            )}
            {rows.map((r, i) => {
              const showMultiDivider = i === firstMultiIndex && firstMultiIndex !== -1;
              return (
                <React.Fragment key={i}>
                  {showMultiDivider && (
                    <tr className="bg-slate-100">
                      <td colSpan={17} className="py-2 px-3 text-[10px] uppercase tracking-[0.2em] font-bold text-slate-600">
                        Multi-location items
                      </td>
                    </tr>
                  )}
                  <ReportRow row={r} idx={i} onRecorded={onRecorded} />
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReportRow({ row, idx, onRecorded }) {
  const [open, setOpen] = useState(false);
  const showItemCols = row.isFirstOfGroup;

  if (row.not_found) {
    return (
      <tr className="bg-red-50/40" data-testid={`report-row-${idx}-notfound`}>
        <td className="font-mono text-slate-500">{idx + 1}</td>
        <td className="font-mono font-bold text-red-700">{row.part_no}</td>
        <td colSpan={14} className="text-red-700 text-sm">
          <div className="flex items-center gap-2">
            <Warning size={14} weight="bold" /> Not found in Stock Master (make: {row.make || "—"})
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
      <tr className={rowClass} data-testid={`report-row-${idx}`}>
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
        <td>
          {showItemCols
            ? <span className="font-mono font-bold text-green-700">+{row.qty_in}</span>
            : ""}
        </td>
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
            <td colSpan={3} className="text-xs text-slate-500 italic">No existing stock — choose location on record</td>
          </>
        )}
        <td className="text-right">
          <Button
            size="sm" variant="outline"
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

/* ================================================================= */
function RecordDialog({ row, onClose, onSuccess }) {
  const [qty, setQty] = useState(String(row.qty_in || ""));
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
        part_no: row.part_no, make: row.make, quantity: q,
        godown_id: godownId, rack_id: rackId, box_id: boxId,
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
              type="number" min="1" value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="mt-1 rounded-sm font-mono text-lg" autoFocus
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
