import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { toast } from "sonner";
import { api } from "../lib/api";
import {
  MagnifyingGlass, Package, ArrowDown, ArrowUp, ArrowsLeftRight,
  Stack, Warning, Plus, ClockCounterClockwise, MapPin,
} from "@phosphor-icons/react";

/* ---------- helpers ---------- */
const fmtDate = (s) => {
  if (!s) return "—";
  try {
    const d = new Date(s.length === 10 ? `${s}T00:00:00` : s);
    return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
  } catch { return s; }
};
const num = (v) => (v == null || v === "" ? "—" : (typeof v === "number" ? v : Number(v)));

const STATUS_CLS = {
  DRAFT: "bg-slate-100 text-slate-700",
  FINAL: "bg-amber-50 text-amber-800",
  RACKING_PENDING: "bg-amber-50 text-amber-800",
  PARTIALLY_RACKED: "bg-blue-50 text-blue-800",
  FULLY_RACKED: "bg-green-100 text-green-800",
  RECORDED: "bg-green-100 text-green-800",
  PENDING: "bg-amber-50 text-amber-800",
  PARTIALLY_RECEIVED: "bg-blue-50 text-blue-800",
  FULLY_RECEIVED: "bg-green-100 text-green-800",
  ACCEPTED: "bg-green-100 text-green-800",
  REJECTED: "bg-red-50 text-red-700",
};
function StatusPill({ s }) {
  if (!s) return null;
  const cls = STATUS_CLS[s] || "bg-slate-100 text-slate-700";
  return (
    <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-sm ${cls}`}>
      {s.replace(/_/g, " ")}
    </span>
  );
}

/* ---------- main page ---------- */
export default function ItemDetailsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [showResults, setShowResults] = useState(false);
  const [selected, setSelected] = useState(null); // {part_no, make}
  const [details, setDetails] = useState(null);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef(null);
  const inputRef = useRef(null);

  // Hydrate selection from URL params (deep-link from anywhere in the app).
  useEffect(() => {
    const pn = (searchParams.get("part_no") || "").trim();
    const mk = (searchParams.get("make") || "").trim();
    if (pn) {
      setSelected({ part_no: pn, make: mk });
      setQuery(`${pn}${mk ? ` / ${mk}` : ""}`);
      setShowResults(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      api.get("/item-details/search", { params: { q: query, limit: 20 } })
        .then(({ data }) => setResults(data || []))
        .catch(() => setResults([]));
    }, 220);
    return () => debounceRef.current && clearTimeout(debounceRef.current);
  }, [query]);

  // Pre-load all on mount so dropdown can show top items immediately
  useEffect(() => {
    api.get("/item-details/search", { params: { q: "", limit: 20 } })
      .then(({ data }) => setResults(data || []))
      .catch(() => {});
  }, []);

  // Fetch full details when selection changes
  useEffect(() => {
    if (!selected) { setDetails(null); return; }
    setLoading(true);
    api.get("/item-details", { params: { part_no: selected.part_no, make: selected.make } })
      .then(({ data }) => setDetails(data))
      .catch((err) => toast.error(err?.response?.data?.detail || "Could not load item details"))
      .finally(() => setLoading(false));
  }, [selected]);

  const pickItem = (it) => {
    setSelected({ part_no: it.part_no, make: it.make });
    setQuery(`${it.part_no} / ${it.make}`);
    setShowResults(false);
    // Reflect in URL so this can be shared / back-buttoned.
    setSearchParams({ part_no: it.part_no, make: it.make }, { replace: true });
  };

  return (
    <div className="p-8 max-w-7xl mx-auto" data-testid="item-details-page">
      <div className="mb-1 text-xs uppercase font-bold tracking-[0.18em] text-slate-500">Stock Lookup</div>
      <h1 className="text-4xl font-black tracking-tight text-slate-900 mb-6">Item Details</h1>

      {/* Search box */}
      <Card className="rounded-sm border-slate-200 mb-6">
        <CardContent className="p-4">
          <div className="relative">
            <MagnifyingGlass size={16} weight="bold" className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setShowResults(true); }}
              onFocus={() => setShowResults(true)}
              placeholder="Search by Part No or Make…"
              className="pl-10 rounded-sm h-11 font-mono"
              data-testid="item-details-search-input"
            />
            {showResults && results.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-sm shadow-lg max-h-96 overflow-y-auto z-50" data-testid="item-details-search-results">
                {results.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => pickItem(r)}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 border-b border-slate-100 last:border-b-0 flex items-center gap-3"
                    data-testid={`item-details-result-${r.part_no}-${r.make}`}
                  >
                    <Package size={14} weight="bold" className="text-blue-700" />
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-sm font-bold text-slate-900">{r.part_no}</div>
                      <div className="text-xs text-slate-500 truncate">
                        {r.make} · {r.description_1 || "—"}{r.model ? ` · ${r.model}` : ""}
                      </div>
                    </div>
                    {r.item_category && (
                      <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-slate-100 text-slate-700">
                        {r.item_category}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          {selected && (
            <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
              <span>Showing details for</span>
              <span className="font-mono font-bold text-slate-900">{selected.part_no}</span>
              <span className="text-slate-400">/</span>
              <span className="font-mono text-slate-700">{selected.make}</span>
              <button
                onClick={() => { setSelected(null); setQuery(""); setDetails(null); setSearchParams({}, { replace: true }); inputRef.current?.focus(); }}
                className="ml-auto text-blue-700 hover:underline font-semibold"
                data-testid="item-details-clear-button"
              >Clear</button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Empty state */}
      {!selected && (
        <div className="text-center py-20 text-slate-400" data-testid="item-details-empty-state">
          <Package size={64} weight="thin" className="mx-auto mb-4" />
          <div className="text-sm">Search for a Part No or Make to see its full transaction history.</div>
        </div>
      )}

      {/* Loading */}
      {selected && loading && (
        <div className="text-center py-12 text-slate-500" data-testid="item-details-loading">Loading…</div>
      )}

      {/* Detail panels */}
      {selected && !loading && details && (
        <ItemDetailsContent details={details} selected={selected} />
      )}
    </div>
  );
}

/* ---------- detail panels ---------- */
function ItemDetailsContent({ details, selected }) {
  const m = details.master;
  const t = details.totals || {};
  return (
    <div className="space-y-6" data-testid="item-details-content">
      {/* Master card */}
      <Card className="rounded-sm border-slate-200">
        <CardContent className="p-6">
          <div className="flex items-start justify-between flex-wrap gap-4">
            <div>
              <div className="text-xs uppercase font-bold tracking-[0.18em] text-slate-500 mb-1">Stock Master</div>
              <h2 className="text-3xl font-black font-mono text-slate-900" data-testid="item-master-part-no">{selected.part_no}</h2>
              <div className="text-sm text-slate-600 mt-1 font-mono">{selected.make}</div>
            </div>
            <div className="text-right">
              <div className="text-xs uppercase font-bold tracking-[0.18em] text-slate-500">Current Stock</div>
              <div className="text-4xl font-black text-blue-700 font-mono" data-testid="item-master-current-stock">{t.current_stock || 0}</div>
              <div className="text-xs text-slate-500 mt-1">across {details.stock_balance.length} location(s)</div>
            </div>
          </div>
          {m ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-6 pt-6 border-t border-slate-100">
              <Field k="Description 1" v={m.description_1} />
              <Field k="Description 2" v={m.description_2} />
              <Field k="Model" v={m.model} />
              <Field k="Category" v={m.item_category} />
              <Field k="Old Part No" v={m.old_part_no} />
              <Field k="Make Part No" v={m.make_part_no} />
              <Field k="Remarks (OEM)" v={m.remarks_oem} />
              <Field k="Remarks (Others)" v={m.remarks_others} />
              <Field k="Min Stock Qty" v={m.min_stock_qty} />
              <Field k="Max Stock Qty" v={m.max_stock_qty} />
              <Field k="Re-order Qty" v={m.reorder_qty} />
              <Field k="Unit" v={m.unit} />
            </div>
          ) : (
            <div className="mt-4 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-sm p-3">
              No stock-master record exists for this Part No / Make combination. Transactional history is shown below.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Totals strip */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3" data-testid="item-totals-strip">
        <StatTile label="Received" value={t.received_qty} icon={ArrowDown} tone="emerald" />
        <StatTile label="Racked" value={t.racked_qty} icon={Stack} tone="blue" />
        <StatTile label="Issued" value={t.issued_qty} icon={ArrowUp} tone="rose" />
        <StatTile label="Picked" value={t.picked_qty} icon={ArrowUp} tone="indigo" />
        <StatTile label="Transferred" value={t.transferred_qty} icon={ArrowsLeftRight} tone="violet" />
        <StatTile label="Ledger Entries" value={t.txn_count} icon={ClockCounterClockwise} tone="slate" />
      </div>

      {/* Per-location balance */}
      <Section title="Current Stock by Location" count={details.stock_balance.length} icon={MapPin}>
        {details.stock_balance.length === 0 ? <Empty>No stock available for this item.</Empty> : (
          <Tbl
            cols={["Godown", "Rack", "Box", "Quantity"]}
            align={["left", "left", "left", "right"]}
            rows={details.stock_balance.map((r) => [
              r.godown_name || "—", r.rack_no || "—", r.box_no || "—",
              <span className="font-bold text-slate-900">{r.quantity ?? 0}</span>,
            ])}
          />
        )}
      </Section>

      {/* Receipt Notes */}
      <Section title="Receipt Notes" count={details.receipt_notes.length} icon={ArrowDown}>
        {details.receipt_notes.length === 0 ? <Empty>No receipt notes.</Empty> : (
          <Tbl
            cols={["RN No", "Date", "Type", "Invoice No", "Invoice Qty", "Received Qty", "Status"]}
            align={["left", "left", "left", "left", "right", "right", "left"]}
            rows={details.receipt_notes.flatMap((r) => r.items.map((it) => [
              <span className="font-mono font-bold">{r.rn_no}</span>, fmtDate(r.rn_date),
              <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-slate-100 text-slate-700">{(r.stock_in_type || "INVOICE").toLowerCase()}</span>,
              r.invoice_no || "—",
              num(it.invoice_qty), num(it.received_qty),
              <StatusPill s={r.status} />,
            ]))}
          />
        )}
      </Section>

      {/* SRN */}
      <Section title="Short Received Notes (SRN)" count={details.short_received_notes.length} icon={Warning}>
        {details.short_received_notes.length === 0 ? <Empty>No SRN entries.</Empty> : (
          <Tbl
            cols={["SRN No", "Date", "Parent RN", "Short Qty", "Fulfilled", "Status"]}
            align={["left", "left", "left", "right", "right", "left"]}
            rows={details.short_received_notes.flatMap((r) => r.items.map((it) => [
              <span className="font-mono font-bold">{r.srn_no}</span>, fmtDate(r.srn_date),
              <span className="font-mono">{r.parent_rn_no || "—"}</span>,
              num(it.short_qty), num(it.fulfilled_qty),
              <StatusPill s={r.status} />,
            ]))}
          />
        )}
      </Section>

      {/* ERN */}
      <Section title="Extra Received Notes (ERN)" count={details.extra_received_notes.length} icon={Plus}>
        {details.extra_received_notes.length === 0 ? <Empty>No ERN entries.</Empty> : (
          <Tbl
            cols={["ERN No", "Date", "Parent RN", "Extra Qty", "Accepted", "Rejected", "Status"]}
            align={["left", "left", "left", "right", "right", "right", "left"]}
            rows={details.extra_received_notes.flatMap((r) => r.items.map((it) => [
              <span className="font-mono font-bold">{r.ern_no}</span>, fmtDate(r.ern_date),
              <span className="font-mono">{r.parent_rn_no || "—"}</span>,
              num(it.extra_qty), num(it.accepted_qty), num(it.rejected_qty),
              <StatusPill s={r.status} />,
            ]))}
          />
        )}
      </Section>

      {/* Racking Notes */}
      <Section title="Racking Notes" count={details.racking_notes.length} icon={Stack}>
        {details.racking_notes.length === 0 ? <Empty>No racking notes.</Empty> : (
          <Tbl
            cols={["RKN No", "Date", "Source", "Godown", "Rack", "Box", "Qty", "Status"]}
            align={["left", "left", "left", "left", "left", "left", "right", "left"]}
            rows={details.racking_notes.flatMap((r) => r.items.map((it) => [
              <span className="font-mono font-bold">{r.rkn_no}</span>, fmtDate(r.rkn_date),
              <span className="font-mono text-xs">{r.source_no || r.receipt_note_no}</span>,
              it.godown_name || "—", it.rack_no || "—", it.box_no || "—",
              num(it.quantity),
              <StatusPill s={r.status} />,
            ]))}
          />
        )}
      </Section>

      {/* Issue Notes */}
      <Section title="Issue Notes" count={details.issue_notes.length} icon={ArrowUp}>
        {details.issue_notes.length === 0 ? <Empty>No issue notes.</Empty> : (
          <Tbl
            cols={["IN No", "Date", "Issued To", "Qty", "Status"]}
            align={["left", "left", "left", "right", "left"]}
            rows={details.issue_notes.flatMap((r) => r.items.map((it) => [
              <span className="font-mono font-bold">{r.in_no}</span>, fmtDate(r.in_date),
              r.issued_to_name || r.issued_to || "—",
              num(it.issued_qty || it.quantity),
              <StatusPill s={r.status} />,
            ]))}
          />
        )}
      </Section>

      {/* Picking Notes */}
      <Section title="Picking Notes" count={details.picking_notes.length} icon={ArrowUp}>
        {details.picking_notes.length === 0 ? <Empty>No picking notes.</Empty> : (
          <Tbl
            cols={["PN No", "Date", "Source", "Godown", "Rack", "Box", "Qty", "Status"]}
            align={["left", "left", "left", "left", "left", "left", "right", "left"]}
            rows={details.picking_notes.flatMap((r) => r.items.map((it) => [
              <span className="font-mono font-bold">{r.pn_no}</span>, fmtDate(r.pn_date),
              <span className="font-mono text-xs">{r.issue_note_no || "—"}</span>,
              it.godown_name || "—", it.rack_no || "—", it.box_no || "—",
              num(it.quantity),
              <StatusPill s={r.status} />,
            ]))}
          />
        )}
      </Section>

      {/* Transfer Requests */}
      <Section title="Transfer Requests" count={details.transfer_requests.length} icon={ArrowsLeftRight}>
        {details.transfer_requests.length === 0 ? <Empty>No transfer requests.</Empty> : (
          <Tbl
            cols={["STR No", "Date", "From → To", "Qty", "Status"]}
            align={["left", "left", "left", "right", "left"]}
            rows={details.transfer_requests.flatMap((r) => r.items.map((it) => [
              <span className="font-mono font-bold">{r.str_no}</span>, fmtDate(r.str_date),
              `${r.source_godown_name || "—"} → ${r.dest_godown_name || "—"}`,
              num(it.quantity),
              <StatusPill s={r.status} />,
            ]))}
          />
        )}
      </Section>

      {/* Transfer Notes */}
      <Section title="Transfer Notes" count={details.transfer_notes.length} icon={ArrowsLeftRight}>
        {details.transfer_notes.length === 0 ? <Empty>No transfer notes.</Empty> : (
          <Tbl
            cols={["STN No", "Date", "From → To", "Qty", "Status"]}
            align={["left", "left", "left", "right", "left"]}
            rows={details.transfer_notes.flatMap((r) => r.items.map((it) => [
              <span className="font-mono font-bold">{r.stn_no}</span>, fmtDate(r.stn_date),
              `${r.source_godown_name || "—"} → ${r.dest_godown_name || "—"}`,
              num(it.quantity),
              <StatusPill s={r.status} />,
            ]))}
          />
        )}
      </Section>

      {/* Stock Ledger */}
      <Section title="Stock Ledger" count={details.transactions.length} icon={ClockCounterClockwise}>
        {details.transactions.length === 0 ? <Empty>No ledger entries.</Empty> : (
          <Tbl
            cols={["Date", "Type", "Ref Doc", "Location", "Qty", "Balance After"]}
            align={["left", "left", "left", "left", "right", "right"]}
            rows={details.transactions.map((tx) => [
              fmtDate(tx.created_at),
              <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-sm ${
                tx.txn_type === "IN" ? "bg-emerald-100 text-emerald-800" :
                tx.txn_type === "OUT" ? "bg-rose-100 text-rose-800" : "bg-violet-100 text-violet-800"
              }`}>{tx.txn_type}</span>,
              <span className="font-mono text-xs">{tx.ref_no || tx.ref_id || "—"}</span>,
              `${tx.godown_name || "—"} / ${tx.rack_no || "—"} / ${tx.box_no || "—"}`,
              num(tx.quantity),
              num(tx.balance_after),
            ])}
          />
        )}
      </Section>
    </div>
  );
}

