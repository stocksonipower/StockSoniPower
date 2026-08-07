import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, formatApiError } from "../lib/api";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "../components/ui/dialog";
import {
  MagnifyingGlass, ArrowsClockwise, Image as ImgIcon, FunnelSimple, X,
  DownloadSimple, CaretLeft, CaretRight, ArrowsLeftRight, DotsSixVertical,
} from "@phosphor-icons/react";
import AuthImage from "../components/AuthImage";
import ImageViewerDialog from "../components/ImageViewerDialog";
import PartNoLink from "../components/PartNoLink";
import ExcelColumnFilter, { BLANK } from "../components/ExcelColumnFilter";
import { exportToExcel } from "../lib/exportExcel";
import { useAuth } from "../lib/auth";
import { toast } from "sonner";

// Helper: row has any image (new images[] array OR legacy image string)
const rowHasImage = (r) => (Array.isArray(r.images) && r.images.length > 0) || !!r.image;

// Fallback layout, used until the user's own saved layout arrives (and if that
// request ever fails). Kept in the same shape the API returns so the table never
// has to care which of the two it is rendering. The server owns the real
// defaults — this only has to be good enough to render a first frame.
const DEFAULT_COLUMNS = [
  { key: "model", label: "MODEL", width: 140, order: 1, className: "font-mono text-slate-700" },
  { key: "part_no", label: "PART NO", width: 150, order: 2, className: "font-mono font-semibold" },
  { key: "old_part_no", label: "OLD PART NO", width: 150, order: 3, className: "font-mono text-slate-600" },
  { key: "make_part_no", label: "MAKE PART NO", width: 170, order: 4, className: "font-mono text-slate-600" },
  { key: "description_1", label: "DESCRIPTION 1", width: 230, order: 5, className: "text-slate-700" },
  { key: "description_2", label: "DESCRIPTION 2", width: 230, order: 6, className: "text-slate-700" },
  { key: "remarks_oem", label: "REMARKS OEM", width: 180, order: 7, className: "text-slate-600" },
  { key: "remarks_others", label: "REMARKS OTHERS", width: 180, order: 8, className: "text-slate-600" },
  { key: "make", label: "MAKE", width: 130, order: 9, className: "" },
  { key: "item_category", label: "ITEM CATEGORY", width: 150, order: 10, className: "" },
  { key: "reorder_level", label: "REORDER LEVEL", width: 130, order: 11, className: "font-mono", isNumeric: true },
  { key: "godown_name", label: "GODOWN", width: 140, order: 12, className: "" },
  { key: "rack_no", label: "RACK NO", width: 110, order: 13, className: "font-mono" },
  { key: "box_no", label: "BOX NO", width: 110, order: 14, className: "font-mono" },
  { key: "box_category", label: "BOX CATEGORY", width: 140, order: 15, className: "" },
  { key: "total_quantity", label: "QTY", width: 100, order: 16, className: "text-center font-mono font-bold", isQty: true, isNumeric: true, total: true },
  { key: "image", label: "IMAGE", width: 110, order: 99, className: "", isImage: true },
];

// Per-key cell styling lives here rather than on the server: the server owns the
// user's LAYOUT (which column, how wide, in what order) and the client owns how a
// value is painted. Keyed by column so a reorder needs no changes here.
const CELL_CLASS = Object.fromEntries(DEFAULT_COLUMNS.map((c) => [c.key, c.className || ""]));

const PAGE_SIZE = 50;

