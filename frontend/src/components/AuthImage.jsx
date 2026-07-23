import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Image as ImgIcon } from "@phosphor-icons/react";

/**
 * Renders an image stored in object storage by fetching `/api/files/{path}`
 * with the user's Bearer token, then displaying the resulting blob URL.
 *
 * Falls back to direct `src` if `path` already looks like a data URL or http URL
 * (covers any pre-existing images for backwards compatibility).
 */
export default function AuthImage({ path, alt = "", className = "", onClick, testid }) {
  const [src, setSrc] = useState(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let blobUrl = null;
    setErrored(false);
    setSrc(null);
    if (!path) return undefined;
    // Direct URL (legacy base64 / http) — render as-is
    if (path.startsWith("data:") || path.startsWith("http://") || path.startsWith("https://")) {
      setSrc(path);
      return undefined;
    }
    (async () => {
      try {
        const res = await api.get(`/files/${path}`, { responseType: "blob" });
        if (cancelled) return;
        blobUrl = URL.createObjectURL(res.data);
        setSrc(blobUrl);
      } catch {
        if (!cancelled) setErrored(true);
      }
    })();
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [path]);

  if (errored || !path) {
    return (
      <div className={`flex items-center justify-center bg-slate-50 border border-slate-200 rounded-sm text-slate-400 ${className}`} data-testid={testid}>
        <ImgIcon size={14} />
      </div>
    );
  }
  if (!src) {
    return <div className={`bg-slate-100 animate-pulse rounded-sm ${className}`} data-testid={testid} />;
  }
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onClick={onClick}
      data-testid={testid}
    />
  );
}
