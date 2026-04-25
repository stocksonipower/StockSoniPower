import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { MagnifyingGlass, ArrowsClockwise, Image as ImgIcon } from "@phosphor-icons/react";

export default function StockBalancePage() {
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async (q) => {
    setLoading(true);
    try {
      const { data } = await api.get("/stock-balance", { params: q ? { search: q } : {} });
      setRows(data);
    } finally { setLoading(false); }
  };

  // Debounced search; refetch on every change
  useEffect(() => {
    const t = setTimeout(() => load(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const dash = <span className="text-slate-300">—</span>;

  return (
    <div className="p-8 max-w-[1900px] mx-auto" data-testid="balance-page">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <div className="label-sm mb-2">Live Inventory</div>
          <h1 className="text-4xl font-black tracking-tight text-slate-900">Stock Summary</h1>
          <p className="text-sm text-slate-600 mt-2">
            Live join of Stock Master + Locations + Transactions. Edits in any of those reflect here on next refresh.
          </p>
        </div>
        <Button
          onClick={() => load(search)}
          variant="outline"
          className="rounded-sm border-slate-300"
          disabled={loading}
          data-testid="refresh-button"
        >
          <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="relative mb-4 max-w-xl">
        <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <Input
          placeholder="Search part no, old part no, make part no, description, remarks, make, category…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10 rounded-sm"
          data-testid="balance-search-input"
        />
      </div>

      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-14">SL NO</th>
              <th>MODEL</th>
              <th>PART NO</th>
              <th>OLD PART NO</th>
              <th>MAKE PART NO</th>
              <th>DESCRIPTION 1</th>
              <th>DESCRIPTION 2</th>
              <th>REMARKS OEM</th>
              <th>REMARKS OTHERS</th>
              <th>MAKE</th>
              <th>ITEM CATEGORY</th>
              <th>IMAGE</th>
              <th>GODOWN</th>
              <th>RACK NO</th>
              <th>BOX NO</th>
              <th>BOX CATEGORY</th>
              <th className="text-right">QTY</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={17} className="text-center py-12 text-slate-500">
                  {loading ? "Loading…" : (search ? "No matches." : "No stock recorded yet.")}
                </td>
              </tr>
            ) : rows.map((r, i) => (
              <tr key={`${r.part_no}|${r.make}|${r.box_id || i}`} data-testid={`balance-row-${i}`}>
                <td className="font-mono text-slate-500">{i + 1}</td>
                <td className="font-mono text-slate-700">{r.model || dash}</td>
                <td className="font-mono font-semibold">{r.part_no}</td>
                <td className="font-mono text-slate-600">{r.old_part_no || dash}</td>
                <td className="font-mono text-slate-600">{r.make_part_no || dash}</td>
                <td className="text-slate-700 max-w-[180px] truncate">{r.description_1 || dash}</td>
                <td className="text-slate-700 max-w-[180px] truncate">{r.description_2 || dash}</td>
                <td className="text-slate-600 max-w-[160px] truncate">{r.remarks_oem || dash}</td>
                <td className="text-slate-600 max-w-[160px] truncate">{r.remarks_others || dash}</td>
                <td>{r.make}</td>
                <td>{r.item_category || dash}</td>
                <td>
                  {r.image ? (
                    <img src={r.image} alt="" className="h-10 w-10 object-cover rounded-sm border border-slate-200" />
                  ) : (
                    <div className="h-10 w-10 flex items-center justify-center bg-slate-50 border border-slate-200 rounded-sm text-slate-400">
                      <ImgIcon size={14} />
                    </div>
                  )}
                </td>
                <td>{r.godown_name || dash}</td>
                <td className="font-mono">{r.rack_no || dash}</td>
                <td className="font-mono">{r.box_no || dash}</td>
                <td>{r.box_category || dash}</td>
                <td className={`text-right font-mono font-bold ${r.total_quantity <= 5 ? "text-red-700" : "text-slate-900"}`}>
                  {r.total_quantity}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 text-xs text-slate-500">
        {rows.length} row{rows.length === 1 ? "" : "s"} • Item details (model, descriptions, remarks, image, category) and location names are pulled live from Stock Master and Location Master each time you refresh.
      </div>
    </div>
  );
}
