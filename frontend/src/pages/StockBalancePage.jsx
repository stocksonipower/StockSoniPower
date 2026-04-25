import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Input } from "../components/ui/input";
import { MagnifyingGlass } from "@phosphor-icons/react";

export default function StockBalancePage() {
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState("");

  const load = async () => {
    const { data } = await api.get("/stock-balance", { params: search ? { search } : {} });
    setRows(data);
  };

  useEffect(() => { load(); }, [search]);

  return (
    <div className="p-8 max-w-[1600px] mx-auto" data-testid="balance-page">
      <div className="mb-6">
        <div className="label-sm mb-2">Current State</div>
        <h1 className="text-4xl font-black tracking-tight text-slate-900">Stock Summary</h1>
      </div>

      <div className="relative mb-4">
        <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <Input
          placeholder="Search by part no., make, description…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10 rounded-sm max-w-md"
          data-testid="balance-search-input"
        />
      </div>

      <div className="bg-white border border-slate-200 rounded-sm overflow-hidden">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th>Part No.</th>
              <th>Make</th>
              <th>Description</th>
              <th>Godown</th>
              <th>Rack</th>
              <th>Box</th>
              <th className="text-right">Quantity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} data-testid={`balance-row-${i}`}>
                <td className="font-mono font-semibold">{r.part_no}</td>
                <td>{r.make}</td>
                <td className="text-slate-600 max-w-xs truncate">{r.description_1 || "—"}</td>
                <td>{r.godown_name}</td>
                <td className="font-mono">{r.rack_no}</td>
                <td className="font-mono">{r.box_no}</td>
                <td className={`text-right font-mono font-bold ${r.total_quantity <= 5 ? "text-red-700" : "text-slate-900"}`}>
                  {r.total_quantity}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="text-center py-12 text-slate-500">No stock recorded yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
