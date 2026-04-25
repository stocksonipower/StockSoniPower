import React, { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { CaretLeft, CaretRight, X } from "@phosphor-icons/react";
import AuthImage from "./AuthImage";

/**
 * Full-screen image viewer with left/right navigation and "Image X/Y" label.
 *
 * Props:
 *   open          - boolean
 *   images        - string[]  storage paths (or full URLs for legacy)
 *   startIndex    - number    initial index to display
 *   onClose       - () => void
 */
export default function ImageViewerDialog({ open, images = [], startIndex = 0, onClose }) {
  const [idx, setIdx] = useState(startIndex);

  useEffect(() => {
    if (open) setIdx(Math.min(Math.max(0, startIndex), Math.max(0, images.length - 1)));
  }, [open, startIndex, images.length]);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "ArrowLeft") setIdx((i) => Math.max(0, i - 1));
      else if (e.key === "ArrowRight") setIdx((i) => Math.min(images.length - 1, i + 1));
      else if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, images.length, onClose]);

  if (!images || images.length === 0) return null;
  const total = images.length;
  const isFirst = idx === 0;
  const isLast = idx === total - 1;
  const prev = () => !isFirst && setIdx((i) => i - 1);
  const next = () => !isLast && setIdx((i) => i + 1);

  return (
    <Dialog open={!!open} onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent
        className="max-w-5xl rounded-sm p-0 overflow-hidden bg-slate-900 border-slate-800"
        data-testid="image-viewer-dialog"
      >
        <DialogTitle className="sr-only">Image Viewer</DialogTitle>
        <div className="relative w-full h-[80vh] flex items-center justify-center">
          {/* Close */}
          <button
            onClick={onClose}
            className="absolute top-3 right-3 z-10 p-2 rounded-sm bg-black/40 hover:bg-black/70 text-white"
            data-testid="image-viewer-close"
            title="Close (Esc)"
          >
            <X size={18} weight="bold" />
          </button>

          {/* Left arrow */}
          {!isFirst && (
            <button
              onClick={prev}
              className="absolute left-3 top-1/2 -translate-y-1/2 z-10 p-3 rounded-sm bg-black/40 hover:bg-black/70 text-white"
              data-testid="image-viewer-prev"
              title="Previous (←)"
            >
              <CaretLeft size={28} weight="bold" />
            </button>
          )}

          {/* Right arrow */}
          {!isLast && (
            <button
              onClick={next}
              className="absolute right-3 top-1/2 -translate-y-1/2 z-10 p-3 rounded-sm bg-black/40 hover:bg-black/70 text-white"
              data-testid="image-viewer-next"
              title="Next (→)"
            >
              <CaretRight size={28} weight="bold" />
            </button>
          )}

          {/* Image */}
          <AuthImage
            key={`${images[idx]}-${idx}`}
            path={images[idx]}
            alt={`Image ${idx + 1}`}
            className="max-w-full max-h-full object-contain"
            testid={`image-viewer-img-${idx}`}
          />

          {/* Bottom label "Image X/Y" */}
          <div
            className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1 rounded-sm bg-black/60 text-white text-xs font-mono tracking-wider"
            data-testid="image-viewer-label"
          >
            Image {idx + 1}/{total}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
