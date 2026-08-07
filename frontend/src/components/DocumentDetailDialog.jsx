import React, { useEffect, useState } from "react";
import { PencilSimple, Eye, ArrowsClockwise, Printer, CircleNotch } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import PartNoLink from "./PartNoLink";
import { useAuth } from "../lib/auth";
import { useStockInNav } from "../lib/stockInNav";
import { toast } from "sonner";
import { buildStandardPrintHtml, openPrintWindow, formatLocationText } from "../lib/printDocument";
import { varianceLabel, varianceClass, varianceTitle } from "../lib/noteQtys";

const fmtDate = (iso) => {
  if (!iso) return "—";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* Current existing stock locations (godown/rack/box + qty) for every unique
   (part_no, make) on a document — fetched live so the Racking Note preview/print
   shows where material already sits, not the destination being assigned in the
   racking note currently being viewed (that destination only becomes real
   inventory once Record Stock In is clicked). */
async function fetchExistingLocationsForItems(items) {
  const uniqueItems = [...new Map((items || []).map((it) => [`${it.part_no}||${it.make}`, it])).values()];
  const pairs = await Promise.all(uniqueItems.map(async (it) => {
    try {
      const { data } = await api.get(`/racking-notes/lookup/${encodeURIComponent(it.part_no)}/locations`, { params: { make: it.make } });
      return [`${it.part_no}||${it.make}`, data.locations || []];
    } catch {
      return [`${it.part_no}||${it.make}`, []];
    }
  }));
  return Object.fromEntries(pairs);
}

/* Standalone print window for a Racking Note preview — styled to match
   the Receipt Note print typography (shared template). */
async function printRackingNote(d) {
  if (!d) return;
  const existingLocs = await fetchExistingLocationsForItems(d.items);
  const rackedQty = (d.items || []).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0);
  const statusLabel = d.status === "RECORDED" ? "Complete" : "In Process";

  const rows = [];
  let sl = 0;
  (d.items || []).forEach((it) => {
    const locs = existingLocs[`${it.part_no}||${it.make}`] || [];
    if (locs.length === 0) {
      sl += 1;
      rows.push([
        String(sl), `<strong>${escapeHtml(it.part_no || "")}</strong>`, escapeHtml(it.make || ""),
        escapeHtml(it.description_1 || "—"),
        `<span style="font-style:italic;color:#94a3b8">No existing stock at any location</span>`, "—", "—",
        `<span style="text-align:right;display:block">—</span>`,
        `<span style="text-align:right;display:block">${escapeHtml(it.quantity ?? "—")}</span>`,
      ]);
    } else {
      locs.forEach((loc, li) => {
        sl += 1;
        rows.push([
          String(sl),
          li === 0 ? `<strong>${escapeHtml(it.part_no || "")}</strong>` : "",
          li === 0 ? escapeHtml(it.make || "") : "",
          li === 0 ? escapeHtml(it.description_1 || "—") : "",
          escapeHtml(loc.godown_name || "—"), escapeHtml(loc.rack_no || "—"), escapeHtml(loc.box_no || "—"),
          `<span style="text-align:right;display:block">${escapeHtml(loc.current_qty ?? "—")}</span>`,
          `<span style="text-align:right;display:block">${li === 0 ? escapeHtml(it.quantity ?? "—") : ""}</span>`,
        ]);
      });
    }
  });

  const html = buildStandardPrintHtml({
    docTitle: "Racking Note",
    docNo: d.rkn_no,
    statusLabel,
    fieldsLeft: [
      ["Racking Note No", d.rkn_no],
      ["Racking Note Date", fmtDate(d.rkn_date)],
      ["Related Receipt Note", `${d.receipt_note_no || "—"} (${fmtDate(d.receipt_note_date)})`],
      ["Status", statusLabel],
    ],
    fieldsRight: [
      ["Total Qty Being Racked (This Note)", rackedQty || "—"],
      ["Created By", d.created_by || "—"],
      ["Created At", d.created_at ? new Date(d.created_at).toLocaleString() : "—"],
    ],
    columns: [
      { label: "Sr" }, { label: "Part No" }, { label: "Make" }, { label: "Description" },
      { label: "Existing Godown" }, { label: "Existing Rack" }, { label: "Existing Box" },
      { label: "Existing Qty", align: "right" }, { label: "Qty This Note", align: "right" },
    ],
    rows,
    printedBy: d.created_by,
    sectionTitle: "Current Existing Stock Locations",
  });
  if (!openPrintWindow(html)) toast.error("Popup blocked — allow popups for this site to print");
}

