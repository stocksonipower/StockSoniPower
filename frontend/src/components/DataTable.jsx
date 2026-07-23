import React, { useEffect, useMemo, useRef, useState } from "react";
import { Funnel, FunnelSimple, ArrowDown, ArrowUp, MagnifyingGlass } from "@phosphor-icons/react";

/**
 * useTableSortFilter
 * ------------------
 * Excel-style sort + per-column multi-select filter applied to an array of rows.
 *
 * `columns` is the *data definition* used both for filter values and for export:
 *   [{ key: "name", label: "Name", value: (row) => row.name }, ...]
 *
 * Returns:
 *   - filteredRows: rows after filter+sort
 *   - sort: { key, dir } | null
 *   - setSort
 *   - filters: { [key]: Set<string> | null }   null = no filter
 *   - setColumnFilter(key, Set)
 *   - clearAllFilters()
 *   - getColumnHeaderProps(key) -> props for <ColumnHeader>
 */
export function useTableSortFilter(rows, columns) {
  const [sort, setSort] = useState(null);
  const [filters, setFilters] = useState({});

  const columnByKey = useMemo(() => {
    const m = {};
    columns.forEach((c) => { m[c.key] = c; });
    return m;
  }, [columns]);

  const setColumnFilter = (key, setOrNull) => {
    setFilters((prev) => {
      const n = { ...prev };
      if (!setOrNull || setOrNull.size === 0) delete n[key];
      else n[key] = setOrNull;
      return n;
    });
  };

  const clearAllFilters = () => {
    setFilters({});
    setSort(null);
  };

  // Apply filters
  const filteredRows = useMemo(() => {
    let out = rows;
    Object.entries(filters).forEach(([key, valueSet]) => {
      const c = columnByKey[key];
      if (!c || !valueSet) return;
      out = out.filter((r) => valueSet.has(_norm(c.value(r))));
    });
    if (sort && columnByKey[sort.key]) {
      const c = columnByKey[sort.key];
      const dir = sort.dir === "desc" ? -1 : 1;
      out = [...out].sort((a, b) => {
        const av = c.value(a);
        const bv = c.value(b);
        return _cmp(av, bv) * dir;
      });
    }
    return out;
  }, [rows, filters, sort, columnByKey]);

  const getColumnHeaderProps = (key) => ({
    columnKey: key,
    rows,
    columnByKey,
    sort,
    setSort,
    filters,
    setColumnFilter,
  });

  return { filteredRows, sort, setSort, filters, setColumnFilter, clearAllFilters, getColumnHeaderProps };
}

function _norm(v) {
  if (v === null || v === undefined || v === "") return "(Blank)";
  return String(v);
}

