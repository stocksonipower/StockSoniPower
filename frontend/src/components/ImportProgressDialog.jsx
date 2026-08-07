import React from "react";
import { Dialog, DialogContent } from "./ui/dialog";
import { ArrowsClockwise } from "@phosphor-icons/react";

/**
 * Blocking progress overlay shown while an import is running — one component for
 * every import in the app (Stock Master bulk import, Receipt Note Excel import,
 * Issue Note Excel import), so they all look and behave the same.
 *
 * It is deliberately BLOCKING. Every import here leaves the target in a
 * half-written state while it runs: the spreadsheet imports keep resolving rows
 * against Stock Master after the grid is on screen, so editing a row mid-flight
 * gets silently overwritten by its own lookup; and the bulk import writes rows
 * server-side as it goes, so navigating away abandons a partial write.
 *
 * Progress has two honest shapes and the component picks between them:
 *   - `total` unknown (0/undefined) → an indeterminate sliding bar. Used while a
 *     file is still being parsed, and for the server-side bulk import, which
 *     returns only when the whole file is done and so can report no percentage.
 *   - `total` known → a real determinate bar and an "N of M" count.
 * Inventing a percentage for the first case would be worse than showing none.
 */
export default function ImportProgressDialog({
  open,
  title = "Importing…",
  fileName,
  done = 0,
  total = 0,
  detail,
  note,
  testid = "import-progress-dialog",
}) {
  if (!open) return null;
  const determinate = total > 0;
  const pct = determinate ? Math.min(100, (done / Math.max(1, total)) * 100) : 0;

  return (
    <Dialog open={true}>
      <DialogContent className="max-w-md rounded-sm" data-testid={testid}>
        <div className="text-lg font-black tracking-tight text-slate-900">{title}</div>
        <div className="py-4 space-y-4">
          <div className="flex items-center gap-3 text-slate-600 text-sm">
            <ArrowsClockwise size={18} weight="bold" className="animate-spin text-blue-600 shrink-0" />
            <span>
              {detail || (determinate ? (
                <>
                  <span className="font-mono font-semibold text-slate-900">{done}</span>
                  {" of "}
                  <span className="font-mono font-semibold text-slate-900">{total}</span>
                  {fileName ? <> from <span className="font-semibold text-slate-800">{fileName}</span></> : null}
                </>
              ) : (
                <>Reading {fileName ? <span className="font-semibold text-slate-800">{fileName}</span> : "the file"}…</>
              ))}
            </span>
          </div>
          <div className="w-full h-2 bg-slate-100 rounded-sm overflow-hidden">
            {determinate ? (
              <div className="h-full bg-blue-600 transition-all" style={{ width: `${pct}%` }} />
            ) : (
              <div className="h-full w-1/3 bg-blue-600 animate-[loading-slide_1.2s_ease-in-out_infinite]" />
            )}
          </div>
          {note && <p className="text-[11px] text-slate-500 leading-snug">{note}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
