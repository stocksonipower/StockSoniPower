import React, { useEffect, useRef, useState } from "react";
import { api, formatApiError } from "../lib/api";
import { toast } from "sonner";
import { Trash, UploadSimple, ArrowClockwise, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import AuthImage from "./AuthImage";
import ImageViewerDialog from "./ImageViewerDialog";

const MAX_IMAGES = 5;
const ACCEPT = ".png,.jpg,.jpeg,.gif,.webp";
const ACCEPT_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);
const MAX_BYTES = 10 * 1024 * 1024;
const RING_R = 13;
const RING_C = 2 * Math.PI * RING_R;

/** Circular upload-progress ring drawn over the local image preview — the
 * spinning-partial-circle pattern used by Drive/Slack/WhatsApp attachments. */
function ProgressRing({ progress, done }) {
  return (
    <svg viewBox="0 0 32 32" className="h-6 w-6 -rotate-90">
      <circle cx="16" cy="16" r={RING_R} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="3" />
      <circle
        cx="16" cy="16" r={RING_R} fill="none"
        stroke={done ? "#22c55e" : "#ffffff"}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={RING_C}
        strokeDashoffset={RING_C * (1 - (done ? 1 : progress / 100))}
        className="transition-[stroke-dashoffset] duration-200 ease-out"
      />
    </svg>
  );
}

