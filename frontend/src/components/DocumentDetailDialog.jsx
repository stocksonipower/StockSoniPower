import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import PartNoLink from "./PartNoLink";

const fmtDate = (iso) => {
  if (!iso) return "—";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
};

/**
 * <DocumentDetailDialog>
 * Fetches a Racking Note / Picking Note / Transfer Note by id+kind and renders its details.
 * `kind` ∈ "racking" | "picking" | "transfer"
 */
export default function DocumentDetailDialog({ kind, id, no, onClose }) {
  const open = !!(kind && id);
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

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
  }, [open, kind, id]);

  const title = no || (kind === "racking" ? "Racking Note" : kind === "picking" ? "Picking Note" : "Transfer Note");

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-7xl rounded-sm" data-testid="doc-detail-dialog">
        <DialogHeader>
          <DialogTitle className="text-2xl font-black font-mono">{title}</DialogTitle>
          <DialogDescription className="sr-only">Full document details</DialogDescription>
        </DialogHeader>
        {loading && <div className="text-sm text-slate-500 py-6">Loading…</div>}
        {err && <div className="text-sm text-red-700 py-6">{err}</div>}
        {doc && kind === "racking" && <RackingBody d={doc} />}
        {doc && kind === "picking" && <PickingBody d={doc} />}
        {doc && kind === "transfer" && <TransferBody d={doc} />}
      </DialogContent>
    </Dialog>
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
  return (
    <span className="font-mono">
      {g || "—"}{r ? <> / <b>{r}</b></> : null}{b ? <> / {b}</> : null}
    </span>
  );
}

function RackingBody({ d }) {
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 text-sm border-b border-slate-200 pb-4 mb-4">
        <Detail k="Racking Date" v={fmtDate(d.rkn_date)} />
        <Detail k="Receipt Note No" v={d.receipt_note_no || "—"} />
        <Detail k="Receipt Note Date" v={fmtDate(d.receipt_note_date)} />
        <Detail k="Status" v={d.status} />
        <Detail k="Created By" v={d.created_by || "—"} />
        <Detail k="Created At" v={new Date(d.created_at).toLocaleString()} />
      </div>
      <div className="overflow-x-auto">
        <table className="data-table w-full text-xs">
          <thead><tr><th>SL</th><th>PART NO</th><th>MAKE</th><th>DESCRIPTION</th><th>LOCATION</th><th className="text-center">QTY</th></tr></thead>
          <tbody>
            {(d.items || []).map((it, idx) => (
              <tr key={idx}>
                <td className="font-mono text-slate-500">{idx + 1}</td>
                <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                <td>{it.make}</td>
                <td className="text-slate-700 max-w-[260px] truncate">{it.description_1 || "—"}</td>
                <td><LocCell g={it.godown_name} r={it.rack_no} b={it.box_no} /></td>
                <td className="text-center font-mono font-bold">{it.quantity}</td>
              </tr>
            ))}
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
        <Detail k="Issued To" v={d.issued_to || "—"} />
        <Detail k="Status" v={d.status} />
        <Detail k="Created By" v={d.created_by || "—"} />
      </div>
      <div className="overflow-x-auto">
        <table className="data-table w-full text-xs">
          <thead><tr><th>SL</th><th>PART NO</th><th>MAKE</th><th>DESCRIPTION</th><th>LOCATION</th><th className="text-center">QTY</th></tr></thead>
          <tbody>
            {(d.items || []).map((it, idx) => (
              <tr key={idx}>
                <td className="font-mono text-slate-500">{idx + 1}</td>
                <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                <td>{it.make}</td>
                <td className="text-slate-700 max-w-[260px] truncate">{it.description_1 || "—"}</td>
                <td><LocCell g={it.godown_name} r={it.rack_no} b={it.box_no} /></td>
                <td className="text-center font-mono font-bold">{it.quantity}</td>
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
