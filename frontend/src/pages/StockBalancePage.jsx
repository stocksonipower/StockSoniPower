import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Popover, PopoverTrigger, PopoverContent } from "../components/ui/popover";
import { ScrollArea } from "../components/ui/scroll-area";
import { MagnifyingGlass, ArrowsClockwise, Image as ImgIcon, FunnelSimple, X, CaretDown, DownloadSimple } from "@phosphor-icons/react";
import AuthImage from "../components/AuthImage";
import ImageViewerDialog from "../components/ImageViewerDialog";
import PartNoLink from "../components/PartNoLink";
import { exportToExcel } from "../lib/exportExcel";
import { toast } from "sonner";

// Helper: row has any image (new images[] array OR legacy image string)
const rowHasImage = (r) => (Array.isArray(r.images) && r.images.length > 0) || !!r.image;

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
  { key: "reorder_level", label: "REORDER LEVEL", className: "font-mono", isNumeric: true, total: true },
  { key: "image", label: "IMAGE", className: "", isImage: true },
  { key: "godown_name", label: "GODOWN", className: "" },
  { key: "rack_no", label: "RACK NO", className: "font-mono" },
  { key: "box_no", label: "BOX NO", className: "font-mono" },
  { key: "box_category", label: "BOX CATEGORY", className: "" },
  { key: "total_quantity", label: "QTY", className: "text-center font-mono font-bold", isQty: true, isNumeric: true, total: true },
];

const BLANK = "(Blank)";