/* ---------- atoms ---------- */
function Field({ k, v }) {
  return (
    <div>
      <div className="text-[10px] uppercase font-bold tracking-wider text-slate-500">{k}</div>
      <div className="font-mono text-sm text-slate-900 mt-1">{v != null && v !== "" ? v : "—"}</div>
    </div>
  );
}

function StatTile({ label, value, icon: Icon, tone }) {
  const tones = {
    emerald: "bg-emerald-50 text-emerald-800 border-emerald-100",
    blue: "bg-blue-50 text-blue-800 border-blue-100",
    rose: "bg-rose-50 text-rose-800 border-rose-100",
    indigo: "bg-indigo-50 text-indigo-800 border-indigo-100",
    violet: "bg-violet-50 text-violet-800 border-violet-100",
    slate: "bg-slate-50 text-slate-800 border-slate-100",
  };
  return (
    <div className={`rounded-sm border p-3 ${tones[tone] || tones.slate}`} data-testid={`item-stat-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex items-center justify-between">
        <Icon size={14} weight="bold" />
        <div className="text-[10px] uppercase font-bold tracking-wider opacity-70">{label}</div>
      </div>
      <div className="text-2xl font-black font-mono mt-1">{value || 0}</div>
    </div>
  );
}

function Section({ title, count, icon: Icon, children }) {
  const [open, setOpen] = useState(true);
  return (
    <Card className="rounded-sm border-slate-200">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between p-4 hover:bg-slate-50 transition-colors"
        data-testid={`item-section-${title.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <div className="flex items-center gap-3">
          {Icon && <Icon size={18} weight="bold" className="text-slate-600" />}
          <h3 className="text-base font-bold text-slate-900">{title}</h3>
          <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-slate-100 text-slate-700">
            {count}
          </span>
        </div>
        <span className="text-xs text-slate-400">{open ? "Hide" : "Show"}</span>
      </button>
      {open && <div className="border-t border-slate-100 p-4">{children}</div>}
    </Card>
  );
}

function Empty({ children }) {
  return <div className="text-center text-sm text-slate-400 py-6">{children}</div>;
}

function Tbl({ cols, align, rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="data-table w-full">
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i} className={align?.[i] === "right" ? "text-right" : ""}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className={`${align?.[j] === "right" ? "text-right font-mono" : ""}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