function _cmp(a, b) {
  if (a === null || a === undefined) a = "";
  if (b === null || b === undefined) b = "";
  // Numeric compare if both look numeric
  const an = parseFloat(a);
  const bn = parseFloat(b);
  if (!isNaN(an) && !isNaN(bn) && String(an) === String(a).trim() && String(bn) === String(b).trim()) {
    return an - bn;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * <ColumnHeader>
 * Wraps a normal table-header cell with a click-to-sort + click-the-funnel popover for filtering.
 */
export function ColumnHeader({
  columnKey, label, align = "left", testid, rows, columnByKey, sort, setSort, filters, setColumnFilter,
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [draftSelected, setDraftSelected] = useState(null);
  const popRef = useRef(null);
  const triggerRef = useRef(null);

  const c = columnByKey[columnKey];
  const activeFilter = filters[columnKey] || null;
  const hasFilter = !!activeFilter;
  const isSortedAsc = sort?.key === columnKey && sort?.dir === "asc";
  const isSortedDesc = sort?.key === columnKey && sort?.dir === "desc";

  // All unique values for this column (from the unfiltered data) — Excel does this from full sheet.
  const uniqueValues = useMemo(() => {
    if (!c) return [];
    const seen = new Set();
    rows.forEach((r) => seen.add(_norm(c.value(r))));
    return [...seen].sort((a, b) => _cmp(a, b));
  }, [c, rows]);

  useEffect(() => {
    if (open) setDraftSelected(activeFilter ? new Set(activeFilter) : new Set(uniqueValues));
  }, [open, activeFilter, uniqueValues]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (popRef.current?.contains(e.target)) return;
      if (triggerRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const filteredValues = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return uniqueValues;
    return uniqueValues.filter((v) => v.toLowerCase().includes(q));
  }, [uniqueValues, search]);

  const allChecked = draftSelected && uniqueValues.every((v) => draftSelected.has(v));
  const noneChecked = draftSelected && uniqueValues.every((v) => !draftSelected.has(v));

  const apply = () => {
    if (!draftSelected) { setOpen(false); return; }
    if (allChecked) setColumnFilter(columnKey, null); // no filter = all
    else setColumnFilter(columnKey, new Set(draftSelected));
    setOpen(false);
  };

  const clear = () => {
    setColumnFilter(columnKey, null);
    setOpen(false);
  };

  const flipSelectAll = () => {
    setDraftSelected(allChecked ? new Set() : new Set(uniqueValues));
  };

  const toggleVal = (v) => {
    setDraftSelected((prev) => {
      const n = new Set(prev || []);
      if (n.has(v)) n.delete(v); else n.add(v);
      return n;
    });
  };

  const onHeaderClick = () => {
    if (sort?.key !== columnKey) setSort({ key: columnKey, dir: "asc" });
    else if (sort.dir === "asc") setSort({ key: columnKey, dir: "desc" });
    else setSort(null);
  };

  return (
    <th className={`relative ${align === "right" ? "text-right" : align === "center" ? "text-center" : ""}`} data-testid={testid ? `${testid}-th` : undefined}>
      <div className={`flex items-center gap-1 ${align === "right" ? "justify-end" : align === "center" ? "justify-center" : ""}`}>
        <button
          type="button"
          onClick={onHeaderClick}
          className="flex items-center gap-1 hover:text-blue-700 select-none"
          data-testid={testid ? `${testid}-sort` : undefined}
          title="Click to sort"
        >
          <span>{label}</span>
          {isSortedAsc && <ArrowUp size={11} weight="bold" className="text-blue-700" />}
          {isSortedDesc && <ArrowDown size={11} weight="bold" className="text-blue-700" />}
        </button>
        <button
          type="button"
          ref={triggerRef}
          onClick={() => setOpen((o) => !o)}
          className={`p-0.5 rounded-sm hover:bg-slate-100 ${hasFilter ? "text-blue-700" : "text-slate-400 hover:text-slate-700"}`}
          data-testid={testid ? `${testid}-filter` : undefined}
          title="Filter / Sort"
        >
          {hasFilter ? <Funnel size={12} weight="fill" /> : <FunnelSimple size={12} weight="bold" />}
        </button>
      </div>

      {open && (
        <div
          ref={popRef}
          className="absolute z-30 mt-1 left-0 top-full w-64 bg-white border border-slate-300 rounded-sm shadow-lg p-2 normal-case font-normal tracking-normal text-slate-800"
          data-testid={testid ? `${testid}-popover` : undefined}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-1 border-b border-slate-200 pb-2 mb-2">
            <button
              type="button"
              onClick={() => { setSort({ key: columnKey, dir: "asc" }); setOpen(false); }}
              className="flex-1 text-xs flex items-center gap-1 px-2 py-1 hover:bg-slate-100 rounded-sm"
              data-testid={testid ? `${testid}-sort-asc` : undefined}
            >
              <ArrowUp size={10} weight="bold" /> Sort A→Z
            </button>
            <button
              type="button"
              onClick={() => { setSort({ key: columnKey, dir: "desc" }); setOpen(false); }}
              className="flex-1 text-xs flex items-center gap-1 px-2 py-1 hover:bg-slate-100 rounded-sm"
              data-testid={testid ? `${testid}-sort-desc` : undefined}
            >
              <ArrowDown size={10} weight="bold" /> Sort Z→A
            </button>
          </div>
          <div className="relative mb-2">
            <MagnifyingGlass size={12} weight="bold" className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className="w-full pl-7 pr-2 py-1 text-xs border border-slate-300 rounded-sm font-normal"
              data-testid={testid ? `${testid}-filter-search` : undefined}
            />
          </div>
          <label className="flex items-center gap-2 text-xs px-1 py-1 cursor-pointer hover:bg-slate-50 border-b border-slate-100">
            <input
              type="checkbox"
              checked={!!allChecked}
              ref={(el) => { if (el) el.indeterminate = !allChecked && !noneChecked; }}
              onChange={flipSelectAll}
              data-testid={testid ? `${testid}-filter-all` : undefined}
            />
            <span className="font-semibold">(Select All)</span>
          </label>
          <div className="max-h-48 overflow-y-auto py-1">
            {filteredValues.length === 0 && (
              <div className="text-xs text-slate-400 italic px-2 py-2">No matches</div>
            )}
            {filteredValues.map((v) => (
              <label key={v} className="flex items-center gap-2 text-xs px-1 py-0.5 cursor-pointer hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={!!draftSelected?.has(v)}
                  onChange={() => toggleVal(v)}
                  data-testid={testid ? `${testid}-filter-opt-${v}` : undefined}
                />
                <span className="truncate" title={v}>{v}</span>
              </label>
            ))}
          </div>
          <div className="flex items-center gap-1 border-t border-slate-200 pt-2 mt-1">
            <button
              type="button"
              onClick={clear}
              className="flex-1 text-xs px-2 py-1 hover:bg-slate-100 rounded-sm text-slate-600"
              data-testid={testid ? `${testid}-filter-clear` : undefined}
            >
              Clear
            </button>
            <button
              type="button"
              onClick={apply}
              className="flex-1 text-xs px-2 py-1 bg-blue-700 hover:bg-blue-800 text-white rounded-sm"
              data-testid={testid ? `${testid}-filter-apply` : undefined}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </th>
  );
}