export default function StockBalancePage() {
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  // colFilters: { [colKey]: Set<string of allowed values> }
  const [colFilters, setColFilters] = useState({});
  // sort: { key, dir } | null
  const [sort, setSort] = useState(null);
  const [page, setPage] = useState(1);

  // The user's own column layout (order + widths), loaded from and saved to the
  // server so it follows them to any browser. Nobody else's view is affected.
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);

  const tableRef = useRef(null);
  const resizingRef = useRef(null);
  const autosizeCanvasRef = useRef(null);
  const searchInputRef = useRef(null);

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

  // Ctrl+F focusses the search input, same as every other list page.
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  /* ---------------- Column layout: load, save, resize ---------------- */

  const applyServerColumns = useCallback((serverCols) => {
    const sorted = [...(serverCols || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (!sorted.length) return;
    // The server sends layout + data traits; the paint classes are ours.
    setColumns(sorted.map((c) => ({ ...c, className: CELL_CLASS[c.key] ?? "" })));
  }, []);

  const loadColumnSettings = useCallback(async () => {
    try {
      const { data } = await api.get("/stock-summary/column-settings");
      applyServerColumns(data.columns);
    } catch (err) {
      // A layout-preference failure must never break the table — keep the defaults.
      console.warn("Could not load column settings, using defaults:", err?.response?.status);
    }
  }, [applyServerColumns]);

  useEffect(() => { loadColumnSettings(); }, [loadColumnSettings, user?.id]);

  // Persists the given layout as this user's own. Used by the settings dialog
  // (explicit Save) and by drag-resize (debounced, silent).
  const persistColumns = useCallback(async (next, { silent = false } = {}) => {
    const payload = next.map((c, i) => ({
      key: c.key,
      width: c.width,
      order: c.isImage ? 99 : i + 1,
    }));
    const { data } = await api.put("/stock-summary/column-settings", { columns: payload });
    applyServerColumns(data.columns);
    if (!silent) toast.success("Column layout saved");
  }, [applyServerColumns]);

  // Drag-resize writes to local state on every mousemove (so the drag is smooth)
  // and only hits the server once the user has stopped for a moment.
  const saveTimer = useRef(null);
  const queueWidthSave = useCallback((next) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      persistColumns(next, { silent: true }).catch(() => {
        toast.error("Could not save column width");
      });
    }, 700);
  }, [persistColumns]);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const handleResizeMove = useCallback((e) => {
    const r = resizingRef.current;
    if (!r) return;
    const newWidth = Math.max(60, Math.min(800, r.startWidth + (e.clientX - r.startX)));
    setColumns((prev) => {
      const next = prev.map((c) => (c.key === r.key ? { ...c, width: newWidth } : c));
      r.latest = next;
      return next;
    });
  }, []);

  const handleResizeUp = useCallback(() => {
    const r = resizingRef.current;
    resizingRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.removeEventListener("mousemove", handleResizeMove);
    document.removeEventListener("mouseup", handleResizeUp);
    if (r?.latest) queueWidthSave(r.latest);
  }, [handleResizeMove, queueWidthSave]);

  const startResize = (e, key, startWidth) => {
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = { key, startX: e.clientX, startWidth, latest: null };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleResizeMove);
    document.addEventListener("mouseup", handleResizeUp);
  };

  // Measures the width needed to fit a column's header label plus the widest
  // cell currently rendered for it (matched via data-col-key, so it stays
  // correct whatever order the columns are in).
  const measureAutoWidth = (key) => {
    const table = tableRef.current;
    if (!table) return null;
    const headerCell = table.querySelector(`th[data-col-key="${key}"]`);
    const bodyCells = table.querySelectorAll(`td[data-col-key="${key}"]`);
    const canvas = autosizeCanvasRef.current || (autosizeCanvasRef.current = document.createElement("canvas"));
    const ctx = canvas.getContext("2d");
    let maxWidth = 0;
    if (headerCell) {
      const style = getComputedStyle(headerCell);
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const letterSpacing = parseFloat(style.letterSpacing) || 0;
      const text = (headerCell.textContent || "").trim();
      maxWidth = Math.max(maxWidth, ctx.measureText(text).width + letterSpacing * text.length);
    }
    bodyCells.forEach((td) => {
      const text = (td.getAttribute("title") || td.textContent || "").trim();
      if (!text) return;
      const style = getComputedStyle(td);
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      maxWidth = Math.max(maxWidth, ctx.measureText(text).width);
    });
    if (maxWidth === 0) return null;
    return Math.max(60, Math.min(800, Math.ceil(maxWidth) + 28));
  };

  // Double-clicking a resize handle auto-fits the column to its content, like
  // double-clicking a column boundary in Excel.
  const autoSizeColumn = (e, key) => {
    e.preventDefault();
    e.stopPropagation();
    const w = measureAutoWidth(key);
    if (w == null) return;
    setColumns((prev) => {
      const next = prev.map((c) => (c.key === key ? { ...c, width: w } : c));
      queueWidthSave(next);
      return next;
    });
  };

  // Draggable strip pinned to a header cell's right edge. A faint guide is
  // always visible so it's discoverable, and brightens on hover/drag.
  const ColResizer = ({ colKey, width }) => (
    <span
      onMouseDown={(e) => startResize(e, colKey, width)}
      onDoubleClick={(e) => autoSizeColumn(e, colKey)}
      className="group absolute top-0 right-0 h-full w-2.5 -mr-1 flex justify-center cursor-col-resize z-30"
      title="Drag to resize · double-click to auto-fit"
      data-testid={`col-resizer-${colKey}`}
    >
      <span className="w-px h-full bg-slate-300 group-hover:bg-blue-500 group-hover:w-0.5 transition-colors" />
    </span>
  );

  /* ---------------- Filtering, sorting, paging ---------------- */

  // Unique values per column, from the currently loaded rows.
  const uniqueValues = useMemo(() => {
    const map = {};
    columns.forEach((c) => {
      if (c.isImage) {
        map[c.key] = ["Has image", "No image"];
      } else {
        const seen = new Set();
        rows.forEach((r) => {
          const raw = r[c.key];
          seen.add(raw === null || raw === undefined || raw === "" ? BLANK : String(raw));
        });
        map[c.key] = [...seen].sort((a, b) => {
          if (a === BLANK) return 1;
          if (b === BLANK) return -1;
          const na = Number(a), nb = Number(b);
          if (!isNaN(na) && !isNaN(nb)) return na - nb;
          return a.localeCompare(b);
        });
      }
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
        if (col?.isImage) return allowed.has(rowHasImage(row) ? "Has image" : "No image");
        const raw = row[k];
        return allowed.has(raw === null || raw === undefined || raw === "" ? BLANK : String(raw));
      }));
    }
    if (sort && sort.key) {
      const col = columns.find((c) => c.key === sort.key);
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
            const an = parseFloat(av), bn = parseFloat(bv);
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
  }, [rows, colFilters, sort, columns]);

  // Anything that changes which rows qualify invalidates the current page number
  // — landing on an empty page 7 after a filter cuts the set to 30 rows is the
  // classic version of this bug.
  useEffect(() => { setPage(1); }, [search, colFilters, sort]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const pageRows = useMemo(
    () => filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filteredRows, page],
  );
  // Guard against the page number outliving the row count (e.g. a refresh that
  // returns fewer rows) without waiting for a filter change to reset it.
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);

  // Total quantity across every row that passes the current filters — not just
  // the visible page. Shown as plain text in the summary bar rather than as a
  // highlighted row inside the table.
  const totalQty = useMemo(
    () => filteredRows.reduce((s, r) => s + (parseFloat(r.total_quantity) || 0), 0),
    [filteredRows],
  );

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

  const [viewer, setViewer] = useState(null); // { images, idx }

  // Export every row that passes the current filters (not just this page), in
  // the user's own column order — the export should look like their table.
  const handleExport = () => {
    if (filteredRows.length === 0) { toast.error("No rows to export"); return; }
    const exportCols = [
      { label: "Sl No", value: (r) => filteredRows.indexOf(r) + 1 },
      ...columns.filter((c) => !c.isImage).map((c) => ({
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

  const stickyTh = "sticky top-0 z-20 bg-slate-50";

  const renderCell = (c, r, i) => {
    const style = { width: c.width };
    if (c.isImage) {
      const list = Array.isArray(r.images) && r.images.length > 0 ? r.images : (r.image ? [r.image] : []);
      return (
        <td key={c.key} data-col-key={c.key} style={style}>
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
        <td key={c.key} data-col-key={c.key} style={style}
          className={`text-center font-mono font-bold ${r.total_quantity <= 5 ? "text-red-700" : "text-slate-900"}`}>
          {r.total_quantity}
        </td>
      );
    }
    if (c.key === "part_no") {
      return (
        <td key={c.key} data-col-key={c.key} style={style} className={c.className} title={r.part_no || ""}>
          <PartNoLink partNo={r.part_no} make={r.make} />
        </td>
      );
    }
    const val = r[c.key];
    return (
      <td key={c.key} data-col-key={c.key} style={style} className={c.className} title={val ? String(val) : ""}>
        {val || val === 0 ? val : dash}
      </td>
    );
  };

  return (
    <div className="p-8 max-w-[1900px] mx-auto" data-testid="balance-page">
      <div className="mb-6">
        <h1 className="text-4xl font-black tracking-tight text-slate-900">Stock Summary</h1>
      </div>

      {/* One toolbar row: the search box takes all the slack so the three
          buttons sit flush against the right edge and the row reads as a single
          band rather than a control floating in white space. `shrink-0` keeps
          the buttons at their natural width — the search field is the only
          thing that gives. */}
      <div className="flex items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input
            ref={searchInputRef}
            placeholder="Search part no, descriptions, remarks, category…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 pr-9 rounded-sm w-full"
            data-testid="balance-search-input"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-sm text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              title="Clear search"
              data-testid="search-clear"
            >
              <X size={12} weight="bold" />
            </button>
          )}
        </div>
        <Button
          onClick={() => setColumnSettingsOpen(true)}
          variant="outline"
          className="rounded-sm border-slate-300 shrink-0"
          title="Drag to reorder columns and set their widths — saved to your account only"
          data-testid="column-settings-button"
        >
          <ArrowsLeftRight size={16} weight="bold" className="mr-2" /> Edit Columns
        </Button>
        <Button onClick={handleExport} variant="outline" className="rounded-sm border-slate-300 shrink-0" data-testid="balance-export-button">
          <DownloadSimple size={14} weight="bold" className="mr-2" /> Export
        </Button>
        <Button onClick={() => load(search)} variant="outline" className="rounded-sm border-slate-300 shrink-0" disabled={loading} data-testid="refresh-button">
          <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Pagination bar — above the table, same shape as every other list page.
          The active-filter notice lives here rather than in the toolbar above so
          that row keeps one fixed shape instead of reflowing as filters change. */}
      <div className="flex items-center justify-between mb-3 text-xs text-slate-600 gap-3 flex-wrap" data-testid="balance-pagination">
        <div className="flex items-center gap-3 flex-wrap">
          <span>
            {filteredRows.length === 0 ? "No rows" : (
              <>
                Showing <span className="font-semibold text-slate-900">{pageRows.length}</span>
                {" · "}<span className="font-semibold text-slate-900">{filteredRows.length}</span> row{filteredRows.length === 1 ? "" : "s"}
                {activeFilterCount > 0 && <span className="text-slate-500"> (filtered from {rows.length})</span>}
                {" · Total Qty "}<span className="font-mono font-semibold text-slate-900" data-testid="balance-total-qty">{totalQty.toLocaleString()}</span>
              </>
            )}
          </span>
          {activeFilterCount > 0 && (
            <span className="flex items-center gap-1.5 text-slate-500">
              <FunnelSimple size={13} weight="bold" />
              {activeFilterCount} column filter(s) active
            </span>
          )}
          {(activeFilterCount > 0 || sort?.key) && (
            <Button onClick={() => { setColFilters({}); setSort(null); }} variant="ghost" size="sm" className="rounded-sm h-6 text-xs px-2" data-testid="clear-filters-button">
              <X size={12} weight="bold" className="mr-1" /> Clear filters &amp; sort
            </Button>
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

      {/* Scroll container — both axes scroll, sticky header inside */}
      <div
        className="bg-white border border-slate-200 rounded-sm overflow-auto"
        style={{ maxHeight: "calc(100vh - 300px)", minHeight: "400px" }}
        data-testid="balance-scroller"
      >
        <table ref={tableRef} className="data-table data-table-fixed w-full">
          <thead>
            <tr>
              <th data-col-key="__sl__" className={`${stickyTh} text-center relative`} style={{ width: 70 }}>
                SL NO
              </th>
              {columns.map((c) => (
                <th key={c.key} data-col-key={c.key} className={`${stickyTh} relative`} style={{ width: c.width }}>
                  <ExcelColumnFilter
                    label={c.label}
                    values={uniqueValues[c.key] || []}
                    selected={colFilters[c.key]}
                    onChange={(s) => setColFilter(c.key, s)}
                    sortDir={sort?.key === c.key ? sort.dir : null}
                    onSort={(dir) => setColumnSort(c.key, dir)}
                    isQty={c.isQty}
                    isNumeric={c.isNumeric}
                  />
                  <ColResizer colKey={c.key} width={c.width} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 1} className="text-center py-12 text-slate-500">
                  {loading ? "Loading…" : (search || activeFilterCount > 0 ? "No matches." : "No stock recorded yet.")}
                </td>
              </tr>
            ) : pageRows.map((r, i) => {
              const slNo = (page - 1) * PAGE_SIZE + i + 1;
              return (
                <tr key={`${r.part_no}|${r.make}|${r.godown_id}|${r.rack_id}|${r.box_id}`} data-testid={`balance-row-${i}`}>
                  <td data-col-key="__sl__" className="font-mono text-slate-500 text-center" style={{ width: 70 }}>{slNo}</td>
                  {columns.map((c) => renderCell(c, r, i))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 text-xs text-slate-500">
        Item details and locations are pulled live from Stock Master and Location Master each time you refresh.
        Drag a column edge to resize it, double-click the edge to auto-fit — your layout is saved to your account.
      </div>

      <ImageViewerDialog
        open={!!viewer}
        images={viewer?.images || []}
        startIndex={viewer?.idx || 0}
        onClose={() => setViewer(null)}
      />

      <ColumnSettingsDialog
        open={columnSettingsOpen}
        onOpenChange={setColumnSettingsOpen}
        columns={columns}
        defaults={DEFAULT_COLUMNS}
        onSave={persistColumns}
        onAutoFit={measureAutoWidth}
      />
    </div>
  );
}

/* ============================================================================
   Column layout editor — drag a row to reorder, type or auto-fit a width.
   Saved to the signed-in user's own account; no other user's view changes.
   ========================================================================== */
function ColumnSettingsDialog({ open, onOpenChange, columns, defaults, onSave, onAutoFit }) {
  const [draft, setDraft] = useState([]);
  const [saving, setSaving] = useState(false);
  const [dragKey, setDragKey] = useState(null);
  const [overKey, setOverKey] = useState(null);

  useEffect(() => {
    if (open) {
      setDragKey(null);
      setOverKey(null);
      setDraft([...(columns || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
    }
  }, [open, columns]);

  // The image column is pinned last (a thumbnail strip reads as the end of a
  // row), so it is neither draggable nor a valid drop target.
  const isPinned = (c) => !!c.isImage;

  const moveKeyBefore = (fromKey, toKey) => {
    if (!fromKey || fromKey === toKey) return;
    setDraft((prev) => {
      const from = prev.findIndex((c) => c.key === fromKey);
      const to = prev.findIndex((c) => c.key === toKey);
      if (from < 0 || to < 0 || isPinned(prev[from]) || isPinned(prev[to])) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const setWidth = (key, raw) => {
    const w = Math.max(60, Math.min(800, parseInt(raw, 10) || 60));
    setDraft((prev) => prev.map((c) => (c.key === key ? { ...c, width: w } : c)));
  };

  const autoFitOne = (key) => {
    const w = onAutoFit ? onAutoFit(key) : null;
    if (w != null) setWidth(key, w);
  };

  const autoFitAll = () => {
    if (!onAutoFit) return;
    setDraft((prev) => prev.map((c) => {
      const w = onAutoFit(c.key);
      return w != null ? { ...c, width: Math.max(60, Math.min(800, w)) } : c;
    }));
  };

  // Back to the app's own layout — the server treats a save of the defaults the
  // same as any other layout, so this is just "put the defaults in the draft".
  const restoreDefaults = () => {
    setDraft([...defaults].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(draft);
      onOpenChange(false);
    } catch (err) {
      toast.error(formatApiError(err?.response?.data?.detail) || "Could not save column layout");
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl rounded-sm" data-testid="column-settings-dialog">
        <DialogHeader>
          <DialogTitle className="text-xl font-black">Edit Columns</DialogTitle>
          <DialogDescription>
            Drag a row by its handle to reorder the table. Widths can be typed or auto-fitted.
            This layout is saved to your account only — it does not change anyone else's view.
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" className="rounded-sm" onClick={restoreDefaults} data-testid="col-restore-defaults">
            Restore Defaults
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="rounded-sm"
            onClick={autoFitAll}
            title="Set every column's width to fit its largest visible cell"
            data-testid="col-auto-fit-all"
          >
            <ArrowsClockwise size={14} weight="bold" className="mr-2" /> Auto-fit All
          </Button>
        </div>

        <div className="max-h-[55vh] overflow-y-auto border border-slate-200 rounded-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 sticky top-0 z-10">
              <tr>
                <th className="text-left px-3 py-2 w-10" />
                <th className="text-left px-3 py-2 w-12 text-[10px] font-bold uppercase tracking-wider text-slate-500">#</th>
                <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">Column</th>
                <th className="text-left px-3 py-2 w-32 text-[10px] font-bold uppercase tracking-wider text-slate-500">Width (px)</th>
                <th className="text-left px-3 py-2 w-16" />
              </tr>
            </thead>
            <tbody>
              {draft.map((c, i) => {
                const pinned = isPinned(c);
                return (
                  <tr
                    key={c.key}
                    draggable={!pinned}
                    onDragStart={() => setDragKey(c.key)}
                    onDragEnd={() => { setDragKey(null); setOverKey(null); }}
                    onDragOver={(e) => {
                      if (pinned || !dragKey) return;
                      e.preventDefault();          // without this the drop never fires
                      if (overKey !== c.key) setOverKey(c.key);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      moveKeyBefore(dragKey, c.key);
                      setDragKey(null);
                      setOverKey(null);
                    }}
                    className={`border-t border-slate-100 ${dragKey === c.key ? "opacity-40" : ""} ${
                      overKey === c.key && dragKey && dragKey !== c.key ? "bg-blue-50 border-t-2 border-t-blue-500" : ""
                    }`}
                    data-testid={`col-row-${c.key}`}
                  >
                    <td className="px-3 py-2">
                      <span
                        className={pinned ? "text-slate-300" : "text-slate-400 hover:text-slate-700 cursor-grab active:cursor-grabbing"}
                        title={pinned ? "Pinned to the end of the row" : "Drag to reorder"}
                        data-testid={`col-drag-${c.key}`}
                      >
                        <DotsSixVertical size={16} weight="bold" />
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{pinned ? "—" : i + 1}</td>
                    <td className="px-3 py-2">
                      <span className="text-sm font-semibold text-slate-800">{c.label}</span>
                      {pinned && <span className="ml-2 text-[10px] uppercase tracking-wider text-slate-400">pinned last</span>}
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        type="number"
                        min={60}
                        max={800}
                        value={c.width || 0}
                        onChange={(e) => setWidth(c.key, e.target.value)}
                        className="rounded-sm h-8 font-mono"
                        data-testid={`col-width-${c.key}`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="rounded-sm h-8 w-8 p-0"
                        onClick={() => autoFitOne(c.key)}
                        title="Auto-fit this column to its largest visible cell"
                        data-testid={`col-auto-fit-${c.key}`}
                      >
                        <ArrowsClockwise size={14} weight="bold" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-end gap-2 mt-4">
          <Button variant="outline" className="rounded-sm" onClick={() => onOpenChange(false)} data-testid="col-cancel">Cancel</Button>
          <Button className="rounded-sm bg-blue-700 hover:bg-blue-800" onClick={handleSave} disabled={saving} data-testid="col-save">
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
