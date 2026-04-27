import React, { useEffect, useState, useRef } from "react";
import { api, formatApiError } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "../components/ui/dialog";
import { toast } from "sonner";
import {
  Plus, Trash, Pencil, UploadSimple, MagnifyingGlass,
  Image as ImgIcon, DownloadSimple, FileArrowDown, ArrowsClockwise,
  FunnelSimple, X, CaretLeft, CaretRight, CaretUp, CaretDown,
  FileText, CheckCircle, Warning, ArrowsLeftRight,
} from "@phosphor-icons/react";
import * as XLSX from "xlsx";
import ExcelColumnFilter, { BLANK } from "../components/ExcelColumnFilter";
import StockMasterImageUploader from "../components/StockMasterImageUploader";
import AuthImage from "../components/AuthImage";
import ImageViewerDialog from "../components/ImageViewerDialog";

const COLUMNS = [
  { key: "model", label: "MODEL" },
  { key: "part_no", label: "PART NO" },
  { key: "old_part_no", label: "OLD PART NO" },
  { key: "make_part_no", label: "MAKE PART NO" },
  { key: "description_1", label: "DESCRIPTION 1" },
  { key: "description_2", label: "DESCRIPTION 2" },
  { key: "remarks_oem", label: "REMARKS OEM" },
  { key: "remarks_others", label: "REMARKS OTHERS" },
  { key: "make", label: "MAKE" },
  { key: "item_category", label: "ITEM CATEGORY" },
  { key: "reorder_level", label: "REORDER LEVEL", isNumeric: true },
  { key: "images", label: "IMAGES", isImage: true },
];

const emptyForm = {
  model: "", part_no: "", old_part_no: "", make_part_no: "",
  description_1: "", description_2: "",
  remarks_oem: "", remarks_others: "",
  make: "", item_category: "", reorder_level: 0,
  image: "", images: [],
};