export default function StockBalancePage() {
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  // colFilters: { [colKey]: Set<string of allowed values> }
  const [colFilters, setColFilters] = useState({});
  // sort: { key, dir } | null
  const [sort, setSort] = useState(null);

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

  // Build a map of unique values per column from the currently loaded rows
  const uniqueValues = useMemo(() => {
    const map = {};
    COLUMNS.forEach((c) => {
      if (c.isImage) {
        map[c.key] = ["Has image", "No image"];
      } else {
        const seen = new Set();
        rows.forEach((r) => {
          const raw = r[c.key];
          const v = raw === null || raw === undefined || raw === "" ? BLANK : String(raw);
          seen.add(v);
        });
        map[c.key] = [...seen].sort((a, b) => {
          if (a === BLANK) return 1;
          if (b === BLANK) return -1;
          // numeric sort if both look like numbers
          const na = Number(a), nb = Number(b);
          if (!isNaN(na) && !isNaN(nb)) return na - nb;
          return a.localeCompare(b);
        });
      }
    });
    return map;
  }, [rows]);

  const filteredRows = useMemo(() => {
    const activeKeys = Object.keys(colFilters);
    let out = rows;
    if (activeKeys.length > 0) {
      out = rows.filter((row) => activeKeys.every((k) => {
        const allowed = colFilters[k];
        if (!allowed || allowed.size === 0) return true;
        const col = COLUMNS.find((c) => c.key === k);
        if (col?.isImage) {
          const tag = rowHasImage(row) ? "Has image" : "No image";
          return allowed.has(tag);
        }
        const raw = row[k];
        const v = raw === null || raw === undefined || raw === "" ? BLANK : String(raw);
        return allowed.has(v);
      }));
    }
    if (sort && sort.key) {
      const col = COLUMNS.find((c) => c.key === sort.key);
      if (col) {
        const dir = sort.dir === "desc" ? -1 : 1;
        out = [...out].sort((a, b) => {
          let av, bv;
          if (col.isImage) {
            av = rowHasImage(a) ? "Has image" : "No image";
            bv = rowHasImage(b) ? "Has image" : "No image";
          } else {
            av = a[col.key];
            bv = b[col.key];
          }
          if (col.isNumeric) {
            const an = parseFloat(av);
            const bn = parseFloat(bv);
            const aNa = isNaN(an), bNa = isNaN(bn);
            if (aNa && bNa) return 0;
            if (aNa) return 1;
            if (bNa) return -1;
            return (an - bn) * dir;
          }
          const as = av === null || av === undefined ? "" : String(av);
          const bs = bv === null || bv === undefined ? "" : String(bv);
          return as.localeCompare(bs, undefined, { numeric: true, sensitivity: "base" }) * dir;
        });
      }
    }
    return out;
  }, [rows, colFilters, sort]);

  // Compute totals over the *visible* filtered rows for columns marked total: true
  const totals = useMemo(() => {
    const t = {};
    COLUMNS.forEach((c) => {
      if (!c.total) return;
      let sum = 0;
      filteredRows.forEach((r) => {
        const n = parseFloat(r[c.key]);
        if (!isNaN(n)) sum += n;
      });
      t[c.key] = sum;
    });
    return t;
  }, [filteredRows]);

  const setColumnSort = (key, dir) => {
    if (!dir) setSort((s) => (s && s.key === key ? null : s));
    else setSort({ key, dir });
  };

  const setColFilter = (key, allowedSet) => {
    setColFilters((f) => {
      const next = { ...f };
      if (!allowedSet || allowedSet.size === 0) delete next[key];
      else next[key] = allowedSet;
      return next;
    });
  };

  const activeFilterCount = Object.keys(colFilters).length;
  const dash = <span className="text-slate-300">—</span>;

  // Image viewer state
  const [viewer, setViewer] = useState(null); // { images, idx }

  // Export visible (filtered) rows to Excel — covers all displayed columns
  const handleExport = () => {
    if (filteredRows.length === 0) { toast.error("No rows to export"); return; }
    const exportCols = [
      { label: "Sl No", value: (r) => filteredRows.indexOf(r) + 1 },
      ...COLUMNS.filter((c) => !c.isImage).map((c) => ({
        label: c.label,
        value: (r) => {
          const v = r[c.key];
          return v === null || v === undefined ? "" : v;
        },
      })),
      { label: "IMAGES", value: (r) => {
        const list = Array.isArray(r.images) && r.images.length > 0 ? r.images : (r.image ? [r.image] : []);
        return list.length > 0 ? `${list.length} image(s)` : "";
      } },
    ];
    exportToExcel(filteredRows, exportCols, `Stock_Summary_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

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
        <div className="flex items-center gap-2">
          <Button onClick={handleExport} variant="outline" className="rounded-sm border-slate-300" data-testid="balance-export-button">
            <DownloadSimple size={14} weight="bold" className="mr-2" /> Export
          </Button>
          <Button onClick={() => load(search)} variant="outline" className="rounded-sm border-slate-300" disabled={loading} data-testid="refresh-button">
            <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
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
          <span>{activeFilterCount > 0 ? `${activeFilterCount} column filter(s) active` : "Click any column header dropdown to filter, like Excel"}</span>
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
                <th key={c.key} className={c.isQty ? "text-center" : ""}>
                  <ColumnFilter
                    label={c.label}
                    values={uniqueValues[c.key] || []}
                    selected={colFilters[c.key]}
                    onChange={(s) => setColFilter(c.key, s)}
                    sortDir={sort?.key === c.key ? sort.dir : null}
                    onSort={(dir) => setColumnSort(c.key, dir)}
                    isImage={c.isImage}
                    isQty={c.isQty}
                    isNumeric={c.isNumeric}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.length > 0 && (
              <tr className="bg-amber-50 border-b-2 border-amber-200 sticky top-0 z-10" data-testid="totals-row">
                <td className="font-bold text-amber-900 text-[10px] uppercase tracking-wider">TOTAL</td>
                {COLUMNS.map((c) => {
                  if (c.total) {
                    return (
                      <td key={c.key} className={`${c.isQty ? "text-center" : ""} font-mono font-black text-amber-900`} data-testid={`totals-${c.key}`}>
                        {totals[c.key]}
                      </td>
                    );
                  }
                  return <td key={c.key} className="text-amber-900/40">—</td>;
                })}
              </tr>
            )}
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="text-center py-12 text-slate-500">
                  {loading ? "Loading…" : (search || activeFilterCount > 0 ? "No matches." : "No stock recorded yet.")}
                </td>
              </tr>
            ) : filteredRows.map((r, i) => (
              <tr key={`${r.part_no}|${r.make}|${r.godown_id}|${r.rack_id}|${r.box_id}`} data-testid={`balance-row-${i}`}>
                <td className="font-mono text-slate-500">{i + 1}</td>
                {COLUMNS.map((c) => {
                  if (c.isImage) {
                    const list = Array.isArray(r.images) && r.images.length > 0 ? r.images : (r.image ? [r.image] : []);
                    return (
                      <td key={c.key}>
                        {list.length === 0 ? (
                          <div className="h-10 w-10 flex items-center justify-center bg-slate-50 border border-slate-200 rounded-sm text-slate-400">
                            <ImgIcon size={14} />
                          </div>
                        ) : (
                          <div className="relative inline-flex items-center" data-testid={`balance-image-${i}`}>
                            <AuthImage
                              path={list[0]}
                              alt=""
                              className="h-10 w-10 object-cover rounded-sm border border-slate-200 cursor-pointer hover:opacity-80"
                              onClick={() => setViewer({ images: list, idx: 0 })}
                              testid={`balance-image-thumb-${i}`}
                            />
                            {list.length > 1 && (
                              <span className="ml-1 text-[10px] font-mono font-bold text-slate-700 bg-slate-100 px-1 rounded-sm">
                                +{list.length - 1}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                    );
                  }
                  if (c.isQty) {
                    return (
                      <td key={c.key} className={`text-center font-mono font-bold ${r.total_quantity <= 5 ? "text-red-700" : "text-slate-900"}`}>
                        {r.total_quantity}
                      </td>
                    );
                  }
                  if (c.key === "part_no") {
                    return (
                      <td key={c.key} className={c.className}>
                        <PartNoLink partNo={r.part_no} make={r.make} />
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

      <ImageViewerDialog
        open={!!viewer}
        images={viewer?.images || []}
        startIndex={viewer?.idx || 0}
        onClose={() => setViewer(null)}
      />
    </div>
  );
}

/* ============================================================ */
/* Excel-style column header dropdown filter                     */
/* ============================================================ */
function ColumnFilter({ label, values, selected, onChange, sortDir, onSort, isImage, isQty, isNumeric }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Local working set
  const [working, setWorking] = useState(null);

  // sync working set when popover opens
  useEffect(() => {
    if (open) {
      setQuery("");
      // If filter is active, working = current selected; if not active, all values are "selected" (default).
      if (selected && selected.size > 0) setWorking(new Set(selected));
      else setWorking(new Set(values));
    }
  }, [open, selected, values]);

  const filteredValues = useMemo(() => {
    if (!query) return values;
    const q = query.toLowerCase();
    return values.filter((v) => String(v).toLowerCase().includes(q));
  }, [values, query]);

  const allInViewSelected = working && filteredValues.every((v) => working.has(v));
  const noneInViewSelected = working && filteredValues.every((v) => !working.has(v));

  const toggle = (v) => {
    setWorking((w) => {
      const next = new Set(w);
      if (next.has(v)) next.delete(v); else next.add(v);
      return next;
    });
  };
  const toggleAllInView = () => {
    setWorking((w) => {
      const next = new Set(w);
      if (allInViewSelected) filteredValues.forEach((v) => next.delete(v));
      else filteredValues.forEach((v) => next.add(v));
      return next;
    });
  };

  const apply = () => {
    if (!working) return;
    // If user has all values selected → no filter
    if (working.size === values.length) onChange(null);
    else onChange(working);
    setOpen(false);
  };

  const clear = () => {
    setWorking(new Set(values));
    onChange(null);
    setOpen(false);
  };

  const isFilterActive = !!(selected && selected.size > 0);
  const isSortActive = !!sortDir;
  const isActive = isFilterActive || isSortActive;
  const sortIcon = sortDir === "asc"
    ? <span className="text-blue-700 text-[10px] font-bold ml-0.5">▲</span>
    : sortDir === "desc"
      ? <span className="text-blue-700 text-[10px] font-bold ml-0.5">▼</span>
      : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={`group flex items-center gap-1 ${isQty ? "mx-auto" : ""} ${isActive ? "text-blue-700" : "text-slate-500 hover:text-slate-900"}`}
          data-testid={`filter-trigger-${label.toLowerCase().replace(/\s+/g, "-")}`}
        >
          <span className="font-bold tracking-[0.15em]">{label}</span>
          {sortIcon}
          <CaretDown size={10} weight="bold" className={`opacity-60 group-hover:opacity-100 ${isActive ? "opacity-100" : ""}`} />
          {isFilterActive && <span className="ml-1 text-[9px] bg-blue-100 text-blue-800 px-1 rounded-sm font-mono">{selected.size}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0 rounded-sm" align="start">
        {onSort && (
          <div className="border-b border-slate-200 flex">
            <button
              type="button"
              onClick={() => { onSort(sortDir === "asc" ? null : "asc"); setOpen(false); }}
              className={`flex-1 flex items-center gap-2 px-3 py-2 text-xs hover:bg-slate-100 ${sortDir === "asc" ? "bg-blue-50 text-blue-700 font-semibold" : "text-slate-700"}`}
              data-testid="sort-asc"
            >
              ▲ Sort {isNumeric ? "Smallest → Largest" : "A → Z"}
            </button>
            <button
              type="button"
              onClick={() => { onSort(sortDir === "desc" ? null : "desc"); setOpen(false); }}
              className={`flex-1 flex items-center gap-2 px-3 py-2 text-xs hover:bg-slate-100 ${sortDir === "desc" ? "bg-blue-50 text-blue-700 font-semibold" : "text-slate-700"}`}
              data-testid="sort-desc"
            >
              ▼ Sort {isNumeric ? "Largest → Smallest" : "Z → A"}
            </button>
          </div>
        )}
        <div className="p-2 border-b border-slate-200">
          <Input
            placeholder="Search values…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 rounded-sm text-xs"
            autoFocus
            data-testid="filter-search-input"
          />
        </div>
        <div className="px-2 py-1 border-b border-slate-200 bg-slate-50 flex items-center gap-2">
          <Checkbox
            checked={allInViewSelected}
            data-state={allInViewSelected ? "checked" : (noneInViewSelected ? "unchecked" : "indeterminate")}
            onCheckedChange={toggleAllInView}
            data-testid="filter-select-all"
          />
          <span className="text-[11px] text-slate-600 font-semibold">
            {allInViewSelected ? "Deselect all" : "Select all"}
            {query && filteredValues.length !== values.length && ` (${filteredValues.length})`}
          </span>
        </div>
        <ScrollArea className="h-56">
          <ul className="py-1">
            {filteredValues.length === 0 && (
              <li className="px-3 py-2 text-xs text-slate-400">No values match.</li>
            )}
            {filteredValues.map((v) => (
              <li key={v} className="px-3 py-1.5 flex items-center gap-2 hover:bg-slate-50 cursor-pointer" onClick={() => toggle(v)}>
                <Checkbox
                  checked={working?.has(v) ?? false}
                  onCheckedChange={() => toggle(v)}
                  onClick={(e) => e.stopPropagation()}
                  data-testid={`filter-value-${v}`}
                />
                <span className={`text-xs font-mono truncate ${v === BLANK ? "italic text-slate-500" : "text-slate-800"}`}>
                  {v}
                </span>
              </li>
            ))}
          </ul>
        </ScrollArea>
        <div className="p-2 border-t border-slate-200 flex gap-2">
          <Button onClick={clear} variant="ghost" size="sm" className="rounded-sm h-7 text-xs flex-1" data-testid="filter-clear">Clear</Button>
          <Button onClick={apply} size="sm" className="rounded-sm h-7 text-xs flex-1 bg-blue-700 hover:bg-blue-800" data-testid="filter-apply">Apply</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
