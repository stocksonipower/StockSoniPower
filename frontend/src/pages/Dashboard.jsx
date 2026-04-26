import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import {
  Package,
  Warning,
  TrendUp,
  Buildings,
} from "@phosphor-icons/react";

const Stat = ({ icon: Icon, label, value, accent = "slate", testid }) => (
  <div className="bg-white border border-slate-200 rounded-sm p-5" data-testid={testid}>
    <div className="flex items-start justify-between mb-3">
      <div className={`h-10 w-10 flex items-center justify-center rounded-sm bg-${accent}-50 text-${accent}-700`}>
        <Icon size={22} weight="bold" />
      </div>
    </div>
    <div className="text-[11px] uppercase tracking-[0.15em] font-bold text-slate-500">{label}</div>
    <div className="text-3xl font-black text-slate-900 font-mono tracking-tight mt-1">{value}</div>
  </div>
);

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [godownSummary, setGodownSummary] = useState([]);

  useEffect(() => {
    api.get("/dashboard/stats").then((r) => setStats(r.data));

    api.get("/stock-balance").then((r) => {
      const rows = r.data;

      const map = {};
      rows.forEach((row) => {
        const name = row.godown_name || "Unknown";
        if (!map[name]) map[name] = 0;
        map[name] += row.total_quantity || 0;
      });

      // Sort alphabetically by godown name
      const summary = Object.entries(map)
        .map(([godown_name, total_quantity]) => ({ godown_name, total_quantity }))
        .sort((a, b) => a.godown_name.localeCompare(b.godown_name));

      setGodownSummary(summary);
    });
  }, []);

  return (
    <div className="p-8 max-w-[1600px] mx-auto" data-testid="dashboard-page">
      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="label-sm mb-2">Overview</div>
          <h1 className="text-4xl font-black tracking-tight text-slate-900">Dashboard</h1>
        </div>
        <div className="text-xs font-mono text-slate-500">
          {new Date().toLocaleString()}
        </div>
      </div>

      {/* Stats grid — 3 cards only */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Stat icon={Package} label="Total Items" value={stats?.total_items ?? "–"} testid="stat-total-items" />
        <Stat icon={TrendUp} label="Total Stock" value={stats?.total_stock_qty ?? "–"} accent="blue" testid="stat-total-stock" />
        <Stat icon={Warning} label="Low Stock" value={stats?.low_stock_count ?? "–"} accent="red" testid="stat-low-stock" />
      </div>

      {/* Godown Summary Widget */}
      <div className="bg-white border border-slate-200 rounded-sm max-w-lg">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-200">
          <div className="h-8 w-8 flex items-center justify-center rounded-sm bg-slate-50 text-slate-700">
            <Buildings size={18} weight="bold" />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.15em] font-bold text-slate-500">Live Inventory</div>
            <h2 className="text-base font-bold text-slate-900">Stock by Godown</h2>
          </div>
        </div>

        <div className="overflow-y-auto max-h-72">
          {godownSummary.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">No stock data available.</div>
          ) : (
            <table className="data-table w-full" data-testid="godown-summary-table">
              <thead>
                <tr>
                  <th>Godown Name</th>
                  <th className="text-right">Total Quantity</th>
                </tr>
              </thead>
              <tbody>
                {godownSummary.map((g, i) => (
                  <tr key={i} data-testid={`godown-row-${i}`}>
                    <td className="font-medium text-slate-800">{g.godown_name}</td>
                    <td className="text-right font-mono font-bold text-slate-900">{g.total_quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{godownSummary.length} godown{godownSummary.length !== 1 ? "s" : ""}</span>
            <span className="font-mono font-bold text-slate-700">
              Total: {godownSummary.reduce((sum, g) => sum + g.total_quantity, 0)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