// ─── Import Preview Dialog ────────────────────────────────────────────────────
function ImportPreviewDialog({ open, onClose, preview, file, onConfirm, importing }) {
  const [mode, setMode] = useState("skip");
  useEffect(() => { if (open) setMode("skip"); }, [open]);

  if (!preview) return null;
  const { file_name, total_items, new_items, duplicate_items, skipped_rows } = preview;

  const stats = [
    { label: "File Name", value: file_name, icon: <FileText size={18} weight="bold" className="text-slate-500" />, wide: true },
    { label: "Total Items", value: total_items, icon: <ArrowsLeftRight size={18} weight="bold" className="text-blue-600" />, color: "text-blue-700" },
    { label: "New Items", value: new_items, icon: <CheckCircle size={18} weight="bold" className="text-emerald-600" />, color: "text-emerald-700" },
    { label: "Duplicate Items", value: duplicate_items, icon: <Warning size={18} weight="bold" className="text-amber-500" />, color: "text-amber-700" },
  ];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !importing) onClose(); }}>
      <DialogContent className="max-w-lg rounded-sm" data-testid="import-preview-dialog">
        <DialogHeader>
          <DialogTitle className="text-xl font-black tracking-tight text-slate-900">Review Import</DialogTitle>
          <p className="text-xs text-slate-500 mt-1">Check the details below before confirming the import.</p>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 mt-1">
          {stats.map((s) => (
            <div key={s.label} className={`flex items-start gap-3 bg-slate-50 border border-slate-200 rounded-sm p-3 ${s.wide ? "col-span-2" : ""}`}>
              <div className="mt-0.5 shrink-0">{s.icon}</div>
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 mb-0.5">{s.label}</div>
                <div className={`font-mono font-bold text-sm truncate ${s.color || "text-slate-800"}`} title={String(s.value)} data-testid={`preview-${s.label.toLowerCase().replace(/\s+/g, "-")}`}>
                  {s.value}
                </div>
              </div>
            </div>
          ))}
        </div>

        {skipped_rows > 0 && (
          <p className="text-[11px] text-slate-500 -mt-1">
            <span className="font-semibold text-slate-700">{skipped_rows}</span> row(s) in the file are missing Part No or Make and will always be skipped.
          </p>
        )}

        <div className="mt-1">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 mb-2">How to handle duplicate items</div>
          <div className="flex gap-3">
            <button type="button" onClick={() => setMode("skip")} disabled={importing} data-testid="mode-skip"
              className={`flex-1 flex items-center gap-3 rounded-sm border-2 px-4 py-3 text-left transition-all
                ${mode === "skip" ? "border-blue-600 bg-blue-50" : "border-slate-200 bg-white hover:border-slate-300"}
                ${importing ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}>
              <span className={`shrink-0 h-4 w-4 rounded-sm border-2 flex items-center justify-center transition-colors
                ${mode === "skip" ? "border-blue-600 bg-blue-600" : "border-slate-300 bg-white"}`}>
                {mode === "skip" && (
                  <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                    <path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <div>
                <div className="text-sm font-semibold text-slate-800 leading-none mb-1">Skip existing items</div>
                <div className="text-[11px] text-slate-500 leading-snug">Only import new items. Duplicates are left unchanged.</div>
              </div>
            </button>

            <button type="button" onClick={() => setMode("overwrite")} disabled={importing} data-testid="mode-overwrite"
              className={`flex-1 flex items-center gap-3 rounded-sm border-2 px-4 py-3 text-left transition-all
                ${mode === "overwrite" ? "border-amber-500 bg-amber-50" : "border-slate-200 bg-white hover:border-slate-300"}
                ${importing ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}>
              <span className={`shrink-0 h-4 w-4 rounded-sm border-2 flex items-center justify-center transition-colors
                ${mode === "overwrite" ? "border-amber-500 bg-amber-500" : "border-slate-300 bg-white"}`}>
                {mode === "overwrite" && (
                  <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                    <path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <div>
                <div className="text-sm font-semibold text-slate-800 leading-none mb-1">Overwrite existing items</div>
                <div className="text-[11px] text-slate-500 leading-snug">Update duplicates with data from the file.</div>
              </div>
            </button>
          </div>
        </div>

        <DialogFooter className="mt-2 gap-2">
          <Button variant="outline" onClick={onClose} disabled={importing} className="rounded-sm" data-testid="import-preview-cancel">Cancel</Button>
          <Button onClick={() => onConfirm(mode)} disabled={importing || total_items === 0} className="rounded-sm bg-blue-700 hover:bg-blue-800 min-w-[160px]" data-testid="import-preview-confirm">
            {importing ? (
              <span className="flex items-center gap-2"><ArrowsClockwise size={14} weight="bold" className="animate-spin" />Importing…</span>
            ) : (`Confirm Import`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function StockMasterPage() {
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(false);
  const [colFilters, setColFilters] = useState({});
  const [sort, setSort] = useState({ key: null, dir: null });
  const PAGE_SIZE = 1000;
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const excelInput = useRef(null);

  // Import preview state
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);

  // Search-match navigation state
  const [matchIdx, setMatchIdx] = useState(0);
  const currentCellRef = useRef(null);
  const searchInputRef = useRef(null);

  // Export state
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState({ loaded: 0, total: 0, label: "" });
  const exportMenuRef = useRef(null);
  // Tracks which search term the currently-displayed `items` correspond to.
  // Used to suppress stale highlights while the API is catching up.
  const [loadedSearch, setLoadedSearch] = useState("");

  const load = async () => {
    setLoading(true);
    const requestSearch = search;
    try {
      // Build URLSearchParams so we can send filter[<field>]=A&filter[<field>]=B repeated keys
      const sp = new URLSearchParams();
      sp.set("page", String(page));
      sp.set("page_size", String(PAGE_SIZE));
      if (requestSearch) sp.set("search", requestSearch);
      if (sort.key && sort.dir) {
        sp.set("sort_by", sort.key);
        sp.set("sort_dir", sort.dir);
      }
      Object.entries(colFilters).forEach(([key, set]) => {
        if (!set || set.size === 0) return;
        for (const v of set) sp.append(`filter[${key}]`, v);
      });
      const res = await api.get(`/stock-master?${sp.toString()}`);
      setItems(res.data);
      setLoadedSearch(requestSearch);
      const t = parseInt(res.headers["x-total-count"], 10);
      setTotal(isNaN(t) ? res.data.length : t);
    } finally { setLoading(false); }
  };

 // Reset to page 1 whenever the filtering criteria change
  useEffect(() => { setPage(1); }, [search, colFilters, sort]);
  // Debounced reload whenever any input that affects the query changes
  useEffect(() => {
    const t = setTimeout(load, 150);
    return () => clearTimeout(t);
    /* eslint-disable-next-line */
  }, [search, page, colFilters, sort]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Distinct values per column come from the server (whole DB, not just current page).
  // We lazy-load them once on mount.
  const [uniqueValues, setUniqueValues] = useState({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const map = {};
      for (const c of COLUMNS) {
        if (c.isImage) { map[c.key] = ["Has image", "No image"]; continue; }
        try {
          const res = await api.get(`/stock-master/distinct/${c.key}`);
          map[c.key] = Array.isArray(res.data?.values) ? res.data.values : [];
        } catch {
          map[c.key] = [];
        }
      }
      if (!cancelled) setUniqueValues(map);
    })();
    return () => { cancelled = true; };
  }, []);

  // Refresh distinct values whenever items change (e.g. after add/edit/import) — debounced
  useEffect(() => {
    const t = setTimeout(async () => {
      const map = {};
      for (const c of COLUMNS) {
        if (c.isImage) { map[c.key] = ["Has image", "No image"]; continue; }
        try {
          const res = await api.get(`/stock-master/distinct/${c.key}`);
          map[c.key] = Array.isArray(res.data?.values) ? res.data.values : [];
        } catch {
          map[c.key] = [];
        }
      }
      setUniqueValues(map);
    }, 1500);
    return () => clearTimeout(t);
  }, [total]);

  const itemHasImage = (row) => Array.isArray(row.images) && row.images.length > 0;

  // Filtering & sorting are now done by the backend. The frontend just renders
  // whatever the server returns for this page.
  const visibleItems = items;

  // ── Search matches inside the currently visible rows ─────────────────────
 const matches = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    // Don't highlight against stale data — wait until the filtered list arrives
    if (search !== loadedSearch) return [];
    const out = [];
    visibleItems.forEach((row, rowIdx) => {
      COLUMNS.forEach((col) => {
        if (col.isImage) return;
        const val = row[col.key];
        if (val === null || val === undefined || val === "") return;
        if (String(val).toLowerCase().includes(q)) {
          out.push({ rowIdx, colKey: col.key });
        }
      });
    });
    return out;
  }, [visibleItems, search, loadedSearch]);

  const currentMatch = matches[matchIdx] || null;

  useEffect(() => { setMatchIdx(0); }, [search]);
  useEffect(() => {
    if (matches.length > 0 && matchIdx >= matches.length) setMatchIdx(0);
  }, [matches.length, matchIdx]);

 // Auto-scroll the active search match cell into view
  useEffect(() => {
    const el = currentCellRef.current;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }
  }, [matchIdx, matches.length]);

  // Ctrl+F / Cmd+F focuses the search box (overrides browser Find)
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        if (searchInputRef.current) {
          searchInputRef.current.focus();
          searchInputRef.current.select();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const goNextMatch = () => {
    if (!matches.length) return;
    setMatchIdx((i) => (i + 1) % matches.length);
  };
  const goPrevMatch = () => {
    if (!matches.length) return;
    setMatchIdx((i) => (i - 1 + matches.length) % matches.length);
  };

  // Cell highlight class — colKey null = SL NO / ACTIONS columns (row-only highlight)
  const cellClass = (rowIdx, colKey) => {
    if (!search.trim() || !currentMatch) return "";
    const q = search.trim().toLowerCase();

    let isMatch = false;
    if (colKey && colKey !== "images") {
      const row = visibleItems[rowIdx];
      const val = row?.[colKey];
      if (val !== null && val !== undefined && val !== "") {
        isMatch = String(val).toLowerCase().includes(q);
      }
    }

    if (colKey && rowIdx === currentMatch.rowIdx && colKey === currentMatch.colKey) {
      return "bg-green-300";  // strongest — current match
    }
    if (isMatch) {
      return "bg-green-100";  // other matches
    }
    if (rowIdx === currentMatch.rowIdx || (colKey && colKey === currentMatch.colKey)) {
      return "bg-green-50";   // row + column cross
    }
    return "";
  };

  const tdCls = (rowIdx, colKey, base = "") => {
    const hl = cellClass(rowIdx, colKey);
    return [base, hl].filter(Boolean).join(" ");
  };

  const setColFilter = (key, set) => setColFilters((f) => {
    const next = { ...f };
    if (!set || set.size === 0) delete next[key];
    else next[key] = set;
    return next;
  });

  const activeFilterCount = Object.keys(colFilters).length;

  const openNew = () => { setEditing(null); setForm(emptyForm); setOpen(true); };
  const openEdit = (i) => { setEditing(i); setForm({ ...emptyForm, ...i, images: Array.isArray(i.images) ? i.images : [] }); setOpen(true); };

  const [viewer, setViewer] = useState(null);
  const openViewer = (item, idx) => {
    const list = Array.isArray(item.images) && item.images.length > 0 ? item.images : (item.image ? [item.image] : []);
    if (list.length === 0) return;
    setViewer({ images: list, idx });
  };

  const save = async () => {
    if (!form.part_no.trim() || !form.make.trim()) {
      toast.error("Part No. and Make are required");
      return;
    }
    const payload = { ...form, reorder_level: Math.max(0, parseInt(form.reorder_level, 10) || 0) };
    try {
      if (editing) await api.put(`/stock-master/${editing.id}`, payload);
      else await api.post("/stock-master", payload);
      toast.success(editing ? "Item updated" : "Item created");
      setOpen(false); load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    }
  };

  const del = async (id) => {
    if (!window.confirm("Delete this item?")) return;
    try {
      await api.delete(`/stock-master/${id}`);
      toast.success("Deleted"); load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Cannot delete this item");
    }
  };

  const handleFileSelected = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (excelInput.current) excelInput.current.value = "";

    setPendingFile(file);
    setPreviewing(true);
    setPreview(null);
    setPreviewOpen(true);

    try {
      const fd = new FormData();
      fd.append("file", file);
      const { data } = await api.post("/stock-master/bulk-preview", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setPreview(data);
    } catch (err) {
      setPreviewOpen(false);
      setPendingFile(null);
      toast.error(formatApiError(err.response?.data?.detail) || "Could not read the file");
    } finally {
      setPreviewing(false);
    }
  };

  const handleConfirmImport = async (mode) => {
    if (!pendingFile) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", pendingFile);
      const { data } = await api.post(`/stock-master/bulk-upload?mode=${mode}`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const parts = [`Inserted ${data.inserted} new item(s)`];
      if (mode === "overwrite" && data.overwritten > 0) parts.push(`updated ${data.overwritten} existing item(s)`);
      if (data.skipped > 0) parts.push(`skipped ${data.skipped}`);
      toast.success(parts.join(", ") + `  ·  ${data.total_rows} rows in file`);
      setPreviewOpen(false); setPendingFile(null); setPreview(null);
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const handleClosePreview = () => {
    if (importing) return;
    setPreviewOpen(false); setPendingFile(null); setPreview(null);
  };

  const downloadTemplate = async () => {
    try {
      const res = await api.get("/stock-master/download/template", { responseType: "blob" });
      const url = window.URL.createObjectURL(new Blob([res.data], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url; a.download = "stock_master_template.csv";
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
      toast.success("Template downloaded");
    } catch { toast.error("Could not download template"); }
  };

   // Close export menu when clicking outside
  useEffect(() => {
    if (!exportMenuOpen) return;
    const handler = (e) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [exportMenuOpen]);

  // Fetch every page from the server. If `useCurrentView` is true, also forward
  // the active search, column filters, and sort.
  const fetchAllPages = async (useCurrentView, label) => {
    const all = [];
    let pageNum = 1;
    while (true) {
      const sp = new URLSearchParams();
      sp.set("page", String(pageNum));
      sp.set("page_size", String(PAGE_SIZE));
      if (useCurrentView) {
        if (search) sp.set("search", search);
        if (sort.key && sort.dir) {
          sp.set("sort_by", sort.key);
          sp.set("sort_dir", sort.dir);
        }
        Object.entries(colFilters).forEach(([key, set]) => {
          if (!set || set.size === 0) return;
          for (const v of set) sp.append(`filter[${key}]`, v);
        });
      }
      const res = await api.get(`/stock-master?${sp.toString()}`);
      all.push(...res.data);
      const totalCount = parseInt(res.headers["x-total-count"], 10) || all.length;
      setExportProgress({ loaded: all.length, total: totalCount, label });
      if (all.length >= totalCount || res.data.length === 0) break;
      pageNum += 1;
    }
    return all;
  };

  // Build a real .xlsx file with one worksheet and trigger a download
  const buildAndDownloadXlsx = (rows, filename) => {
    const data = rows.map((r, idx) => ({
      "SL NO": idx + 1,
      "MODEL": r.model || "",
      "PART NO": r.part_no || "",
      "OLD PART NO": r.old_part_no || "",
      "MAKE PART NO": r.make_part_no || "",
      "DESCRIPTION 1": r.description_1 || "",
      "DESCRIPTION 2": r.description_2 || "",
      "REMARKS OEM": r.remarks_oem || "",
      "REMARKS OTHERS": r.remarks_others || "",
      "MAKE": r.make || "",
      "ITEM CATEGORY": r.item_category || "",
      "REORDER LEVEL": r.reorder_level || 0,
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws["!cols"] = [
      { wch: 6 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 18 },
      { wch: 30 }, { wch: 30 }, { wch: 22 }, { wch: 22 }, { wch: 14 },
      { wch: 18 }, { wch: 14 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Stock Master");
    XLSX.writeFile(wb, filename);
  };

 const exportFullStockMaster = async () => {
    setExportMenuOpen(false);
    setExporting(true);
    setExportProgress({ loaded: 0, total: 0, label: "Fetching all items…" });
    try {
      const all = await fetchAllPages(false, "Fetching all items…");
    try {
      const all = await fetchAllPages(false, "Fetching all items…");
      if (!all.length) { toast.error("No items to export"); return; }
      setExportProgress({ loaded: all.length, total: all.length, label: "Generating Excel file…" });
      const ts = new Date().toISOString().slice(0, 10);
      buildAndDownloadXlsx(all, `stock_master_full_${ts}.xlsx`);
      toast.success(`Exported ${all.length.toLocaleString()} item(s)`);
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const exportCurrentView = async () => {
    setExportMenuOpen(false);
    setExporting(true);
    setExportProgress({ loaded: 0, total: 0, label: "Fetching matching items…" });
    try {
      const all = await fetchAllPages(true, "Fetching matching items…");
      if (!all.length) { toast.error("Nothing matches the current view"); return; }
      setExportProgress({ loaded: all.length, total: all.length, label: "Generating Excel file…" });
      const ts = new Date().toISOString().slice(0, 10);
      buildAndDownloadXlsx(all, `stock_master_view_${ts}.xlsx`);
      toast.success(`Exported ${all.length.toLocaleString()} item(s)`);
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Export failed");
    } finally {
      setExporting(false);
    }
  };

  // Sticky header cell base style
  const stickyTh = "sticky top-0 z-20 bg-slate-50";

  return (
    <div className="p-8 max-w-[1600px] mx-auto" data-testid="stock-master-page">
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="label-sm mb-2">Catalog</div>
          <h1 className="text-4xl font-black tracking-tight text-slate-900">Stock Master</h1>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button onClick={load} variant="outline" className="rounded-sm border-slate-300" disabled={loading} data-testid="refresh-button">
            <ArrowsClockwise size={16} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button onClick={downloadTemplate} variant="outline" className="rounded-sm border-slate-300" data-testid="download-template-button">
            <DownloadSimple size={16} weight="bold" className="mr-2" /> Download Template
          </Button>
          <div className="relative" ref={exportMenuRef}>
            <Button
              onClick={() => setExportMenuOpen((v) => !v)}
              variant="outline"
              className="rounded-sm border-slate-300"
              disabled={exporting}
              data-testid="export-button"
            >
              <FileArrowDown size={16} weight="bold" className="mr-2" /> Export
              <CaretDown size={12} weight="bold" className="ml-2" />
            </Button>
            {exportMenuOpen && (
              <div
                className="absolute right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-sm shadow-lg w-72 py-1"
                data-testid="export-menu"
              >
                <button
                  onClick={exportFullStockMaster}
                  className="w-full text-left px-3 py-2 hover:bg-slate-50 flex flex-col gap-0.5"
                  data-testid="export-full"
                >
                  <span className="text-sm font-semibold text-slate-800">Export Full Stock Master</span>
                  <span className="text-[11px] text-slate-500">Every item in the master, ignoring filters.</span>
                </button>
                <button
                  onClick={exportCurrentView}
                  className="w-full text-left px-3 py-2 hover:bg-slate-50 flex flex-col gap-0.5"
                  data-testid="export-view"
                >
                  <span className="text-sm font-semibold text-slate-800">Export Current View</span>
                  <span className="text-[11px] text-slate-500">All pages, with current search, filters &amp; sort applied.</span>
                </button>
              </div>
            )}
          </div>
          <input ref={excelInput} type="file" accept=".xlsx,.xls,.csv" onChange={handleFileSelected} className="hidden" data-testid="bulk-upload-input" />
          <Button onClick={() => excelInput.current?.click()} variant="outline" className="rounded-sm border-slate-300" data-testid="bulk-upload-button">
            <UploadSimple size={16} weight="bold" className="mr-2" /> Bulk Import
          </Button>
          <Button onClick={openNew} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="new-item-button">
            <Plus size={16} weight="bold" className="mr-2" /> Add New Item
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative max-w-md flex-1">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input
            ref={searchInputRef}
            placeholder="Search part no, descriptions, remarks, make, category… (Ctrl+F)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) goPrevMatch(); else goNextMatch();
              }
            }}
            className="pl-10 pr-9 rounded-sm"
            data-testid="search-input"
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

        {/* Match counter + Up/Down navigation (visible while searching) */}
        {search.trim() && (
          <div className="flex items-center gap-1 text-xs" data-testid="match-nav">
            <span className="font-mono font-semibold text-slate-700 px-2 py-1 bg-slate-100 rounded-sm">
              {search !== loadedSearch
                ? "Searching…"
                : matches.length > 0 ? `${matchIdx + 1} of ${matches.length}` : "No matches"}
            </span>
            <button
              onClick={goPrevMatch}
              disabled={!matches.length}
              title="Previous match (Shift+Enter)"
              className="p-1.5 rounded-sm hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
              data-testid="match-prev"
            >
              <CaretUp size={14} weight="bold" />
            </button>
            <button
              onClick={goNextMatch}
              disabled={!matches.length}
              title="Next match (Enter)"
              className="p-1.5 rounded-sm hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
              data-testid="match-next"
            >
              <CaretDown size={14} weight="bold" />
            </button>
          </div>
        )}

        <div className="flex items-center gap-2 text-xs text-slate-500">
          <FunnelSimple size={14} weight="bold" />
          <span>{activeFilterCount > 0 ? `${activeFilterCount} column filter(s) active` : "Click any column to filter or sort"}</span>
        </div>
        {(activeFilterCount > 0 || sort.key) && (
          <Button onClick={() => { setColFilters({}); setSort({ key: null, dir: null }); }} variant="ghost" size="sm" className="rounded-sm h-7 text-xs" data-testid="clear-filters-button">
            <X size={12} weight="bold" className="mr-1" /> Clear filters & sort
          </Button>
        )}
      </div>

      {/* Scroll container — both axes scroll, sticky header inside */}
      <div
        className="bg-white border border-slate-200 rounded-sm overflow-auto"
        style={{ maxHeight: "calc(100vh - 320px)", minHeight: "400px" }}
        data-testid="stock-master-scroller"
      >
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className={`${stickyTh} w-14`}>SL NO</th>
              {COLUMNS.map((c) => (
                <th key={c.key} className={stickyTh}>
                  <ExcelColumnFilter
                    label={c.label}
                    values={uniqueValues[c.key] || []}
                    selected={colFilters[c.key]}
                    onChange={(s) => setColFilter(c.key, s)}
                    sortDir={sort.key === c.key ? sort.dir : null}
                    onSort={c.isImage ? null : (dir) => setSort(dir ? { key: c.key, dir } : { key: null, dir: null })}
                    isNumeric={c.isNumeric}
                  />
                </th>
              ))}
              <th className={`${stickyTh} text-right`}>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {visibleItems.map((i, idx) => {
              const isCurrentRow = !!(currentMatch && currentMatch.rowIdx === idx);
              const cellRef = (colKey) =>
                isCurrentRow && currentMatch.colKey === colKey ? currentCellRef : null;
              return (
                <tr key={i.id} data-testid={`item-row-${i.part_no}-${i.make}`}>
                  <td className={tdCls(idx, null, "font-mono text-slate-500")}>{idx + 1}</td>

                  <td ref={cellRef("model")} className={tdCls(idx, "model", "font-mono text-slate-600")}>{i.model || "—"}</td>
                  <td ref={cellRef("part_no")} className={tdCls(idx, "part_no", "font-mono font-semibold")}>{i.part_no}</td>
                  <td ref={cellRef("old_part_no")} className={tdCls(idx, "old_part_no", "font-mono text-slate-600")}>{i.old_part_no || "—"}</td>
                  <td ref={cellRef("make_part_no")} className={tdCls(idx, "make_part_no", "font-mono text-slate-600")}>{i.make_part_no || "—"}</td>
                  <td ref={cellRef("description_1")} className={tdCls(idx, "description_1", "text-slate-700 max-w-[200px] truncate")}>{i.description_1 || "—"}</td>
                  <td ref={cellRef("description_2")} className={tdCls(idx, "description_2", "text-slate-700 max-w-[200px] truncate")}>{i.description_2 || "—"}</td>
                  <td ref={cellRef("remarks_oem")} className={tdCls(idx, "remarks_oem", "text-slate-600 max-w-[180px] truncate")}>{i.remarks_oem || "—"}</td>
                  <td ref={cellRef("remarks_others")} className={tdCls(idx, "remarks_others", "text-slate-600 max-w-[180px] truncate")}>{i.remarks_others || "—"}</td>
                  <td ref={cellRef("make")} className={tdCls(idx, "make")}>{i.make}</td>
                  <td ref={cellRef("item_category")} className={tdCls(idx, "item_category")}>{i.item_category || "—"}</td>
                  <td ref={cellRef("reorder_level")} className={tdCls(idx, "reorder_level", "font-mono text-slate-700")}>{i.reorder_level || 0}</td>

                  <td className={tdCls(idx, "images")}>
                    {(() => {
                      const list = Array.isArray(i.images) && i.images.length > 0 ? i.images : (i.image ? [i.image] : []);
                      if (list.length === 0) {
                        return (
                          <div className="h-10 w-10 flex items-center justify-center bg-slate-50 border border-slate-200 rounded-sm text-slate-400" data-testid={`image-empty-${i.id}`}>
                            <ImgIcon size={16} />
                          </div>
                        );
                      }
                      return (
                        <div className="relative inline-flex items-center" data-testid={`image-cell-${i.id}`}>
                          <AuthImage path={list[0]} alt="" className="h-10 w-10 object-cover rounded-sm border border-slate-200 cursor-pointer hover:opacity-80" onClick={() => openViewer(i, 0)} testid={`image-thumb-${i.id}`} />
                          {list.length > 1 && (
                            <span className="ml-1 text-[10px] font-mono font-bold text-slate-700 bg-slate-100 px-1 rounded-sm" data-testid={`image-count-${i.id}`}>+{list.length - 1}</span>
                          )}
                        </div>
                      );
                    })()}
                  </td>

                  <td className={tdCls(idx, null, "text-right whitespace-nowrap")}>
                    <button onClick={() => openEdit(i)} className="p-1.5 hover:bg-slate-100 rounded-sm mr-1" data-testid={`edit-${i.id}`}>
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => del(i.id)} disabled={!!i.in_use}
                      title={i.in_use ? "Cannot delete — transactions are recorded against this item" : "Delete"}
                      className={`p-1.5 rounded-sm ${i.in_use ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                      data-testid={`delete-${i.id}`}>
                      <Trash size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {visibleItems.length === 0 && (
              <tr><td colSpan={14} className="text-center py-12 text-slate-500">{loading ? "Loading…" : "No items found."}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      <div className="flex items-center justify-between mt-3 text-xs text-slate-600" data-testid="stock-master-pagination">
        <div>
          {total === 0 ? "No items" : (
            <>
              Showing <span className="font-semibold text-slate-900">{visibleItems.length}</span>
              {" · "}<span className="font-semibold text-slate-900">{total}</span> total
              {(activeFilterCount > 0 || !!sort.key) && <span className="text-slate-500"> (filtered)</span>}
            </>
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
          <span className="text-slate-400 ml-2">{PAGE_SIZE.toLocaleString()} / page</span>
        </div>
      </div>

      {/* Add / Edit dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl rounded-sm">
          <DialogHeader>
            <DialogTitle className="text-2xl font-black">{editing ? "Edit Item" : "New Item"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Model" val={form.model} on={(v) => setForm({ ...form, model: v })} testid="form-model" />
            <Field label="Part No. *" val={form.part_no} on={(v) => setForm({ ...form, part_no: v })} testid="form-part-no" />
            <Field label="Old Part No." val={form.old_part_no} on={(v) => setForm({ ...form, old_part_no: v })} testid="form-old-part-no" />
            <Field label="Make Part No." val={form.make_part_no} on={(v) => setForm({ ...form, make_part_no: v })} testid="form-make-part-no" />
            <Field label="Description 1" val={form.description_1} on={(v) => setForm({ ...form, description_1: v })} testid="form-desc-1" />
            <Field label="Description 2" val={form.description_2} on={(v) => setForm({ ...form, description_2: v })} testid="form-desc-2" />
            <div className="col-span-2 grid grid-cols-2 gap-4">
              <div>
                <Label className="label-sm">Remarks OEM</Label>
                <Textarea value={form.remarks_oem} onChange={(e) => setForm({ ...form, remarks_oem: e.target.value })} className="mt-2 rounded-sm" rows={2} data-testid="form-remarks-oem" />
              </div>
              <div>
                <Label className="label-sm">Remarks Others</Label>
                <Textarea value={form.remarks_others} onChange={(e) => setForm({ ...form, remarks_others: e.target.value })} className="mt-2 rounded-sm" rows={2} data-testid="form-remarks-others" />
              </div>
            </div>
            <Field label="Make *" val={form.make} on={(v) => setForm({ ...form, make: v })} testid="form-make" />
            <Field label="Item Category" val={form.item_category} on={(v) => setForm({ ...form, item_category: v })} testid="form-category" />
            <div>
              <Label className="label-sm">Reorder Level</Label>
              <Input
                type="number" min="0" inputMode="numeric"
                value={form.reorder_level ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setForm({ ...form, reorder_level: v === "" ? "" : Math.max(0, parseInt(v, 10) || 0) });
                }}
                onBlur={(e) => {
                  if (e.target.value === "" || isNaN(parseInt(e.target.value, 10))) {
                    setForm((f) => ({ ...f, reorder_level: 0 }));
                  }
                }}
                className="mt-2 rounded-sm font-mono"
                data-testid="form-reorder-level"
              />
              <div className="text-[11px] text-slate-500 mt-1">Item shows in Low Stock when current qty ≤ this value. Set 0 to disable.</div>
            </div>
            <div className="col-span-2">
              <Label className="label-sm">Images</Label>
              <div className="mt-2">
                <StockMasterImageUploader value={form.images} onChange={(images) => setForm((f) => ({ ...f, images }))} testid="form-images" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} className="rounded-sm">Cancel</Button>
            <Button onClick={save} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="form-save-button">
              {editing ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {previewing && previewOpen && !preview && (
        <Dialog open={true}>
          <DialogContent className="max-w-lg rounded-sm">
            <DialogHeader>
              <DialogTitle className="text-xl font-black">Analysing File…</DialogTitle>
            </DialogHeader>
            <div className="flex items-center gap-3 py-6 text-slate-500 text-sm">
              <ArrowsClockwise size={20} weight="bold" className="animate-spin text-blue-600 shrink-0" />
              Checking items against existing stock master records…
            </div>
          </DialogContent>
        </Dialog>
      )}

      {preview && (
        <ImportPreviewDialog
          open={previewOpen}
          onClose={handleClosePreview}
          preview={preview}
          file={pendingFile}
          onConfirm={handleConfirmImport}
          importing={importing}
        />
      )}

     <ImageViewerDialog open={!!viewer} images={viewer?.images || []} startIndex={viewer?.idx || 0} onClose={() => setViewer(null)} />

      {exporting && (
        <Dialog open={true}>
          <DialogContent className="max-w-sm rounded-sm">
            <DialogHeader>
              <DialogTitle className="text-lg font-black">Preparing Export…</DialogTitle>
            </DialogHeader>
            <div className="py-4 space-y-3">
              <div className="flex items-center gap-3 text-slate-600 text-sm">
                <ArrowsClockwise size={18} weight="bold" className="animate-spin text-blue-600 shrink-0" />
                {exportProgress.label}
              </div>
              {exportProgress.total > 0 && (
                <>
                  <div className="font-mono text-xs text-slate-700">
                    {exportProgress.loaded.toLocaleString()} / {exportProgress.total.toLocaleString()} item(s)
                  </div>
                  <div className="w-full h-2 bg-slate-100 rounded-sm overflow-hidden">
                    <div
                      className="h-full bg-blue-600 transition-all"
                      style={{ width: `${Math.min(100, (exportProgress.loaded / Math.max(1, exportProgress.total)) * 100)}%` }}
                    />
                  </div>
                </>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function Field({ label, val, on, testid }) {
  return (
    <div>
      <Label className="label-sm">{label}</Label>
      <Input value={val || ""} onChange={(e) => on(e.target.value)} className="mt-2 rounded-sm" data-testid={testid} />
    </div>
  );
}