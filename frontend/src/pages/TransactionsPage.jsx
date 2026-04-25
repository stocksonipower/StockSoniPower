import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Button } from "../components/ui/button";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";

const PAGE_SIZE = 10000;

export default function TransactionsPage() {
  const [txns, setTxns] = useState([]);
  const [filter, setFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => { setPage(1); }, [filter]);

  useEffect(() => {
    setLoading(true);
    const params = { page, page_size: PAGE_SIZE };
    if (filter !== "ALL") params.type = filter;
    api.get("/transactions", { params }).then((r) => {
      setTxns(r.data);
      const t = parseInt(r.headers["x-total-count"], 10);
      setTotal(isNaN(t) ? r.data.length : t);
    }).finally(() => setLoading(false));
  }, [filter, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
              <tr><td colSpan={9} className="text-center py-12 text-slate-500">{loading ? "Loading…" : "No transactions."}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      <div className="flex items-center justify-between mt-3 text-xs text-slate-600" data-testid="transactions-pagination">
        <div>
          {total === 0 ? "No transactions" : (
            <>Showing <span className="font-semibold text-slate-900">{txns.length}</span> · <span className="font-semibold text-slate-900">{total}</span> total</>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading} variant="outline" size="sm" className="rounded-sm h-7" data-testid="prev-page-button">
            <CaretLeft size={12} weight="bold" className="mr-1" /> Prev
          </Button>
          <span className="font-mono">Page {page} of {totalPages}</span>
          <Button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages || loading} variant="outline" size="sm" className="rounded-sm h-7" data-testid="next-page-button">
            Next <CaretRight size={12} weight="bold" className="ml-1" />
          </Button>
          <span className="text-slate-400 ml-2">{PAGE_SIZE.toLocaleString()} / page</span>
        </div>
      </div>
    </div>
  );
}