/**
 * <DocumentDetailDialog>
 * Fetches a Racking Note / Picking Note / Transfer Note by id+kind and renders its details.
 * `kind` ∈ "racking" | "picking" | "transfer"
 */
export default function DocumentDetailDialog({ kind, id, no, onClose, related, onNavigate }) {
  const open = !!(kind && id);
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!open) { setDoc(null); setErr(""); return; }
    setLoading(true);
    setErr("");
    const url = kind === "racking" ? `/racking-notes/${id}`
      : kind === "picking" ? `/picking-notes/${id}`
      : `/transfer-notes/${id}`;
    api.get(url)
      .then(({ data }) => setDoc(data))
      .catch((e) => setErr(e?.response?.data?.detail || "Could not load document"))
      .finally(() => setLoading(false));
  }, [open, kind, id, reloadTick]);

  const title = no || (kind === "racking" ? "Racking Note" : kind === "picking" ? "Picking Note" : "Transfer Note");

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-7xl max-h-[92vh] overflow-y-auto rounded-sm" data-testid="doc-detail-dialog">
        {kind === "racking" ? (
          <div className="text-center text-xl font-black tracking-widest uppercase pt-1 pb-2 border-b border-slate-200">
            RACKING NOTE
          </div>
        ) : (
          <DialogHeader>
            <DialogTitle className="text-2xl font-black font-mono">{title}</DialogTitle>
            <DialogDescription className="sr-only">Full document details</DialogDescription>
          </DialogHeader>
        )}
        {loading && <div className="text-sm text-slate-500 py-6">Loading…</div>}
        {err && <div className="text-sm text-red-700 py-6">{err}</div>}
        {doc && kind === "racking" && <RackingBody d={doc} />}
        {doc && kind === "picking" && <PickingBody d={doc} />}
        {doc && kind === "transfer" && <TransferBody d={doc} />}
        {doc && kind === "racking" && (
          <div className="flex items-center gap-2 pt-4 border-t border-slate-200 mt-2">
            <Button variant="outline" size="sm" className="rounded-sm" onClick={() => setReloadTick((t) => t + 1)} disabled={loading}>
              {loading
                ? <CircleNotch size={14} weight="bold" className="mr-1.5 animate-spin" />
                : <ArrowsClockwise size={14} weight="bold" className="mr-1.5" />}
              Refresh
            </Button>
            <Button variant="outline" size="sm" className="rounded-sm" onClick={() => printRackingNote(doc)}>
              <Printer size={14} weight="bold" className="mr-1.5" /> Print
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function isRnEditable(rn, me, isAdmin) {
  if (!rn) return false;
  const isDraft = rn.status === "DRAFT";
  // Locked only once stock has genuinely moved — has_racking_note reflects a
  // RECORDED racking note, not merely a DRAFT allocation (see assert_rn_mutable).
  const hasRacking = rn.has_racking_note === true;
  const isAssignedToOther = !isDraft && !!rn.assigned_to_user_id && rn.assigned_to_user_id !== me?.id && !isAdmin;
  return !(hasRacking || isAssignedToOther);
}
export function isChildEditable(doc) { // SRN / ERN
  // Locked only once stock has actually been racked from this note. A COMPLETE
  // SRN or a decided ERN stays correctable until then — same "mutable until stock
  // moves" rule the Receipt Note uses.
  return !doc?.has_recorded_racking;
}
export function isRknEditable(rkn, me, isAdmin) {
  if (!rkn) return false;
  const recorded = rkn.status === "RECORDED";
  const assigneeId = rkn.parent_assigned_to_user_id;
  const isLockedToOther = !!assigneeId && assigneeId !== me?.id && !isAdmin;
  return !(recorded || isLockedToOther);
}

/**
 * Row of clickable buttons linking to the RN and its sibling SRN/ERN/RKN docs,
 * so any of the four previews can jump directly to any other. Clicking a doc
 * that's still editable opens its EDIT form (switching to that document's
 * tab); a locked/finalized doc falls back to the read-only preview.
 * `related` = { rn, srns, erns, rkns } — already fetched by the RN detail dialog.
 * `excludeType`/`excludeId` hide the button for the document currently open.
 */
export function LinkedDocsBar({ related, onNavigate, excludeType, excludeId }) {
  const { rn, srns = [], erns = [], rkns = [] } = related || {};
  const nav = useStockInNav();
  const { user: me, isAdmin } = useAuth();

  const isEditable = (type, doc) => {
    if (type === "rn") return isRnEditable(doc, me, isAdmin);
    if (type === "rkn") return isRknEditable(doc, me, isAdmin);
    return isChildEditable(doc);
  };

  const go = (type, doc) => {
    if (isEditable(type, doc) && nav?.requestEdit) nav.requestEdit(type, doc);
    else onNavigate?.(type, doc);
  };

  const chip = (label, no, doc, type, key) => {
    const editable = isEditable(type, doc);
    return (
      <button
        key={key}
        onClick={() => go(type, doc)}
        title={editable ? `Edit ${label} ${no}` : `View ${label} ${no} (read-only)`}
        className={`inline-flex items-center gap-1 font-mono text-[11px] font-bold rounded-sm px-2 py-0.5 border ${
          editable
            ? "text-blue-700 hover:underline bg-blue-50 border-blue-100"
            : "text-slate-500 bg-slate-50 border-slate-200"
        }`}
      >
        {editable ? <PencilSimple size={10} weight="bold" /> : <Eye size={10} weight="bold" />}
        {label}: {no}
      </button>
    );
  };

  const items = [];
  if (rn && excludeType !== "rn") {
    items.push(chip("RN", rn.rn_no, rn, "rn", "rn"));
  }
  srns.forEach((s) => {
    if (excludeType === "srn" && s.id === excludeId) return;
    items.push(chip("SRN", s.srn_no, s, "srn", `srn-${s.id}`));
  });
  erns.forEach((e) => {
    if (excludeType === "ern" && e.id === excludeId) return;
    items.push(chip("ERN", e.ern_no, e, "ern", `ern-${e.id}`));
  });
  rkns.forEach((r) => {
    if (excludeType === "rkn" && r.id === excludeId) return;
    items.push(chip("RKN", r.rkn_no, r, "rkn", `rkn-${r.id}`));
  });
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 py-2 border-b border-slate-200 mb-3">
      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mr-1">Linked Docs:</span>
      {items}
    </div>
  );
}

function Detail({ k, v }) {
  return (
    <div>
      <div className="label-sm">{k}</div>
      <div className="font-mono mt-1 text-slate-900">{v}</div>
    </div>
  );
}

function LocCell({ g, r, b }) {
  return <span>{formatLocationText({ godown_name: g, rack_no: r, box_no: b })}</span>;
}

function RackingBody({ d }) {
  const rackedQty = (d.items || []).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0);
  const complete = d.status === "RECORDED";
  const [existingLocs, setExistingLocs] = useState({});
  const [loadingLocs, setLoadingLocs] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingLocs(true);
    fetchExistingLocationsForItems(d.items).then((map) => {
      if (!cancelled) setExistingLocs(map);
    }).finally(() => { if (!cancelled) setLoadingLocs(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.id]);

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 text-sm border-b border-slate-200 pb-4 mb-4">
        <Detail k="Racking Note No" v={d.rkn_no || "—"} />
        <Detail k="Racking Note Date" v={fmtDate(d.rkn_date)} />
        <Detail k="Related Receipt Note" v={`${d.receipt_note_no || "—"} (${fmtDate(d.receipt_note_date)})`} />
        <Detail k="Total Qty Being Racked (This Note)" v={rackedQty || "—"} />
        <Detail k="Status" v={
          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${complete ? "bg-green-100 text-green-800" : "bg-blue-50 text-blue-800"}`}>
            {complete ? "Complete" : "In Process"}
          </span>
        } />
        <Detail k="Created By" v={d.created_by || "—"} />
        <Detail k="Created At" v={d.created_at ? new Date(d.created_at).toLocaleString() : "—"} />
      </div>
      <div className="label-sm mb-2">
        Current Existing Stock Locations
        {loadingLocs && <span className="ml-2 text-slate-400 font-normal normal-case">Loading…</span>}
      </div>
      <div className="text-xs text-slate-500 mb-2">
        Where this material currently exists in the warehouse — not the destination being assigned in this
        racking note. Inventory only reflects the new destination once Record Stock In is completed.
      </div>
      <div className="overflow-x-auto">
        <table className="data-table w-full text-xs">
          <thead>
            <tr>
              <th>SL</th><th>PART NO</th><th>MAKE</th><th>DESCRIPTION</th>
              <th>EXISTING GODOWN</th><th>EXISTING RACK</th><th>EXISTING BOX</th>
              <th className="text-center">EXISTING QTY</th>
              <th className="text-center">QTY THIS NOTE</th>
            </tr>
          </thead>
          <tbody>
            {(d.items || []).flatMap((it, idx) => {
              const locs = existingLocs[`${it.part_no}||${it.make}`] || [];
              if (locs.length === 0) {
                return [(
                  <tr key={`${idx}-none`}>
                    <td className="font-mono text-slate-500">{idx + 1}</td>
                    <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                    <td>{it.make}</td>
                    <td className="text-slate-700 max-w-[220px] truncate">{it.description_1 || "—"}</td>
                    <td colSpan={3} className="text-slate-400 italic">No existing stock at any location</td>
                    <td className="text-center font-mono">—</td>
                    <td className="text-center font-mono font-bold">{it.quantity}</td>
                  </tr>
                )];
              }
              return locs.map((loc, li) => (
                <tr key={`${idx}-${li}`}>
                  <td className="font-mono text-slate-500">{idx + 1}{locs.length > 1 ? `.${li + 1}` : ""}</td>
                  <td>{li === 0 ? <PartNoLink partNo={it.part_no} make={it.make} /> : ""}</td>
                  <td>{li === 0 ? it.make : ""}</td>
                  <td className="text-slate-700 max-w-[220px] truncate">{li === 0 ? (it.description_1 || "—") : ""}</td>
                  <td className="font-mono">{loc.godown_name || "—"}</td>
                  <td className="font-mono">{loc.rack_no || "—"}</td>
                  <td className="font-mono">{loc.box_no || "—"}</td>
                  <td className="text-center font-mono font-bold">{loc.current_qty}</td>
                  <td className="text-center font-mono font-bold">{li === 0 ? it.quantity : ""}</td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PickingBody({ d }) {
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 text-sm border-b border-slate-200 pb-4 mb-4">
        <Detail k="Picking Date" v={fmtDate(d.pn_date)} />
        <Detail k="Issue Note No" v={d.issue_note_no || "—"} />
        <Detail k="Issue Note Date" v={fmtDate(d.issue_note_date)} />
        <Detail k="Assigned To" v={d.parent_assigned_to_name || "—"} />
        <Detail k="Status" v={d.status} />
        <Detail k="Created By" v={d.created_by || "—"} />
      </div>
      {/* The note's five quantities, taken straight from the server's own roll-up
          (`_enrich_picking_requested_items`) rather than recomputed here — this dialog is
          reached from the transaction ledger and must report exactly what the Stock Out
          screens report. Pending = Issued − Picked − Rejected; Extra = Picked − Issued. */}
      <div className="grid grid-cols-3 lg:grid-cols-5 gap-4 text-sm border-b border-slate-200 pb-4 mb-4">
        <Detail k="Issued Qty" v={d.issued_qty_total ?? "—"} />
        <Detail k="Available Qty" v={d.available_qty_total ?? "—"} />
        <Detail k="Picked Qty" v={d.picked_qty_total ?? 0} />
        <Detail k="Pending / Extra" v={
          <span className={varianceClass(d.pending_qty_total, d.extra_qty_total)}
            title={varianceTitle(d.issued_qty_total, d.picked_qty_total, d.rejected_qty_total, d.pending_qty_total, d.extra_qty_total)}>
            {varianceLabel(d.pending_qty_total ?? 0, d.extra_qty_total ?? 0)}
          </span>
        } />
        <Detail k="Rejected Qty" v={d.rejected_qty_total ?? 0} />
      </div>
      <div className="overflow-x-auto">
        <table className="data-table w-full text-xs">
          <thead><tr><th>SL</th><th>PART NO</th><th>MAKE</th><th>DESCRIPTION</th><th>LOCATION</th><th className="text-center">PICKED QTY</th><th className="text-center">REJECTED QTY</th></tr></thead>
          <tbody>
            {(d.items || []).map((it, idx) => (
              <tr key={idx}>
                <td className="font-mono text-slate-500">{idx + 1}</td>
                <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                <td>{it.make}</td>
                <td className="text-slate-700 max-w-[260px] truncate">{it.description_1 || "—"}</td>
                <td><LocCell g={it.godown_name} r={it.rack_no} b={it.box_no} /></td>
                <td className="text-center font-mono font-bold">{it.quantity}</td>
                {/* Rejected moves no stock, so it has no location and never appears in the
                    transaction ledger — the note is the only place it is visible. */}
                <td className={`text-center font-mono font-bold ${(it.rejected_qty || 0) > 0 ? "text-red-700" : "text-slate-400"}`}>
                  {it.rejected_qty || 0}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function TransferBody({ d }) {
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 text-sm border-b border-slate-200 pb-4 mb-4">
        <Detail k="STN Date" v={fmtDate(d.stn_date)} />
        <Detail k="Request No" v={d.transfer_request_no || "—"} />
        <Detail k="Request Date" v={fmtDate(d.transfer_request_date)} />
        <Detail k="Status" v={d.status} />
        <Detail k="Created By" v={d.created_by || "—"} />
        <Detail k="Created At" v={new Date(d.created_at).toLocaleString()} />
      </div>
      <div className="overflow-x-auto">
        <table className="data-table w-full text-xs">
          <thead>
            <tr>
              <th>SL</th><th>PART NO</th><th>MAKE</th><th className="text-center">QTY</th>
              <th>SOURCE</th><th>DESTINATION</th>
            </tr>
          </thead>
          <tbody>
            {(d.items || []).map((it, idx) => (
              <tr key={idx}>
                <td className="font-mono text-slate-500">{idx + 1}</td>
                <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                <td>{it.make}</td>
                <td className="text-center font-mono font-bold">{it.quantity}</td>
                <td><LocCell g={it.src_godown_name} r={it.src_rack_no} b={it.src_box_no} /></td>
                <td><LocCell g={it.dest_godown_name} r={it.dest_rack_no} b={it.dest_box_no} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
