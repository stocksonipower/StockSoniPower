import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Button } from "../components/ui/button";
import { Warning, ArrowsClockwise } from "@phosphor-icons/react";

export default function LowStockPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/low-stock");
      setRows(data);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="p-8 max-w-[1400px] mx-auto" data-testid="low-stock-page">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-sm flex items-center justify-center bg-red-50 text-red-700">
            <Warning size={24} weight="bold" />
          </div>
          <div>
            <div className="label-sm mb-1">Alerts</div>
            <h1 className="text-4xl font-black tracking-tight text-slate-900">Low Stock</h1>
            <p className="text-sm text-slate-600 mt-2">
              Shows items where current stock is at or below the per-item Reorder Level set in Stock Master.
            </p>
          </div>
        </div>
        <Button onClick={load} variant="outline" className="rounded-sm border-slate-300" disabled={loading} data-testid="refresh-button">
          <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="text-sm text-slate-600 mb-4">{rows.length} item(s) at or below their reorder level</div>

      <div className="bg-white border border-slate-200 rounded-sm overflow-hidden">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th>Part No.</th>
              <th>Make</th>
              <th>Model</th>
              <th>Description</th>
              <th>Category</th>
              <th className="text-right">Reorder Level</th>
              <th className="text-right">Current Qty</th>
              <th className="text-right">Shortage</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={8} className="text-center py-12 text-slate-500">All stock levels healthy.</td></tr>
            ) : rows.map((r, i) => {
              const shortage = Math.max(0, r.reorder_level - r.total_quantity);
              return (
                <tr key={i}>
                  <td className="font-mono font-semibold">{r.part_no}</td>
                  <td>{r.make}</td>
                  <td className="font-mono text-slate-600">{r.model || "—"}</td>
                  <td className="text-slate-600">{r.description_1 || "—"}</td>
                  <td>{r.item_category || "—"}</td>
                  <td className="text-right font-mono text-slate-700">{r.reorder_level}</td>
                  <td className={`text-right font-mono font-bold ${r.total_quantity === 0 ? "text-red-700" : "text-amber-700"}`}>{r.total_quantity}</td>
                  <td className="text-right font-mono font-bold text-red-700">{shortage > 0 ? `+${shortage}` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
