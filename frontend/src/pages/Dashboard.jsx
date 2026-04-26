import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useNavigate } from "react-router-dom";
import {
  Package,
  Warning,
  TrendUp,
  Buildings,
  ArrowDown,
  ArrowUp,
} from "@phosphor-icons/react";

const Stat = ({ icon: Icon, label, value, accent = "slate", testid, onClick }) => (
  <div
    className={`bg-white border border-slate-200 rounded-sm p-5 cursor-pointer transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md hover:border-blue-300`}
    data-testid={testid}
    onClick={onClick}
  >
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
  const [stockIn, setStockIn] = useState({ receiptPending: null, rackingDraft: null });
  const [stockOut, setStockOut] = useState({ issuePending: null, pickingDraft: null });
  const navigate = useNavigate();

  useEffect(() => {
    api.get("/dashboard/stats")
      .then((r) => setStats(r.data))
      .catch((e) => { console.error("[dashboard] /dashboard/stats failed:", e); });

    // Receipt notes pending = anything not FULLY_RACKED
    api.get("/receipt-notes", {
      params: { not_status: "FULLY_RACKED", page_size: 1 }
    }).then((r) => {
      const total = r.headers["x-total-count"];
      setStockIn((prev) => ({ ...prev, receiptPending: total ? parseInt(total, 10) : 0 }));
    }).catch((e) => { console.error("[dashboard] /receipt-notes failed:", e); });

    // Racking notes DRAFT — server-side filter (status=DRAFT) using x-total-count
    api.get("/racking-notes", {
      params: { status: "DRAFT", page_size: 1 }
    }).then((r) => {
      const total = r.headers["x-total-count"];
      setStockIn((prev) => ({ ...prev, rackingDraft: total ? parseInt(total, 10) : 0 }));
    }).catch((e) => { console.error("[dashboard] /racking-notes failed:", e); });

    // Issue notes pending = anything not FULLY_PICKED
    api.get("/issue-notes", {
      params: { not_status: "FULLY_PICKED", page_size: 1 }
    }).then((r) => {
      const total = r.headers["x-total-count"];
      setStockOut((prev) => ({ ...prev, issuePending: total ? parseInt(total, 10) : 0 }));
    }).catch((e) => { console.error("[dashboard] /issue-notes failed:", e); });

    // Picking notes DRAFT — server-side filter (status=DRAFT) using x-total-count
    api.get("/picking-notes", {
      params: { status: "DRAFT", page_size: 1 }
    }).then((r) => {
      const total = r.headers["x-total-count"];
      setStockOut((prev) => ({ ...prev, pickingDraft: total ? parseInt(total, 10) : 0 }));
    }).catch((e) => { console.error("[dashboard] /picking-notes failed:", e); });

    api.get("/stock-balance").then((r) => {
      const rows = r.data;
      const map = {};
      rows.forEach((row) => {
        const name = row.godown_name || "Unknown";
        if (!map[name]) map[name] = 0;
        map[name] += row.total_quantity || 0;
      });
      const summary = Object.entries(map)
        .map(([godown_name, total_quantity]) => ({ godown_name, total_quantity }))
        .sort((a, b) => a.godown_name.localeCompare(b.godown_name));
      setGodownSummary(summary);
    }).catch((e) => { console.error("[dashboard] /stock-balance failed:", e); });
  }, []);

  return (
    <div className="p-8 max-w-[1600px] mx-auto" data-testid="dashboard-page">
      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="label-sm mb-2">Overview</div>
          <h1 className="text-4xl font-black tracking-tight text-slate-900">Dashboard</h1>
        </div>
        <div className="text-xs font-mono text-slate-500">
          {new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric", weekday: "long" }).replace(/\//g, "-")}
        </div>
      </div>

      {/* Row 1 — Master stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <Stat icon={Package} label="Stock Master" value={stats?.total_items ?? "–"} testid="stat-total-items" onClick={() => navigate("/stock-master")} />
        <Stat icon={TrendUp} label="Stock Summary" value={stats?.total_stock_qty ?? "–"} accent="blue" testid="stat-total-stock" onClick={() => navigate("/balance")} />
        <Stat icon={Warning} label="Low Stock" value={stats?.low_stock_count ?? "–"} accent="red" testid="stat-low-stock" onClick={() => navigate("/low-stock")} />
      </div>

      {/* Row 2 — Workflow widgets */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">

        {/* Stock In Widget */}
        <div
          className="bg-white border border-slate-200 rounded-sm p-5 cursor-pointer transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md hover:border-blue-300"
          onClick={() => navigate("/stock-in")}
          data-testid="widget-stock-in"
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 flex items-center justify-center rounded-sm bg-green-50 text-green-700">
              <ArrowDown size={22} weight="bold" />
            </div>
            <div className="text-[11px] uppercase tracking-[0.15em] font-bold text-slate-500">Stock In</div>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Receipt Note Pending</span>
              <span className="text-2xl font-black font-mono text-slate-900">
                {stockIn.receiptPending ?? "–"}
              </span>
            </div>
            <div className="border-t border-slate-100" />
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Racking Note Pending</span>
              <span className="text-2xl font-black font-mono text-slate-900">
                {stockIn.rackingDraft ?? "–"}
              </span>
            </div>
          </div>
        </div>

        {/* Stock Out Widget */}
        <div
          className="bg-white border border-slate-200 rounded-sm p-5 cursor-pointer transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md hover:border-blue-300"
          onClick={() => navigate("/stock-out")}
          data-testid="widget-stock-out"
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 flex items-center justify-center rounded-sm bg-orange-50 text-orange-700">
              <ArrowUp size={22} weight="bold" />
            </div>
            <div className="text-[11px] uppercase tracking-[0.15em] font-bold text-slate-500">Stock Out</div>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Issue Note Pending</span>
              <span className="text-2xl font-black font-mono text-slate-900">
                {stockOut.issuePending ?? "–"}
              </span>
            </div>
            <div className="border-t border-slate-100" />
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Picking Note Pending</span>
              <span className="text-2xl font-black font-mono text-slate-900">
                {stockOut.pickingDraft ?? "–"}
              </span>
            </div>
          </div>
        </div>

      </div>

      {/* Godown Summary Widget */}
      <div className="bg-white border border-slate-200 rounded-sm max-w-lg">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-200">
          <div className="h-8 w-8 flex items-center justify-center rounded-sm bg-slate-50 text-slate-700">
            <Buildings size={18} weight="bold" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900">Godown Stock Quantity</h2>
          </div>
        </div>

        <div className="overflow-y-auto max-h-72">
          {godownSummary.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">No stock data available.</div>
          ) : (
            <table className="w-full" data-testid="godown-summary-table">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="text-left text-[11px] uppercase tracking-[0.12em] font-bold text-slate-500 px-5 py-2 w-1/2">Godown Name</th>
                  <th className="text-left text-[11px] uppercase tracking-[0.12em] font-bold text-slate-500 px-5 py-2 w-1/2">Total Quantity</th>
                </tr>
              </thead>
              <tbody>
                {godownSummary.map((g, i) => (
                  <tr key={i} className="border-b border-slate-100 hover:bg-slate-50" data-testid={`godown-row-${i}`}>
                    <td className="px-5 py-2.5 w-1/2 font-medium text-slate-800 text-sm">{g.godown_name}</td>
                    <td className="px-5 py-2.5 w-1/2 font-mono font-bold text-slate-900 text-sm">{g.total_quantity}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-slate-300 bg-slate-50">
                  <td className="px-5 py-2.5 w-1/2 text-[11px] uppercase tracking-[0.12em] font-bold text-slate-500">
                    {godownSummary.length} godown{godownSummary.length !== 1 ? "s" : ""}
                  </td>
                  <td className="px-5 py-2.5 w-1/2 font-mono font-black text-slate-900 text-sm">
                    {godownSummary.reduce((sum, g) => sum + g.total_quantity, 0)}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}