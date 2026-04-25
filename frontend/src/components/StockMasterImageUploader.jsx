import React, { useRef, useState } from "react";
import { api, formatApiError } from "../lib/api";
import { toast } from "sonner";
import { UploadSimple, Trash, Image as ImgIcon, Eye } from "@phosphor-icons/react";
import AuthImage from "./AuthImage";
import ImageViewerDialog from "./ImageViewerDialog";

const MAX_IMAGES = 5;
const ACCEPT = ".png,.jpg,.jpeg,.gif,.webp";

/**
 * 5-slot image uploader for Stock Master.
 *
 * Props:
 *   value     - string[] storage paths (default [])
 *   onChange  - (paths: string[]) => void
 */
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

  const onDrop = (e) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  };

  const removeAt = (i) => {
    const next = images.filter((_, idx) => idx !== i);
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500">
          {images.length} of {MAX_IMAGES} image{MAX_IMAGES === 1 ? "" : "s"}
        </div>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={uploading || images.length >= MAX_IMAGES}
          className="text-xs font-semibold text-blue-700 hover:underline disabled:text-slate-400 disabled:no-underline disabled:cursor-not-allowed"
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

      <div
        className={`grid grid-cols-5 gap-2 p-2 rounded-sm border-2 border-dashed ${images.length === 0 ? "border-slate-300 bg-slate-50" : "border-slate-200 bg-white"}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        data-testid={`${testid}-dropzone`}
      >
        {Array.from({ length: MAX_IMAGES }).map((_, i) => {
          const path = images[i];
          if (path) {
            return (
              <div key={i} className="relative group aspect-square border border-slate-200 rounded-sm overflow-hidden bg-slate-50" data-testid={`${testid}-slot-${i}`}>
                <AuthImage
                  path={path}
                  alt={`Image ${i + 1}`}
                  className="w-full h-full object-cover cursor-pointer"
                  onClick={() => setViewerIdx(i)}
                  testid={`${testid}-thumb-${i}`}
                />
                <button
                  type="button"
                  onClick={() => setViewerIdx(i)}
                  className="absolute bottom-1 left-1 p-1 rounded-sm bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  title="View"
                  data-testid={`${testid}-view-${i}`}
                >
                  <Eye size={11} weight="bold" />
                </button>
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  className="absolute top-1 right-1 p-1 rounded-sm bg-red-700 hover:bg-red-800 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Remove"
                  data-testid={`${testid}-remove-${i}`}
                >
                  <Trash size={11} weight="bold" />
                </button>
              </div>
            );
          }
          // Empty slot
          const isNextSlot = i === images.length;
          return (
            <button
              key={i}
              type="button"
              onClick={() => isNextSlot && fileInput.current?.click()}
              disabled={!isNextSlot || uploading}
              className={`aspect-square border border-dashed rounded-sm flex flex-col items-center justify-center gap-1 ${isNextSlot && !uploading ? "border-slate-300 hover:border-blue-500 hover:bg-blue-50 text-slate-500 hover:text-blue-700 cursor-pointer" : "border-slate-200 bg-slate-50 text-slate-300 cursor-not-allowed"}`}
              data-testid={`${testid}-empty-${i}`}
            >
              {isNextSlot ? <UploadSimple size={16} weight="bold" /> : <ImgIcon size={16} />}
              <span className="text-[10px]">{isNextSlot ? "Add" : "—"}</span>
            </button>
          );
        })}
      </div>
      <div className="text-[11px] text-slate-500">
        Drag &amp; drop images or click a slot. PNG / JPG / GIF / WEBP. Max 10MB per image, up to {MAX_IMAGES} per item.
      </div>

      <ImageViewerDialog
        open={viewerIdx !== null}
        images={images}
        startIndex={viewerIdx ?? 0}
        onClose={() => setViewerIdx(null)}
      />
    </div>
  );
}
