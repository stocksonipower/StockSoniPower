import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";

export default function TransactionsPage() {
  const [txns, setTxns] = useState([]);
  const [filter, setFilter] = useState("ALL");

  useEffect(() => {
    const params = filter === "ALL" ? { limit: 500 } : { limit: 500, type: filter };
    api.get("/transactions", { params }).then((r) => setTxns(r.data));
  }, [filter]);

  return (
    <div className="p-8 max-w-[1600px] mx-auto" data-testid="transactions-page">
      <div className="mb-6">
        <div className="label-sm mb-2">History</div>
        <h1 className="text-4xl font-black tracking-tight text-slate-900">Transactions</h1>
      </div>

      <Tabs value={filter} onValueChange={setFilter} className="mb-4">
        <TabsList className="rounded-sm">
          <TabsTrigger value="ALL" className="rounded-sm" data-testid="filter-all">All</TabsTrigger>
          <TabsTrigger value="IN" className="rounded-sm" data-testid="filter-in">Stock In</TabsTrigger>
          <TabsTrigger value="OUT" className="rounded-sm" data-testid="filter-out">Stock Out</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="bg-white border border-slate-200 rounded-sm overflow-hidden">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Part No.</th>
              <th>Make</th>
              <th>Godown</th>
              <th>Rack</th>
              <th>Box</th>
              <th className="text-right">Qty</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {txns.map((t) => (
              <tr key={t.id}>
                <td className="text-xs font-mono text-slate-500">{new Date(t.created_at).toLocaleString()}</td>
                <td>
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${
                    t.type === "IN" ? "bg-green-50 text-green-700" : "bg-orange-50 text-orange-700"
                  }`}>
                    {t.type}
                  </span>
                </td>
                <td className="font-mono font-semibold">{t.part_no}</td>
                <td>{t.make}</td>
                <td>{t.godown_name}</td>
                <td className="font-mono">{t.rack_no}</td>
                <td className="font-mono">{t.box_no}</td>
                <td className="text-right font-mono font-bold">{t.quantity}</td>
                <td className="text-xs text-slate-500">{t.created_by}</td>
              </tr>
            ))}
            {txns.length === 0 && (
              <tr><td colSpan={9} className="text-center py-12 text-slate-500">No transactions.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
