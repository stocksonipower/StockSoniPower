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
  FunnelSimple, X, CaretLeft, CaretRight,
  FileText, CheckCircle, Warning, ArrowsLeftRight,
} from "@phosphor-icons/react";
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
  // "skip" = skip duplicates, "overwrite" = overwrite duplicates
  const [mode, setMode] = useState("skip");

  // Reset mode whenever dialog opens with fresh data
  useEffect(() => { if (open) setMode("skip"); }, [open]);

  if (!preview) return null;

  const { file_name, total_items, new_items, duplicate_items, skipped_rows } = preview;

  const stats = [
    {
      label: "File Name",
      value: file_name,
      icon: <FileText size={18} weight="bold" className="text-slate-500" />,
      mono: true,
      wide: true,
    },
    {
      label: "Total Items",
      value: total_items,
      icon: <ArrowsLeftRight size={18} weight="bold" className="text-blue-600" />,
      color: "text-blue-700",
    },
    {
      label: "New Items",
      value: new_items,
      icon: <CheckCircle size={18} weight="bold" className="text-emerald-600" />,
      color: "text-emerald-700",
    },
    {
      label: "Duplicate Items",
      value: duplicate_items,
      icon: <Warning size={18} weight="bold" className="text-amber-500" />,
      color: "text-amber-700",
    },
  ];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !importing) onClose(); }}>
      <DialogContent className="max-w-lg rounded-sm" data-testid="import-preview-dialog">
        <DialogHeader>
          <DialogTitle className="text-xl font-black tracking-tight text-slate-900">
            Review Import
          </DialogTitle>
          <p className="text-xs text-slate-500 mt-1">
            Check the details below before confirming the import.
          </p>
        </DialogHeader>

        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-3 mt-1">
          {stats.map((s) => (
            <div
              key={s.label}
              className={`flex items-start gap-3 bg-slate-50 border border-slate-200 rounded-sm p-3 ${s.wide ? "col-span-2" : ""}`}
            >
              <div className="mt-0.5 shrink-0">{s.icon}</div>
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 mb-0.5">
                  {s.label}
                </div>
                <div
                  className={`font-mono font-bold text-sm truncate ${s.color || "text-slate-800"}`}
                  title={String(s.value)}
                  data-testid={`preview-${s.label.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  {s.value}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Skipped rows note */}
        {skipped_rows > 0 && (
          <p className="text-[11px] text-slate-500 -mt-1">
            <span className="font-semibold text-slate-700">{skipped_rows}</span> row(s) in the file are missing Part No or Make and will always be skipped.
          </p>
        )}

        {/* Mode selector — only meaningful when duplicates exist */}
        <div className="mt-1">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 mb-2">
            How to handle duplicate items
          </div>
          <div className="flex gap-3">
            {/* Skip */}
            <button
              type="button"
              onClick={() => setMode("skip")}
              disabled={importing}
              data-testid="mode-skip"
              className={`
                flex-1 flex items-center gap-3 rounded-sm border-2 px-4 py-3 text-left transition-all
                ${mode === "skip"
                  ? "border-blue-600 bg-blue-50"
                  : "border-slate-200 bg-white hover:border-slate-300"}
                ${importing ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
              `}
            >
              {/* Custom checkbox visual */}
              <span className={`
                shrink-0 h-4 w-4 rounded-sm border-2 flex items-center justify-center transition-colors
                ${mode === "skip" ? "border-blue-600 bg-blue-600" : "border-slate-300 bg-white"}
              `}>
                {mode === "skip" && (
                  <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                    <path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <div>
                <div className="text-sm font-semibold text-slate-800 leading-none mb-1">
                  Skip existing items
                </div>
                <div className="text-[11px] text-slate-500 leading-snug">
                  Only import new items. Duplicates are left unchanged.
                </div>
              </div>
            </button>

            {/* Overwrite */}
            <button
              type="button"
              onClick={() => setMode("overwrite")}
              disabled={importing}
              data-testid="mode-overwrite"
              className={`
                flex-1 flex items-center gap-3 rounded-sm border-2 px-4 py-3 text-left transition-all
                ${mode === "overwrite"
                  ? "border-amber-500 bg-amber-50"
                  : "border-slate-200 bg-white hover:border-slate-300"}
                ${importing ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
              `}
            >
              <span className={`
                shrink-0 h-4 w-4 rounded-sm border-2 flex items-center justify-center transition-colors
                ${mode === "overwrite" ? "border-amber-500 bg-amber-500" : "border-slate-300 bg-white"}
              `}>
                {mode === "overwrite" && (
                  <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                    <path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <div>
                <div className="text-sm font-semibold text-slate-800 leading-none mb-1">
                  Overwrite existing items
                </div>
                <div className="text-[11px] text-slate-500 leading-snug">
                  Update duplicates with data from the file.
                </div>
              </div>
            </button>
          </div>
        </div>

        <DialogFooter className="mt-2 gap-2">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={importing}
            className="rounded-sm"
            data-testid="import-preview-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(mode)}
            disabled={importing || total_items === 0}
            className="rounded-sm bg-blue-700 hover:bg-blue-800 min-w-[160px]"
            data-testid="import-preview-confirm"
          >
            {importing ? (
              <span className="flex items-center gap-2">
                <ArrowsClockwise size={14} weight="bold" className="animate-spin" />
                Importing…
              </span>
            ) : (
              `Confirm Import`
            )}
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
  const PAGE_SIZE = 5000;
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const excelInput = useRef(null);

  // ── Import preview state ──
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState(null);       // response from /bulk-preview
  const [pendingFile, setPendingFile] = useState(null); // the File object held while dialog is open
  const [previewing, setPreviewing] = useState(false);  // loading the preview
  const [importing, setImporting] = useState(false);    // doing the actual import

  const load = async () => {
    setLoading(true);
    try {
      const params = { page, page_size: PAGE_SIZE };
      if (search) params.search = search;
      const res = await api.get("/stock-master", { params });
      setItems(res.data);
      const t = parseInt(res.headers["x-total-count"], 10);
      setTotal(isNaN(t) ? res.data.length : t);
    } finally { setLoading(false); }
  };

  useEffect(() => { setPage(1); }, [search]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); /* eslint-disable-next-line */ }, [search, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const uniqueValues = React.useMemo(() => {
    const map = {};
    COLUMNS.forEach((c) => {
      if (c.isImage) { map[c.key] = ["Has image", "No image"]; return; }
      const seen = new Set();
      items.forEach((it) => {
        const raw = it[c.key];
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
  }, [items]);

  const itemHasImage = (row) => Array.isArray(row.images) && row.images.length > 0;

  const visibleItems = React.useMemo(() => {
    const activeKeys = Object.keys(colFilters);
    let out = items;
    if (activeKeys.length) {
      out = out.filter((row) => activeKeys.every((k) => {
        const allowed = colFilters[k];
        if (!allowed || allowed.size === 0) return true;
        const col = COLUMNS.find((c) => c.key === k);
        if (col?.isImage) return allowed.has(itemHasImage(row) ? "Has image" : "No image");
        const raw = row[k];
        const v = raw === null || raw === undefined || raw === "" ? BLANK : String(raw);
        return allowed.has(v);
      }));
    }
    if (sort.key && sort.dir) {
      const col = COLUMNS.find((c) => c.key === sort.key);
      const numeric = col?.isNumeric;
      out = [...out].sort((a, b) => {
        const av = a[sort.key]; const bv = b[sort.key];
        const aS = av === null || av === undefined ? "" : String(av);
        const bS = bv === null || bv === undefined ? "" : String(bv);
        let cmp;
        if (numeric) cmp = (Number(av) || 0) - (Number(bv) || 0);
        else cmp = aS.localeCompare(bS);
        return sort.dir === "asc" ? cmp : -cmp;
      });
    }
    return out;
  }, [items, colFilters, sort]);

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

  // ── Bulk import: step 1 — show preview ───────────────────────────────────
  const handleFileSelected = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // Clear input so the same file can be re-selected after cancelling
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

  // ── Bulk import: step 2 — actually import with chosen mode ───────────────
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

      setPreviewOpen(false);
      setPendingFile(null);
      setPreview(null);
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const handleClosePreview = () => {
    if (importing) return;
    setPreviewOpen(false);
    setPendingFile(null);
    setPreview(null);
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

  const handleExport = async () => {
    try {
      const res = await api.get("/stock-master/download/export", { responseType: "blob" });
      const url = window.URL.createObjectURL(new Blob([res.data], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url; a.download = `stock_master_export_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
      toast.success(`Export downloaded`);
    } catch { toast.error("Could not export"); }
  };

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
          <Button onClick={handleExport} variant="outline" className="rounded-sm border-slate-300" data-testid="export-button">
            <FileArrowDown size={16} weight="bold" className="mr-2" /> Export
          </Button>
          {/* Hidden file input — triggers preview flow */}
          <input
            ref={excelInput}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleFileSelected}
            className="hidden"
            data-testid="bulk-upload-input"
          />
          <Button
            onClick={() => excelInput.current?.click()}
            variant="outline"
            className="rounded-sm border-slate-300"
            data-testid="bulk-upload-button"
          >
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
            placeholder="Search part no, old/make part no, descriptions, remarks, make, category…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 rounded-sm"
            data-testid="search-input"
          />
        </div>
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

      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-14">SL NO</th>
              {COLUMNS.map((c) => (
                <th key={c.key}>
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
              <th className="text-right">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {visibleItems.map((i, idx) => (
              <tr key={i.id} data-testid={`item-row-${i.part_no}-${i.make}`}>
                <td className="font-mono text-slate-500">{idx + 1}</td>
                <td className="font-mono text-slate-600">{i.model || "—"}</td>
                <td className="font-mono font-semibold">{i.part_no}</td>
                <td className="font-mono text-slate-600">{i.old_part_no || "—"}</td>
                <td className="font-mono text-slate-600">{i.make_part_no || "—"}</td>
                <td className="text-slate-700 max-w-[200px] truncate">{i.description_1 || "—"}</td>
                <td className="text-slate-700 max-w-[200px] truncate">{i.description_2 || "—"}</td>
                <td className="text-slate-600 max-w-[180px] truncate">{i.remarks_oem || "—"}</td>
                <td className="text-slate-600 max-w-[180px] truncate">{i.remarks_others || "—"}</td>
                <td>{i.make}</td>
                <td>{i.item_category || "—"}</td>
                <td className="font-mono text-slate-700">{i.reorder_level || 0}</td>
                <td>
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
                        <AuthImage
                          path={list[0]}
                          alt=""
                          className="h-10 w-10 object-cover rounded-sm border border-slate-200 cursor-pointer hover:opacity-80"
                          onClick={() => openViewer(i, 0)}
                          testid={`image-thumb-${i.id}`}
                        />
                        {list.length > 1 && (
                          <span className="ml-1 text-[10px] font-mono font-bold text-slate-700 bg-slate-100 px-1 rounded-sm" data-testid={`image-count-${i.id}`}>
                            +{list.length - 1}
                          </span>
                        )}
                      </div>
                    );
                  })()}
                </td>
                <td className="text-right whitespace-nowrap">
                  <button onClick={() => openEdit(i)} className="p-1.5 hover:bg-slate-100 rounded-sm mr-1" data-testid={`edit-${i.id}`}>
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => del(i.id)}
                    disabled={!!i.in_use}
                    title={i.in_use ? "Cannot delete — transactions are recorded against this item" : "Delete"}
                    className={`p-1.5 rounded-sm ${i.in_use ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                    data-testid={`delete-${i.id}`}
                  >
                    <Trash size={14} />
                  </button>
                </td>
              </tr>
            ))}
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
              {visibleItems.length !== items.length && <> of <span className="font-semibold text-slate-900">{items.length}</span> on page</>}
              {" · "}<span className="font-semibold text-slate-900">{total}</span> total
              {(activeFilterCount > 0) && <span className="text-slate-500"> (page filtered locally)</span>}
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
                <StockMasterImageUploader
                  value={form.images}
                  onChange={(images) => setForm((f) => ({ ...f, images }))}
                  testid="form-images"
                />
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

      {/* Import preview dialog */}
      {previewing && previewOpen && !preview && (
        // Show a loading overlay inside the dialog while the preview is being fetched
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

      <ImageViewerDialog
        open={!!viewer}
        images={viewer?.images || []}
        startIndex={viewer?.idx || 0}
        onClose={() => setViewer(null)}
      />
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
