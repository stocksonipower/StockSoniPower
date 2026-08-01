import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { Button } from "../components/ui/button";
import { Warning, ArrowsClockwise, DownloadSimple } from "@phosphor-icons/react";
import { useTableSortFilter, ColumnHeader } from "../components/DataTable";
import PartNoLink from "../components/PartNoLink";
import { exportToExcel } from "../lib/exportExcel";
import { toast } from "sonner";

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

  const columns = useMemo(() => [
    { key: "model", label: "Model", value: (r) => r.model || "" },
    { key: "part_no", label: "Part No", value: (r) => r.part_no || "" },
    { key: "description_1", label: "Description 1", value: (r) => r.description_1 || "" },
    { key: "description_2", label: "Description 2", value: (r) => r.description_2 || "" },
    { key: "make", label: "Make", value: (r) => r.make || "" },
    { key: "reorder_level", label: "Reorder Level", value: (r) => r.reorder_level ?? 0 },
    { key: "current_stock", label: "Current Stock", value: (r) => r.total_quantity ?? 0 },
  ], []);

  const { filteredRows, getColumnHeaderProps } = useTableSortFilter(rows, columns);

  const exportColumns = useMemo(() => [
    { key: "sl", label: "Sl No", value: (_, idx) => idx + 1 },
    ...columns,
  ], [columns]);

  const handleExport = () => {
    if (filteredRows.length === 0) { toast.error("No rows to export"); return; }
    const cols = exportColumns.map((c) => ({
      label: c.label,
      value: c.key === "sl" ? (r) => filteredRows.indexOf(r) + 1 : c.value,
    }));
    exportToExcel(filteredRows, cols, `Low_Stock_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <div className="p-8 max-w-[1400px] mx-auto" data-testid="low-stock-page">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-sm flex items-center justify-center bg-red-50 text-red-700">
            <Warning size={24} weight="bold" />
          </div>
          <div>
            <h1 className="text-4xl font-black tracking-tight text-slate-900">Low Stock</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleExport} variant="outline" className="rounded-sm border-slate-300" data-testid="low-stock-export-button">
            <DownloadSimple size={14} weight="bold" className="mr-2" />
            Export
          </Button>
          <Button onClick={load} variant="outline" className="rounded-sm border-slate-300" disabled={loading} data-testid="refresh-button">
            <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="text-sm text-slate-600 mb-4">
        Showing {filteredRows.length} of {rows.length} item(s) at or below their reorder level
      </div>

      <div className="bg-white border border-slate-200 rounded-sm overflow-visible">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-16">Sl No</th>
              <ColumnHeader {...getColumnHeaderProps("model")} label="Model" testid="low-stock-col-model" />
              <ColumnHeader {...getColumnHeaderProps("part_no")} label="Part No" testid="low-stock-col-part-no" />
              <ColumnHeader {...getColumnHeaderProps("description_1")} label="Description 1" testid="low-stock-col-desc1" />
              <ColumnHeader {...getColumnHeaderProps("description_2")} label="Description 2" testid="low-stock-col-desc2" />
              <ColumnHeader {...getColumnHeaderProps("make")} label="Make" testid="low-stock-col-make" />
              <ColumnHeader {...getColumnHeaderProps("reorder_level")} align="center" label="Reorder Level" testid="low-stock-col-reorder" />
              <ColumnHeader {...getColumnHeaderProps("current_stock")} align="center" label="Current Stock" testid="low-stock-col-current" />
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr><td colSpan={8} className="text-center py-12 text-slate-500">{rows.length === 0 ? "All stock levels healthy." : "No rows match the current filters."}</td></tr>
            ) : filteredRows.map((r, i) => (
              <tr key={`${r.part_no}|${r.make}`} data-testid={`low-stock-row-${r.part_no}`}>
                <td className="font-mono text-slate-500">{i + 1}</td>
                <td className="font-mono text-slate-600">{r.model || "—"}</td>
                <td><PartNoLink partNo={r.part_no} make={r.make} /></td>
                <td className="text-slate-600">{r.description_1 || "—"}</td>
                <td className="text-slate-600">{r.description_2 || "—"}</td>
                <td>{r.make}</td>
                <td className="text-center font-mono text-slate-700">{r.reorder_level}</td>
                <td className={`text-center font-mono font-bold ${r.total_quantity === 0 ? "text-red-700" : "text-amber-700"}`}>{r.total_quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
