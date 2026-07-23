import { useMemo, useState } from "react";
import { BLANK } from "./ExcelColumnFilter";

/**
 * Excel-style table filter + sort hook.
 *
 * @param {Array} rows      Source rows
 * @param {Array} columns   [{ key, label, value: (row) => any, isNumeric? }]
 * @returns {{
 *   filteredRows: Array,
 *   uniqueValues: Object,           // { [colKey]: string[] }
 *   colFilters: Object,             // { [colKey]: Set<string> }
 *   setColFilter: (key, Set|null) => void,
 *   sort: { key, dir } | null,
 *   setColumnSort: (key, "asc"|"desc"|null) => void,
 *   activeFilterCount: number,
 *   resetAll: () => void,
 * }}
 */
export default function useExcelTableFilter(rows, columns) {
  const [colFilters, setColFilters] = useState({});
  const [sort, setSort] = useState(null);

  const uniqueValues = useMemo(() => {
    const map = {};
    columns.forEach((c) => {
      const seen = new Set();
      rows.forEach((r) => {
        const raw = c.value(r);
        const v = raw === null || raw === undefined || raw === "" ? BLANK : String(raw);
        seen.add(v);
      });
      map[c.key] = [...seen].sort((a, b) => {
        if (a === BLANK) return 1;
        if (b === BLANK) return -1;
        const na = Number(a), nb = Number(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b);
      });
    });
    return map;
  }, [rows, columns]);

  const filteredRows = useMemo(() => {
    const activeKeys = Object.keys(colFilters);
    let out = rows;
    if (activeKeys.length > 0) {
      out = rows.filter((row) => activeKeys.every((k) => {
        const allowed = colFilters[k];
        if (!allowed || allowed.size === 0) return true;
        const col = columns.find((c) => c.key === k);
        if (!col) return true;
        const raw = col.value(row);
        const v = raw === null || raw === undefined || raw === "" ? BLANK : String(raw);
        return allowed.has(v);
      }));
    }
    if (sort && sort.key) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        const dir = sort.dir === "desc" ? -1 : 1;
        out = [...out].sort((a, b) => {
          const av = col.value(a);
          const bv = col.value(b);
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
  }, [rows, columns, colFilters, sort]);

  const setColFilter = (key, allowedSet) => {
    setColFilters((f) => {
      const next = { ...f };
      if (!allowedSet || allowedSet.size === 0) delete next[key];
      else next[key] = allowedSet;
      return next;
    });
  };

  const setColumnSort = (key, dir) => {
    if (!dir) setSort((s) => (s && s.key === key ? null : s));
    else setSort({ key, dir });
  };

  const resetAll = () => {
    setColFilters({});
    setSort(null);
  };

  return {
    filteredRows,
    uniqueValues,
    colFilters,
    setColFilter,
    sort,
    setColumnSort,
    activeFilterCount: Object.keys(colFilters).length,
    resetAll,
  };
}
