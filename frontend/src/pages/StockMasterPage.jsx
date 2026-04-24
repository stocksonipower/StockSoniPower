import React, { useEffect, useState, useRef } from "react";
import { api, formatApiError } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "../components/ui/dialog";
import { toast } from "sonner";
import { Plus, Trash, Pencil, UploadSimple, MagnifyingGlass, Image as ImgIcon, DownloadSimple } from "@phosphor-icons/react";

const emptyForm = {
  model: "", part_no: "", old_part_no: "", make_part_no: "", oem: "",
  description_1: "", description_2: "", remarks: "",
  make: "", item_category: "", image: "",
};

export default function StockMasterPage() {
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const fileInput = useRef(null);
  const excelInput = useRef(null);

  const load = async () => {
    const { data } = await api.get("/stock-master", { params: search ? { search } : {} });
    setItems(data);
  };

  useEffect(() => { load(); }, [search]);

  const openNew = () => { setEditing(null); setForm(emptyForm); setOpen(true); };
  const openEdit = (i) => { setEditing(i); setForm({ ...emptyForm, ...i }); setOpen(true); };

  const handleImage = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setForm((f) => ({ ...f, image: reader.result }));
    reader.readAsDataURL(file);
  };

  const save = async () => {
    if (!form.part_no.trim() || !form.make.trim()) {
      toast.error("Part No. and Make are required");
      return;
    }
    try {
      if (editing) await api.put(`/stock-master/${editing.id}`, form);
      else await api.post("/stock-master", form);
      toast.success(editing ? "Item updated" : "Item created");
      setOpen(false); load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    }
  };

  const del = async (id) => {
    if (!window.confirm("Delete this item?")) return;
    await api.delete(`/stock-master/${id}`);
    toast.success("Deleted"); load();
  };

  const bulkUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const { data } = await api.post("/stock-master/bulk-upload", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      toast.success(`Inserted ${data.inserted}, skipped ${data.skipped} of ${data.total_rows} rows`);
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally {
      if (excelInput.current) excelInput.current.value = "";
    }
  };

  const downloadTemplate = async () => {
    try {
      const res = await api.get("/stock-master/download/template", { responseType: "blob" });
      const url = window.URL.createObjectURL(new Blob([res.data], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "stock_master_template.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast.success("Template downloaded");
    } catch (err) {
      toast.error("Could not download template");
    }
  };

  return (
    <div className="p-8 max-w-[1600px] mx-auto" data-testid="stock-master-page">
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="label-sm mb-2">Catalog</div>
          <h1 className="text-4xl font-black tracking-tight text-slate-900">Stock Master</h1>
        </div>
        <div className="flex gap-2">
          <Button onClick={downloadTemplate} variant="outline" className="rounded-sm border-slate-300" data-testid="download-template-button">
            <DownloadSimple size={16} weight="bold" className="mr-2" /> Download Template
          </Button>
          <input ref={excelInput} type="file" accept=".xlsx,.xls,.csv" onChange={bulkUpload} className="hidden" data-testid="bulk-upload-input" />
          <Button onClick={() => excelInput.current?.click()} variant="outline" className="rounded-sm border-slate-300" data-testid="bulk-upload-button">
            <UploadSimple size={16} weight="bold" className="mr-2" /> Bulk Import
          </Button>
          <Button onClick={openNew} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="new-item-button">
            <Plus size={16} weight="bold" className="mr-2" /> Add New Item
          </Button>
        </div>
      </div>

      <div className="relative mb-4">
        <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <Input
          placeholder="Search by part_no, make, description, model…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10 rounded-sm max-w-md"
          data-testid="search-input"
        />
      </div>

      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th className="w-14">SL NO</th>
              <th>MODEL</th>
              <th>PART NO</th>
              <th>OLD NO</th>
              <th>MAKE PART NO</th>
              <th>OEM</th>
              <th>DESCRIPTION 1</th>
              <th>DESCRIPTION 2</th>
              <th>REMARKS</th>
              <th>MAKE</th>
              <th>CATEGORY</th>
              <th>IMAGE</th>
              <th className="text-right">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i, idx) => (
              <tr key={i.id} data-testid={`item-row-${i.part_no}-${i.make}`}>
                <td className="font-mono text-slate-500">{idx + 1}</td>
                <td className="font-mono text-slate-600">{i.model || "—"}</td>
                <td className="font-mono font-semibold">{i.part_no}</td>
                <td className="font-mono text-slate-600">{i.old_part_no || "—"}</td>
                <td className="font-mono text-slate-600">{i.make_part_no || "—"}</td>
                <td className="font-mono text-slate-600">{i.oem || "—"}</td>
                <td className="text-slate-700 max-w-[200px] truncate">{i.description_1 || "—"}</td>
                <td className="text-slate-700 max-w-[200px] truncate">{i.description_2 || "—"}</td>
                <td className="text-slate-600 max-w-[180px] truncate">{i.remarks || "—"}</td>
                <td>{i.make}</td>
                <td>{i.item_category || "—"}</td>
                <td>
                  {i.image ? (
                    <img src={i.image} alt="" className="h-10 w-10 object-cover rounded-sm border border-slate-200" />
                  ) : (
                    <div className="h-10 w-10 flex items-center justify-center bg-slate-50 border border-slate-200 rounded-sm text-slate-400">
                      <ImgIcon size={16} />
                    </div>
                  )}
                </td>
                <td className="text-right whitespace-nowrap">
                  <button onClick={() => openEdit(i)} className="p-1.5 hover:bg-slate-100 rounded-sm mr-1" data-testid={`edit-${i.id}`}>
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => del(i.id)} className="p-1.5 hover:bg-red-50 text-red-700 rounded-sm" data-testid={`delete-${i.id}`}>
                    <Trash size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={13} className="text-center py-12 text-slate-500">No items found.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl rounded-sm">
          <DialogHeader>
            <DialogTitle className="text-2xl font-black">{editing ? "Edit Item" : "New Item"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Model" val={form.model} on={(v) => setForm({ ...form, model: v })} testid="form-model" />
            <Field label="Part No. *" val={form.part_no} on={(v) => setForm({ ...form, part_no: v })} testid="form-part-no" />
            <Field label="Old No." val={form.old_part_no} on={(v) => setForm({ ...form, old_part_no: v })} testid="form-old-part-no" />
            <Field label="Make Part No." val={form.make_part_no} on={(v) => setForm({ ...form, make_part_no: v })} testid="form-make-part-no" />
            <Field label="OEM" val={form.oem} on={(v) => setForm({ ...form, oem: v })} testid="form-oem" />
            <Field label="Description 1" val={form.description_1} on={(v) => setForm({ ...form, description_1: v })} testid="form-desc-1" />
            <Field label="Description 2" val={form.description_2} on={(v) => setForm({ ...form, description_2: v })} testid="form-desc-2" />
            <Field label="Make *" val={form.make} on={(v) => setForm({ ...form, make: v })} testid="form-make" />
            <Field label="Category" val={form.item_category} on={(v) => setForm({ ...form, item_category: v })} testid="form-category" />
            <div className="col-span-2">
              <Label className="label-sm">Remarks</Label>
              <Textarea value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} className="mt-2 rounded-sm" data-testid="form-remarks" />
            </div>
            <div className="col-span-2">
              <Label className="label-sm">Image</Label>
              <div className="flex items-center gap-4 mt-2">
                {form.image && <img src={form.image} alt="" className="h-16 w-16 object-cover rounded-sm border border-slate-200" />}
                <input ref={fileInput} type="file" accept="image/*" onChange={handleImage} className="hidden" data-testid="form-image-input" />
                <Button type="button" variant="outline" onClick={() => fileInput.current?.click()} className="rounded-sm">
                  {form.image ? "Change" : "Upload"} Image
                </Button>
                {form.image && (
                  <Button type="button" variant="ghost" onClick={() => setForm({ ...form, image: "" })} className="rounded-sm text-red-700">
                    Remove
                  </Button>
                )}
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
