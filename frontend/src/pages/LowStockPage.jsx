import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Warning } from "@phosphor-icons/react";

export default function LowStockPage() {
  const [threshold, setThreshold] = useState(5);
  const [rows, setRows] = useState([]);

  useEffect(() => {
    const t = setTimeout(() => {
      api.get("/low-stock", { params: { threshold } }).then((r) => setRows(r.data));
    }, 200);
    return () => clearTimeout(t);
  }, [threshold]);

  return (
    <div className="p-8 max-w-[1400px] mx-auto" data-testid="low-stock-page">
      <div className="mb-6 flex items-center gap-4">
        <div className="h-12 w-12 rounded-sm flex items-center justify-center bg-red-50 text-red-700">
          <Warning size={24} weight="bold" />
        </div>
        <div>
          <div className="label-sm mb-1">Alerts</div>
          <h1 className="text-4xl font-black tracking-tight text-slate-900">Low Stock</h1>
        </div>
      </div>

      <div className="mb-4 flex items-end gap-3">
        <div>
          <Label className="label-sm">Threshold (≤)</Label>
          <Input type="number" min="0" value={threshold} onChange={(e) => setThreshold(parseInt(e.target.value) || 0)} className="mt-2 rounded-sm w-32 font-mono" data-testid="threshold-input" />
        </div>
        <div className="text-sm text-slate-600 pb-2">{rows.length} item(s) at or below threshold</div>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm overflow-hidden">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th>Part No.</th>
              <th>Make</th>
              <th>Description</th>
              <th className="text-right">Total Qty</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="font-mono font-semibold">{r.part_no}</td>
                <td>{r.make}</td>
                <td className="text-slate-600">{r.description_1 || "—"}</td>
                <td className="text-right font-mono font-bold text-red-700">{r.total_quantity}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={4} className="text-center py-12 text-slate-500">All stock levels healthy.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
