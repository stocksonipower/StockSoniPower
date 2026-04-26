import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import {
  Package,
  Warning,
  TrendUp,
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

  useEffect(() => {
    api.get("/dashboard/stats").then((r) => setStats(r.data));
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
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Stat icon={Package} label="Total Items" value={stats?.total_items ?? "–"} testid="stat-total-items" />
        <Stat icon={TrendUp} label="Total Stock" value={stats?.total_stock_qty ?? "–"} accent="blue" testid="stat-total-stock" />
        <Stat icon={Warning} label="Low Stock" value={stats?.low_stock_count ?? "–"} accent="red" testid="stat-low-stock" />
      </div>
    </div>
  );
}
