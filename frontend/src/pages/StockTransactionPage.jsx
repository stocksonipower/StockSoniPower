import React, { useEffect, useState } from "react";
import { api, formatApiError } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "../components/ui/select";
import { toast } from "sonner";
import { ArrowDown, ArrowUp } from "@phosphor-icons/react";

export default function StockTransactionPage({ type = "IN" }) {
  const [partNo, setPartNo] = useState("");
  const [makes, setMakes] = useState([]);
  const [make, setMake] = useState("");
  const [item, setItem] = useState(null);
  const [quantity, setQuantity] = useState("");
  const [godowns, setGodowns] = useState([]);
  const [racks, setRacks] = useState([]);
  const [boxes, setBoxes] = useState([]);
  const [godownId, setGodownId] = useState("");
  const [rackId, setRackId] = useState("");
  const [boxId, setBoxId] = useState("");
  const [boxCategory, setBoxCategory] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isOut = type === "OUT";

  useEffect(() => { api.get("/godowns").then((r) => setGodowns(r.data)); }, []);

  // Part no → fetch makes
  useEffect(() => {
    setMake(""); setItem(null); setMakes([]);
    if (!partNo.trim()) return;
    const t = setTimeout(() => {
      api.get("/stock-master/lookup/makes", { params: { part_no: partNo.trim() } })
        .then((r) => setMakes(r.data.makes || []))
        .catch(() => setMakes([]));
    }, 300);
    return () => clearTimeout(t);
  }, [partNo]);

  // Part+Make → fetch item
  useEffect(() => {
    setItem(null);
    if (!partNo || !make) return;
    api.get("/stock-master/lookup/item", { params: { part_no: partNo.trim(), make } })
      .then((r) => setItem(r.data)).catch(() => setItem(null));
  }, [partNo, make]);

  useEffect(() => {
    if (godownId) api.get("/racks", { params: { godown_id: godownId } }).then((r) => setRacks(r.data));
    else setRacks([]);
    setRackId(""); setBoxes([]); setBoxId(""); setBoxCategory("");
  }, [godownId]);

  useEffect(() => {
    if (rackId) api.get("/boxes", { params: { rack_id: rackId } }).then((r) => setBoxes(r.data));
    else setBoxes([]);
    setBoxId(""); setBoxCategory("");
  }, [rackId]);

  useEffect(() => {
    const b = boxes.find((x) => x.id === boxId);
    setBoxCategory(b?.box_category || "");
  }, [boxId, boxes]);

  if (!isOut) {
    return (
      <div className="p-8 max-w-[900px] mx-auto" data-testid="stock-in-direct-disabled-page">
        <div className="bg-white border border-slate-200 rounded-sm p-6">
          <div className="label-sm mb-2">Stock In</div>
          <h1 className="text-3xl font-black text-slate-900 mb-3">Use Receipt Notes</h1>
          <p className="text-sm text-slate-600 mb-5">
            Direct Stock In is disabled. Create a Receipt Note, complete the Racking Note, and record Stock In from the racking workflow.
          </p>
          <Button
            onClick={() => { window.location.href = "/stock-in"; }}
            className="rounded-sm bg-green-700 hover:bg-green-800 text-white font-semibold"
            data-testid="go-to-stock-in-workflow"
          >
            Open Stock In Workflow
          </Button>
        </div>
      </div>
    );
  }

  const submit = async () => {
    if (!partNo || !make || !quantity || !godownId || !rackId || !boxId) {
      toast.error("Please fill all required fields"); return;
    }
    if (parseInt(quantity) <= 0) { toast.error("Quantity must be > 0"); return; }
    setSubmitting(true);
    try {
      await api.post("/stock-out", {
        part_no: partNo.trim(), make, quantity: parseInt(quantity),
        godown_id: godownId, rack_id: rackId, box_id: boxId,
      });
      toast.success(`Stock ${type} recorded`);
      // reset
      setPartNo(""); setMake(""); setItem(null); setQuantity("");
      setGodownId(""); setRackId(""); setBoxId("");
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally { setSubmitting(false); }
  };

  const AutoField = ({ label, value }) => (
    <div>
      <Label className="label-sm">{label}</Label>
      <div className="mt-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-sm text-sm font-mono text-slate-700 min-h-[38px]">
        {value || <span className="text-slate-400">—</span>}
      </div>
    </div>
  );

  return (
    <div className="p-8 max-w-[1400px] mx-auto" data-testid={`stock-${type.toLowerCase()}-page`}>
      <div className="mb-8 flex items-center gap-4">
        <div className={`h-12 w-12 rounded-sm flex items-center justify-center ${isOut ? "bg-orange-50 text-orange-700" : "bg-green-50 text-green-700"}`}>
          {isOut ? <ArrowUp size={24} weight="bold" /> : <ArrowDown size={24} weight="bold" />}
        </div>
        <div>
          <div className="label-sm mb-1">Transaction</div>
          <h1 className="text-4xl font-black tracking-tight text-slate-900">Stock {isOut ? "Out" : "In"}</h1>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left: Item */}
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-sm p-6">
          <div className="label-sm mb-4">Item Details</div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="label-sm">Part No. *</Label>
              <Input value={partNo} onChange={(e) => setPartNo(e.target.value)} placeholder="Enter part number" className="mt-2 rounded-sm font-mono" data-testid="txn-part-no-input" />
            </div>
            <div>
              <Label className="label-sm">Make *</Label>
              <Select value={make} onValueChange={setMake} disabled={!makes.length}>
                <SelectTrigger className="mt-2 rounded-sm" data-testid="txn-make-select">
                  <SelectValue placeholder={makes.length ? "Select make" : "Enter part no. first"} />
                </SelectTrigger>
                <SelectContent>
                  {makes.map((m) => <SelectItem key={m} value={m} data-testid={`make-option-${m}`}>{m}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <AutoField label="Model" value={item?.model} />
            <AutoField label="Item Category" value={item?.item_category} />
            <AutoField label="Old Part No." value={item?.old_part_no} />
            <AutoField label="Make Part No." value={item?.make_part_no} />
            <AutoField label="Remarks OEM" value={item?.remarks_oem} />
            <AutoField label="Description 1" value={item?.description_1} />
            <AutoField label="Description 2" value={item?.description_2} />
            <div className="col-span-2">
              <AutoField label="Remarks Others" value={item?.remarks_others} />
            </div>
            {item?.image && (
              <div className="col-span-2">
                <Label className="label-sm">Image</Label>
                <img src={item.image} alt="" className="mt-2 h-24 w-24 object-cover rounded-sm border border-slate-200" />
              </div>
            )}
          </div>
        </div>

        {/* Right: Location + Qty */}
        <div className="bg-white border border-slate-200 rounded-sm p-6 space-y-4 h-fit">
          <div className="label-sm">Location & Quantity</div>
          <div>
            <Label className="label-sm">Godown *</Label>
            <Select value={godownId} onValueChange={setGodownId}>
              <SelectTrigger className="mt-2 rounded-sm" data-testid="txn-godown-select">
                <SelectValue placeholder="Select godown" />
              </SelectTrigger>
              <SelectContent>
                {godowns.map((g) => <SelectItem key={g.id} value={g.id}>{g.godown_name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="label-sm">Rack *</Label>
            <Select value={rackId} onValueChange={setRackId} disabled={!godownId}>
              <SelectTrigger className="mt-2 rounded-sm" data-testid="txn-rack-select">
                <SelectValue placeholder={godownId ? "Select rack" : "Select godown first"} />
              </SelectTrigger>
              <SelectContent>
                {racks.map((r) => <SelectItem key={r.id} value={r.id}>Rack {r.rack_no}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="label-sm">Box *</Label>
            <Select value={boxId} onValueChange={setBoxId} disabled={!rackId}>
              <SelectTrigger className="mt-2 rounded-sm" data-testid="txn-box-select">
                <SelectValue placeholder={rackId ? "Select box" : "Select rack first"} />
              </SelectTrigger>
              <SelectContent>
                {boxes.map((b) => <SelectItem key={b.id} value={b.id}>Box {b.box_no}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <AutoField label="Box Category" value={boxCategory} />
          <div>
            <Label className="label-sm">Quantity *</Label>
            <Input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="mt-2 rounded-sm font-mono text-lg" data-testid="txn-quantity-input" />
          </div>
          <Button
            onClick={submit}
            disabled={submitting || !item}
            className={`w-full rounded-sm text-white font-semibold h-11 ${isOut ? "bg-orange-600 hover:bg-orange-700" : "bg-green-700 hover:bg-green-800"}`}
            data-testid="txn-submit-button"
          >
            {submitting ? "Saving…" : `Record Stock ${isOut ? "Out" : "In"}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
