import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import {
  Package,
  Buildings,
  Stack,
  Archive,
  Warning,
  TrendUp,
} from "@phosphor-icons/react";
import { Link } from "react-router-dom";

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
  const [lowStock, setLowStock] = useState([]);
  const [recent, setRecent] = useState([]);

  useEffect(() => {
    api.get("/dashboard/stats").then((r) => setStats(r.data));
    api.get("/low-stock").then((r) => setLowStock(r.data));
    api.get("/transactions?limit=10").then((r) => setRecent(r.data));
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

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
        <Stat icon={Package} label="Items" value={stats?.total_items ?? "–"} testid="stat-total-items" />
        <Stat icon={TrendUp} label="Total Stock" value={stats?.total_stock_qty ?? "–"} accent="blue" testid="stat-total-stock" />
        <Stat icon={Buildings} label="Godowns" value={stats?.total_godowns ?? "–"} testid="stat-godowns" />
        <Stat icon={Stack} label="Racks" value={stats?.total_racks ?? "–"} testid="stat-racks" />
        <Stat icon={Archive} label="Boxes" value={stats?.total_boxes ?? "–"} testid="stat-boxes" />
        <Stat icon={Warning} label="Low Stock" value={stats?.low_stock_count ?? "–"} accent="red" testid="stat-low-stock" />
      </div>

      {/* Panels */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Low stock alerts */}
        <div className="bg-white border border-slate-200 rounded-sm">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
            <div>
              <div className="label-sm">Alerts</div>
              <h2 className="text-lg font-bold text-slate-900">Low Stock</h2>
            </div>
            <Link to="/low-stock" className="text-xs font-semibold text-blue-700 hover:underline">View all →</Link>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {lowStock.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">No low stock items.</div>
            ) : (
              <table className="data-table w-full">
                <thead>
                  <tr>
                    <th>Part No.</th>
                    <th>Make</th>
                    <th className="text-right">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {lowStock.slice(0, 8).map((x, i) => (
                    <tr key={i}>
                      <td className="font-mono">{x.part_no}</td>
                      <td>{x.make}</td>
                      <td className="text-right font-mono font-bold text-red-700">{x.total_quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Recent transactions */}
        <div className="bg-white border border-slate-200 rounded-sm">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
            <div>
              <div className="label-sm">Activity</div>
              <h2 className="text-lg font-bold text-slate-900">Recent Transactions</h2>
            </div>
            <Link to="/transactions" className="text-xs font-semibold text-blue-700 hover:underline">View all →</Link>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {recent.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">No transactions yet.</div>
            ) : (
              <table className="data-table w-full">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Part No.</th>
                    <th>Make</th>
                    <th className="text-right">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${
                          t.type === "IN" ? "bg-green-50 text-green-700" : "bg-orange-50 text-orange-700"
                        }`}>
                          {t.type}
                        </span>
                      </td>
                      <td className="font-mono">{t.part_no}</td>
                      <td>{t.make}</td>
                      <td className="text-right font-mono">{t.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
