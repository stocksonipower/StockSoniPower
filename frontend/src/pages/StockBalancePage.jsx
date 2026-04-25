import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "../components/ui/select";
import { MagnifyingGlass, ArrowsClockwise, Image as ImgIcon, FunnelSimple, X } from "@phosphor-icons/react";

const COLUMNS = [
  { key: "model", label: "MODEL", className: "font-mono text-slate-700" },
  { key: "part_no", label: "PART NO", className: "font-mono font-semibold" },
  { key: "old_part_no", label: "OLD PART NO", className: "font-mono text-slate-600" },
  { key: "make_part_no", label: "MAKE PART NO", className: "font-mono text-slate-600" },
  { key: "description_1", label: "DESCRIPTION 1", className: "text-slate-700 max-w-[180px] truncate" },
  { key: "description_2", label: "DESCRIPTION 2", className: "text-slate-700 max-w-[180px] truncate" },
  { key: "remarks_oem", label: "REMARKS OEM", className: "text-slate-600 max-w-[160px] truncate" },
  { key: "remarks_others", label: "REMARKS OTHERS", className: "text-slate-600 max-w-[160px] truncate" },
  { key: "make", label: "MAKE", className: "" },
  { key: "item_category", label: "ITEM CATEGORY", className: "" },
  { key: "image", label: "IMAGE", className: "", isImage: true },
  { key: "godown_name", label: "GODOWN", className: "" },
  { key: "rack_no", label: "RACK NO", className: "font-mono" },
  { key: "box_no", label: "BOX NO", className: "font-mono" },
  { key: "box_category", label: "BOX CATEGORY", className: "" },
  { key: "total_quantity", label: "QTY", className: "text-right font-mono font-bold", isQty: true },
];

export default function StockBalancePage() {
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [colFilters, setColFilters] = useState({}); // { key: "value" }

  const load = async (q) => {
    setLoading(true);
    try {
      const { data } = await api.get("/stock-balance", { params: q ? { search: q } : {} });
      setRows(data);
    } finally { setLoading(false); }
  };

  useEffect(() => {
    const t = setTimeout(() => load(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const setFilter = (key, val) => setColFilters((f) => {
    const next = { ...f };
    if (!val) delete next[key];
    else next[key] = val;
    return next;
  });

  const filteredRows = useMemo(() => {
    const activeKeys = Object.keys(colFilters);
    if (activeKeys.length === 0) return rows;
    return rows.filter((row) => activeKeys.every((k) => {
      const v = colFilters[k];
      if (k === "image") {
        if (v === "yes") return !!row.image;
        if (v === "no") return !row.image;
        return true;
      }
      const cell = String(row[k] ?? "").toLowerCase();
      return cell.includes(v.toLowerCase());
    }));
  }, [rows, colFilters]);

  const activeFilterCount = Object.keys(colFilters).length;
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
        <Button onClick={() => load(search)} variant="outline" className="rounded-sm border-slate-300" disabled={loading} data-testid="refresh-button">
          <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative max-w-md flex-1">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Search part no, descriptions, remarks, category…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 rounded-sm"
            data-testid="balance-search-input"
          />
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <FunnelSimple size={14} weight="bold" />
          <span>{activeFilterCount > 0 ? `${activeFilterCount} column filter(s) active` : "Use the row below the headers to filter any column"}</span>
        </div>
        {activeFilterCount > 0 && (
          <Button onClick={() => setColFilters({})} variant="ghost" size="sm" className="rounded-sm h-7 text-xs" data-testid="clear-filters-button">
            <X size={12} weight="bold" className="mr-1" /> Clear filters
          </Button>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-14">SL NO</th>
              {COLUMNS.map((c) => (
                <th key={c.key} className={c.isQty ? "text-right" : ""}>{c.label}</th>
              ))}
            </tr>
            <tr className="bg-slate-50">
              <th className="w-14 px-2 py-1.5"></th>
              {COLUMNS.map((c) => (
                <th key={c.key} className="px-2 py-1.5 font-normal normal-case tracking-normal">
                  {c.isImage ? (
                    <Select
                      value={colFilters[c.key] || "all"}
                      onValueChange={(v) => setFilter(c.key, v === "all" ? "" : v)}
                    >
                      <SelectTrigger className="h-7 rounded-sm text-xs" data-testid={`filter-${c.key}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All</SelectItem>
                        <SelectItem value="yes">Has image</SelectItem>
                        <SelectItem value="no">No image</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      value={colFilters[c.key] || ""}
                      onChange={(e) => setFilter(c.key, e.target.value)}
                      placeholder="Filter"
                      className="h-7 rounded-sm text-xs"
                      data-testid={`filter-${c.key}`}
                    />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="text-center py-12 text-slate-500">
                  {loading ? "Loading…" : (search || activeFilterCount > 0 ? "No matches." : "No stock recorded yet.")}
                </td>
              </tr>
            ) : filteredRows.map((r, i) => (
              <tr key={`${r.part_no}|${r.make}|${r.box_id || i}`} data-testid={`balance-row-${i}`}>
                <td className="font-mono text-slate-500">{i + 1}</td>
                {COLUMNS.map((c) => {
                  if (c.isImage) {
                    return (
                      <td key={c.key}>
                        {r.image ? (
                          <img src={r.image} alt="" className="h-10 w-10 object-cover rounded-sm border border-slate-200" />
                        ) : (
                          <div className="h-10 w-10 flex items-center justify-center bg-slate-50 border border-slate-200 rounded-sm text-slate-400">
                            <ImgIcon size={14} />
                          </div>
                        )}
                      </td>
                    );
                  }
                  if (c.isQty) {
                    return (
                      <td key={c.key} className={`text-right font-mono font-bold ${r.total_quantity <= 5 ? "text-red-700" : "text-slate-900"}`}>
                        {r.total_quantity}
                      </td>
                    );
                  }
                  const val = r[c.key];
                  return (
                    <td key={c.key} className={c.className}>
                      {val || val === 0 ? val : dash}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 text-xs text-slate-500">
        {filteredRows.length} of {rows.length} row{rows.length === 1 ? "" : "s"}
        {activeFilterCount > 0 && " (filtered)"} • Item details and locations are pulled live from Stock Master and Location Master each time you refresh.
      </div>
    </div>
  );
}
