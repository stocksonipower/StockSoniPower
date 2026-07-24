import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Button } from "../components/ui/button";
import { CaretLeft, CaretRight, DownloadSimple, ArrowsClockwise } from "@phosphor-icons/react";
import { useTableSortFilter, ColumnHeader } from "../components/DataTable";
import { exportToExcel } from "../lib/exportExcel";
import DocumentDetailDialog from "../components/DocumentDetailDialog";
import PartNoLink from "../components/PartNoLink";
import { toast } from "sonner";

const PAGE_SIZE = 500;

const fmtDateOnly = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
};
const fmtTimeOnly = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
};

function pickDocumentNo(t) {
  // Order of precedence: racking note > picking note > transfer note
  if (t.racking_note_no) return { kind: "racking", id: t.racking_note_id, no: t.racking_note_no };
  if (t.picking_note_no) return { kind: "picking", id: t.picking_note_id, no: t.picking_note_no };
  if (t.transfer_note_no) return { kind: "transfer", id: t.transfer_note_id, no: t.transfer_note_no };
  return { kind: null, id: null, no: "" };
}

export default function TransactionsPage() {
  const [txns, setTxns] = useState([]);
  const [filter, setFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [openDoc, setOpenDoc] = useState(null); // { kind, id, no }

  useEffect(() => { setPage(1); }, [filter]);

  const load = () => {
    setLoading(true);
    const params = { page, page_size: PAGE_SIZE };
    if (filter !== "ALL") params.type = filter;
    api.get("/transactions", { params }).then((r) => {
      setTxns(r.data);
      const t = parseInt(r.headers["x-total-count"], 10);
      setTotal(isNaN(t) ? r.data.length : t);
    }).finally(() => setLoading(false));
  };

  useEffect(load, [filter, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const columns = useMemo(() => [
    { key: "date", label: "Date", value: (t) => fmtDateOnly(t.created_at) },
    { key: "time", label: "Time", value: (t) => fmtTimeOnly(t.created_at) },
    { key: "type", label: "Type", value: (t) => t.type || "" },
    { key: "doc_no", label: "Document No", value: (t) => pickDocumentNo(t).no || "" },
    { key: "part_no", label: "Part No", value: (t) => t.part_no || "" },
    { key: "description_1", label: "Description 1", value: (t) => t.description_1 || "" },
    { key: "make", label: "Make", value: (t) => t.make || "" },
    { key: "godown", label: "Godown", value: (t) => t.godown_name || "" },
    { key: "rack_no", label: "Rack No", value: (t) => t.rack_no || "" },
    { key: "box_no", label: "Box No", value: (t) => t.box_no || "" },
    { key: "quantity", label: "Quantity", value: (t) => t.quantity ?? 0 },
    { key: "by_user", label: "By User", value: (t) => t.created_by || "" },
  ], []);

  const { filteredRows, getColumnHeaderProps } = useTableSortFilter(txns, columns);

  const handleExport = () => {
    if (filteredRows.length === 0) { toast.error("No rows to export"); return; }
    const tabName = filter === "IN" ? "Stock_In" : filter === "OUT" ? "Stock_Out" : "Transactions";
    const exportCols = [
      { label: "Sl No", value: (r) => filteredRows.indexOf(r) + 1 },
      ...columns,
    ];
    exportToExcel(filteredRows, exportCols, `${tabName}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <div className="p-8 max-w-[1700px] mx-auto" data-testid="transactions-page">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <div className="label-sm mb-2">History</div>
          <h1 className="text-4xl font-black tracking-tight text-slate-900">Transactions</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleExport} variant="outline" className="rounded-sm border-slate-300" data-testid="transactions-export-button">
            <DownloadSimple size={14} weight="bold" className="mr-2" /> Export
          </Button>
          <Button onClick={load} variant="outline" className="rounded-sm border-slate-300" disabled={loading} data-testid="transactions-refresh-button">
            <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      <Tabs value={filter} onValueChange={setFilter} className="mb-4">
        <TabsList className="rounded-sm">
          <TabsTrigger value="ALL" className="rounded-sm" data-testid="filter-all">All</TabsTrigger>
          <TabsTrigger value="IN" className="rounded-sm" data-testid="filter-in">Stock In</TabsTrigger>
          <TabsTrigger value="OUT" className="rounded-sm" data-testid="filter-out">Stock Out</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="bg-white border border-slate-200 rounded-sm overflow-visible">
        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="w-14">Sl No</th>
                <ColumnHeader {...getColumnHeaderProps("date")} label="Date" testid="tx-col-date" />
                <ColumnHeader {...getColumnHeaderProps("time")} label="Time" testid="tx-col-time" />
                <ColumnHeader {...getColumnHeaderProps("type")} label="Type" testid="tx-col-type" />
                <ColumnHeader {...getColumnHeaderProps("doc_no")} label="Document No" testid="tx-col-doc-no" />
                <ColumnHeader {...getColumnHeaderProps("part_no")} label="Part No" testid="tx-col-part-no" />
                <ColumnHeader {...getColumnHeaderProps("description_1")} label="Description 1" testid="tx-col-desc1" />
                <ColumnHeader {...getColumnHeaderProps("make")} label="Make" testid="tx-col-make" />
                <ColumnHeader {...getColumnHeaderProps("godown")} label="Godown" testid="tx-col-godown" />
                <ColumnHeader {...getColumnHeaderProps("rack_no")} label="Rack No" testid="tx-col-rack" />
                <ColumnHeader {...getColumnHeaderProps("box_no")} label="Box No" testid="tx-col-box" />
                <ColumnHeader {...getColumnHeaderProps("quantity")} align="right" label="Quantity" testid="tx-col-qty" />
                <ColumnHeader {...getColumnHeaderProps("by_user")} label="By User" testid="tx-col-user" />
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((t, i) => {
                const doc = pickDocumentNo(t);
                return (
                  <tr key={t.id} data-testid={`tx-row-${t.id}`}>
                    <td className="font-mono text-slate-500">{i + 1}</td>
                    <td className="text-xs font-mono text-slate-500">{fmtDateOnly(t.created_at)}</td>
                    <td className="text-xs font-mono text-slate-500">{fmtTimeOnly(t.created_at)}</td>
                    <td>
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${
                        t.type === "IN" ? "bg-green-50 text-green-700" : "bg-orange-50 text-orange-700"
                      }`}>{t.type}</span>
                    </td>
                    <td>
                      {doc.no ? (
                        <button
                          onClick={() => setOpenDoc(doc)}
                          className="font-mono font-semibold text-blue-700 hover:underline"
                          data-testid={`tx-doc-${t.id}`}
                        >
                          {doc.no}
                        </button>
                      ) : <span className="text-slate-400">—</span>}
                    </td>
                    <td><PartNoLink partNo={t.part_no} make={t.make} /></td>
                    <td className="text-slate-700 max-w-[260px] truncate" title={t.description_1}>{t.description_1 || "—"}</td>
                    <td>{t.make}</td>
                    <td>{t.godown_name}</td>
                    <td className="font-mono">{t.rack_no}</td>
                    <td className="font-mono">{t.box_no}</td>
                    <td className="text-right font-mono font-bold">{t.quantity}</td>
                    <td className="text-xs text-slate-500">{t.created_by}</td>
                  </tr>
                );
              })}
              {filteredRows.length === 0 && (
                <tr><td colSpan={13} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (txns.length === 0 ? "No transactions." : "No rows match the current filters.")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between mt-3 text-xs text-slate-600" data-testid="transactions-pagination">
        <div>
          {total === 0 ? "No transactions" : (
            <>Showing <span className="font-semibold text-slate-900">{filteredRows.length}</span> of <span className="font-semibold text-slate-900">{txns.length}</span> on this page · <span className="font-semibold text-slate-900">{total}</span> total</>
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
          <span className="text-slate-400 ml-2">{PAGE_SIZE} / page</span>
        </div>
      </div>

      <DocumentDetailDialog
        kind={openDoc?.kind}
        id={openDoc?.id}
        no={openDoc?.no}
        onClose={() => setOpenDoc(null)}
      />
    </div>
  );
}