export default function StockMasterImageUploader({ value, onChange, testid = "sm-images" }) {
  const images = Array.isArray(value) ? value : [];
  // In-flight uploads: { id, file, previewUrl, name, progress, done, error }
  const [pending, setPending] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [viewerIdx, setViewerIdx] = useState(null);
  const fileInput = useRef(null);

  const remainingSlots = Math.max(0, MAX_IMAGES - images.length - pending.length);
  const uploadingCount = pending.filter((p) => !p.error && !p.done).length;
  const uploading = uploadingCount > 0;

  // Revoke local object URLs once a thumbnail is no longer pending, to avoid leaking memory.
  useEffect(() => () => pending.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const uploadOne = async (file, localId) => {
    if (!ACCEPT_TYPES.has((file.type || "").toLowerCase())) {
      setPending((p) => p.map((x) => (x.id === localId ? { ...x, error: "Unsupported file type" } : x)));
      return;
    }
    if (file.size > MAX_BYTES) {
      setPending((p) => p.map((x) => (x.id === localId ? { ...x, error: "File too large (max 10MB)" } : x)));
      return;
    }
    try {
      const fd = new FormData();
      fd.append("file", file);
      const { data } = await api.post("/uploads/image", fd, {
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: (evt) => {
          if (!evt.total) return;
          const progress = Math.round((evt.loaded / evt.total) * 100);
          setPending((p) => p.map((x) => (x.id === localId ? { ...x, progress } : x)));
        },
      });
      // Brief "done" checkmark state so the success registers visually before the
      // thumbnail hands off to the permanent (server-backed) image grid.
      setPending((p) => p.map((x) => (x.id === localId ? { ...x, progress: 100, done: true } : x)));
      setTimeout(() => {
        onChange([...images, data.path]);
        setPending((p) => {
          const entry = p.find((x) => x.id === localId);
          if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
          return p.filter((x) => x.id !== localId);
        });
      }, 450);
    } catch (err) {
      const msg = formatApiError(err.response?.data?.detail) || `Could not upload ${file.name}`;
      setPending((p) => p.map((x) => (x.id === localId ? { ...x, error: msg, progress: 0, done: false } : x)));
      toast.error(msg);
    }
  };

  const handleFiles = (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    if (images.length + pending.length + files.length > MAX_IMAGES) {
      toast.error(`You can upload a maximum of ${MAX_IMAGES} images. ${remainingSlots} slot(s) left.`);
      return;
    }
    const entries = files.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      previewUrl: URL.createObjectURL(file),
      name: file.name,
      progress: 0,
      done: false,
      error: null,
    }));
    setPending((p) => [...p, ...entries]);
    entries.forEach((e) => uploadOne(e.file, e.id));
  };

  const retry = (entry) => {
    setPending((p) => p.map((x) => (x.id === entry.id ? { ...x, error: null, progress: 0, done: false } : x)));
    uploadOne(entry.file, entry.id);
  };

  const dismissFailed = (id) => {
    setPending((p) => {
      const entry = p.find((x) => x.id === id);
      if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      return p.filter((x) => x.id !== id);
    });
  };

  const onPick = (e) => {
    handleFiles(e.target.files);
    e.target.value = "";
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (images.length + pending.length >= MAX_IMAGES) return;
    handleFiles(e.dataTransfer.files);
  };

  const removeAt = async (i) => {
    const removedPath = images[i];
    const next = images.filter((_, idx) => idx !== i);
    onChange(next);
    // Best-effort: free the object in R2 immediately. If this fails the backend
    // still cleans up orphans on the next stock-master save, so it's safe to ignore here.
    try {
      await api.delete("/uploads/image", { params: { path: removedPath } });
    } catch {
      // non-fatal — orphan cleanup happens server-side on save
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-slate-500 flex items-center gap-1.5">
          {uploading ? (
            <span className="inline-flex items-center gap-1.5 text-blue-700 font-medium">
              <span className="h-2.5 w-2.5 rounded-full border-2 border-blue-300 border-t-blue-700 animate-spin" />
              Uploading {uploadingCount} image{uploadingCount > 1 ? "s" : ""}…
            </span>
          ) : (
            <span>{images.length} of {MAX_IMAGES} images</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={images.length + pending.length >= MAX_IMAGES}
          className="text-[30x] font-semibold text-blue-700 hover:underline disabled:text-slate-400 disabled:no-underline disabled:cursor-not-allowed"
          data-testid={`${testid}-pick`}
        >
          {images.length + pending.length >= MAX_IMAGES ? "Max reached" : "Choose files"}
        </button>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (images.length + pending.length < MAX_IMAGES) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => images.length + pending.length < MAX_IMAGES && fileInput.current?.click()}
        className={`flex items-center justify-center gap-1.5 rounded-sm border border-dashed text-[11px] py-2 cursor-pointer transition-colors ${
          dragOver ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-300 text-slate-400 hover:border-slate-400"
        } ${images.length + pending.length >= MAX_IMAGES ? "opacity-50 cursor-not-allowed" : ""}`}
        data-testid={`${testid}-dropzone`}
      >
        <UploadSimple size={12} />
        Drag & drop images here, or click to browse
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

      {(images.length > 0 || pending.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((path, i) => (
            <div key={path} className="relative group h-10 w-10 border border-slate-200 rounded-sm overflow-hidden bg-slate-50">
              <AuthImage
                path={path}
                alt={`Image ${i + 1}`}
                className="w-full h-full object-cover cursor-pointer"
                onClick={() => setViewerIdx(i)}
              />
              <button
                type="button"
                onClick={() => removeAt(i)}
                className="absolute top-0 right-0 p-0.5 rounded-bl-sm bg-red-700 text-white opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Trash size={8} weight="bold" />
              </button>
            </div>
          ))}

          {pending.map((entry) => (
            <div
              key={entry.id}
              className="relative h-10 w-10 border border-slate-200 rounded-sm overflow-hidden bg-slate-100"
              title={entry.error || `${entry.name} — ${entry.done ? "Done" : `${entry.progress}%`}`}
              data-testid={`${testid}-pending-${entry.id}`}
            >
              {/* Local preview shows instantly — the user sees their actual photo, not a placeholder */}
              <img src={entry.previewUrl} alt={entry.name} className="w-full h-full object-cover" />

              {entry.error ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 bg-red-900/70">
                  <WarningCircle size={14} weight="bold" className="text-white" />
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => retry(entry)}
                      className="text-white hover:text-red-200"
                      data-testid={`${testid}-retry`}
                      title="Retry upload"
                    >
                      <ArrowClockwise size={11} weight="bold" />
                    </button>
                    <button
                      type="button"
                      onClick={() => dismissFailed(entry.id)}
                      className="text-white hover:text-red-200"
                      title="Remove"
                    >
                      <Trash size={11} weight="bold" />
                    </button>
                  </div>
                </div>
              ) : (
                <div className={`absolute inset-0 flex items-center justify-center transition-colors ${entry.done ? "bg-emerald-600/40" : "bg-black/45"}`}>
                  {entry.done ? (
                    <CheckCircle size={20} weight="fill" className="text-white animate-in zoom-in-50 duration-200" />
                  ) : (
                    <ProgressRing progress={entry.progress} done={entry.done} />
                  )}
                </div>
              )}
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
