import React, { useRef, useState } from "react";
import { api, formatApiError } from "../lib/api";
import { toast } from "sonner";
import { Trash } from "@phosphor-icons/react";
import AuthImage from "./AuthImage";
import ImageViewerDialog from "./ImageViewerDialog";

const MAX_IMAGES = 5;
const ACCEPT = ".png,.jpg,.jpeg,.gif,.webp";

export default function StockMasterImageUploader({ value, onChange, testid = "sm-images" }) {
  const images = Array.isArray(value) ? value : [];
  const [uploading, setUploading] = useState(false);
  const [viewerIdx, setViewerIdx] = useState(null);
  const fileInput = useRef(null);

  const remainingSlots = Math.max(0, MAX_IMAGES - images.length);

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    if (images.length + files.length > MAX_IMAGES) {
      toast.error(`You can upload a maximum of ${MAX_IMAGES} images. ${remainingSlots} slot(s) left.`);
      return;
    }
    setUploading(true);
    const next = [...images];
    for (const f of files) {
      try {
        const fd = new FormData();
        fd.append("file", f);
        const { data } = await api.post("/uploads/image", fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
        next.push(data.path);
      } catch (err) {
        toast.error(formatApiError(err.response?.data?.detail) || `Could not upload ${f.name}`);
      }
    }
    setUploading(false);
    onChange(next);
  };

  const onPick = (e) => {
    handleFiles(e.target.files);
    e.target.value = "";
  };

  const removeAt = (i) => {
    const next = images.filter((_, idx) => idx !== i);
    onChange(next);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-slate-500">
          {images.length} of {MAX_IMAGES} images
        </div>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={uploading || images.length >= MAX_IMAGES}
          className="text-[30x] font-semibold text-blue-700 hover:underline disabled:text-slate-400 disabled:no-underline disabled:cursor-not-allowed"
          data-testid={`${testid}-pick`}
        >
          {uploading ? "Uploading…" : (images.length >= MAX_IMAGES ? "Max reached" : "Choose files")}
        </button>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={onPick}
        data-testid={`${testid}-input`}
      />

      {images.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {images.map((path, i) => (
            <div key={i} className="relative group h-8 w-8 border border-slate-200 rounded-sm overflow-hidden bg-slate-50">
              <AuthImage
                path={path}
                alt={`Image ${i + 1}`}
                className="w-full h-full object-cover cursor-pointer"
                onClick={() => setViewerIdx(i)}
              />
              <button
                type="button"
                onClick={() => removeAt(i)}
                className="absolute top-0 right-0 p-0.5 rounded-bl-sm bg-red-700 text-white opacity-0 group-hover:opacity-100"
              >
                <Trash size={8} weight="bold" />
              </button>
            </div>
          ))}
        </div>
      )}

      <ImageViewerDialog
        open={viewerIdx !== null}
        images={images}
        startIndex={viewerIdx ?? 0}
        onClose={() => setViewerIdx(null)}
      />
    </div>
  );
}