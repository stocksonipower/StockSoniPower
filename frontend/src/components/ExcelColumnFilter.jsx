import React, { useEffect, useMemo, useState } from "react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";
import { CaretDown, CaretUp, SortAscending, SortDescending } from "@phosphor-icons/react";

export const BLANK = "(Blank)";

/**
 * Excel-style column header with combined filter + sort dropdown.
 *
 * Props:
 *   label        – string column label (rendered in header)
 *   values       – string[] unique values present in that column
 *   selected     – Set<string> | null   currently allowed values (null = no filter)
 *   onChange     – (Set | null) => void
 *   sortDir      – "asc" | "desc" | null  current sort direction for this column
 *   onSort       – (dir) => void  parent sets {key, dir} when user picks a sort
 *   isQty        – boolean  align center
 *   isNumeric    – boolean  use numeric sort
 */
export default function ExcelColumnFilter({
  label, values, selected, onChange,
  sortDir, onSort,
  isQty, isNumeric,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [working, setWorking] = useState(null);

  useEffect(() => {
    if (open) {
      setQuery("");
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

  const sortIcon = sortDir === "asc"
    ? <CaretUp size={9} weight="bold" className="text-blue-700" />
    : sortDir === "desc"
      ? <CaretDown size={9} weight="bold" className="text-blue-700" />
      : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={`group flex items-center gap-1 ${isQty ? "mx-auto" : ""} ${isFilterActive || isSortActive ? "text-blue-700" : "text-slate-500 hover:text-slate-900"}`}
          data-testid={`filter-trigger-${label.toLowerCase().replace(/\s+/g, "-")}`}
        >
          <span className="font-bold tracking-[0.15em]">{label}</span>
          {sortIcon}
          <CaretDown size={10} weight="bold" className={`opacity-60 group-hover:opacity-100 ${isFilterActive ? "opacity-100" : ""}`} />
          {isFilterActive && <span className="ml-1 text-[9px] bg-blue-100 text-blue-800 px-1 rounded-sm font-mono">{selected.size}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0 rounded-sm" align="start">
        {onSort && (
          <div className="p-1 border-b border-slate-200 flex">
            <button
              onClick={() => { onSort(sortDir === "asc" ? null : "asc"); setOpen(false); }}
              className={`flex-1 flex items-center gap-2 px-3 py-2 text-xs hover:bg-slate-100 rounded-sm ${sortDir === "asc" ? "bg-blue-50 text-blue-700 font-semibold" : "text-slate-700"}`}
              data-testid="sort-asc"
            >
              <SortAscending size={14} weight="bold" /> Sort {isNumeric ? "Smallest → Largest" : "A → Z"}
            </button>
          </div>
        )}
        {onSort && (
          <div className="p-1 border-b border-slate-200 flex">
            <button
              onClick={() => { onSort(sortDir === "desc" ? null : "desc"); setOpen(false); }}
              className={`flex-1 flex items-center gap-2 px-3 py-2 text-xs hover:bg-slate-100 rounded-sm ${sortDir === "desc" ? "bg-blue-50 text-blue-700 font-semibold" : "text-slate-700"}`}
              data-testid="sort-desc"
            >
              <SortDescending size={14} weight="bold" /> Sort {isNumeric ? "Largest → Smallest" : "Z → A"}
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
