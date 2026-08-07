import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { api, formatApiError } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "../components/ui/select";
import {
  Dialog, DialogContent,
} from "../components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import {
  Plus, Trash, ArrowLeft, FloppyDisk, FileText, CaretLeft, CaretRight,
  Pencil, CheckCircle, Package, Printer,
  DownloadSimple, UploadSimple, ArrowsClockwise, MagnifyingGlass,
} from "@phosphor-icons/react";
import { useAuth } from "../lib/auth";
import AssigneeSelect, { AssigneeBadge } from "../components/AssigneeSelect";
import ExcelColumnFilter from "../components/ExcelColumnFilter";
import useExcelTableFilter from "../components/useExcelTableFilter";
import PartNoLink from "../components/PartNoLink";
import { exportToExcel } from "../lib/exportExcel";
import { buildStandardPrintHtml, openPrintWindow } from "../lib/printDocument";

const PAGE_SIZE = 100;
const NO_GODOWN = "__NO_GODOWN__";
// Stock can legitimately sit in a godown with no rack and/or no box (racking is not
// mandatory everywhere). Radix rejects an empty SelectItem value, so those levels get a
// sentinel key. `rack_sel`/`box_sel` on a row hold the chosen key, which is what tells
// "(no rack) was chosen" apart from "nothing chosen yet" — both have rack_id === "".
const NO_RACK = "__NO_RACK__";
const NO_BOX = "__NO_BOX__";

function locSelKeys(row) {
  if (!row.godown_id) return { rack_sel: "", box_sel: "" };
  return { rack_sel: row.rack_id || NO_RACK, box_sel: row.box_id || NO_BOX };
}

function fmtDate(iso) {
  if (!iso) return "—";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}

// `pn_date`/`in_date` are calendar dates only (no time component is ever stored on
// them — see backend `today.date().isoformat()`), so the clock time a Picking Note was
// actually raised has to come from `created_at`, which does carry a full timestamp.
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pickingKey(it) {
  return `${it.part_no || ""}||${it.make || ""}`;
}

// A blank Quantity on an Issue Note line is deliberate ("open"): the office user often
// cannot know how many pieces a godown package holds, so the store incharge fills the
// number in on the Picking Note. Open lines are never checked against stock up front.
function isOpenQty(it) {
  return String(it?.quantity ?? "").trim() === "";
}

// Issue Note uses the standard 3-status set (Pending / In Process / Complete);
// legacy values are recognized defensively in case a cached row predates migration.
function issueStatusLabel(status) {
  if (status === "COMPLETE" || status === "COMPLETED" || status === "FULLY_PICKED") return "Complete";
  if (status === "IN_PROCESS" || status === "PICKING_IN_PROGRESS" || status === "PARTIALLY_PICKED" || status === "PICKED") return "In Process";
  return "Pending";
}

function issueStatusClass(status) {
  const label = issueStatusLabel(status);
  if (label === "Complete") return "bg-green-100 text-green-800";
  if (label === "In Process") return "bg-blue-50 text-blue-800";
  return "bg-amber-50 text-amber-700";
}

// Locked (edit/delete) the moment picking has actually started — mirrors the backend
// rule exactly, since status only leaves Pending once a Picking Note is COMPLETED.
function issueHasProcessed(status) {
  return issueStatusLabel(status) !== "Pending";
}

// Picking Note is a secondary/operational document and keeps its own working states
// rather than the 3-status set — RECORDING is a transient lock state, folded into
// "Draft" for display.
function pickingNoteStatusLabel(status) {
  if (status === "COMPLETED" || status === "RECORDED") return "Completed";
  if (status === "CLOSED") return "Closed";
  if (status === "PENDING") return "Pending";
  return "Draft";
}

// Closed reads as a dead end rather than a success — it is the one terminal state where
// a requested quantity went away without any stock moving.
function pickingNoteStatusClass(status) {
  const label = pickingNoteStatusLabel(status);
  if (label === "Completed") return "bg-green-100 text-green-800";
  if (label === "Closed") return "bg-slate-200 text-slate-700";
  if (label === "Pending") return "bg-blue-50 text-blue-800";
  return "bg-amber-50 text-amber-700";
}

// Row identity for matching saved picking rows back to freshly-prepared ones: the Issue
// Note LINE plus the full location. Line first, because the same part/make can appear on
// several lines (15 for one purpose, 5 for another) at the very same location — keying on
// part/make/location alone would merge them into one row and lose a line.
function pickingLocKey(it) {
  return `${it.line_no ?? ""}||${it.part_no || ""}||${it.make || ""}||${it.godown_id || ""}||${it.rack_id || ""}||${it.box_id || ""}`;
}

// Location-only key (no part/make) — `available_locations` entries are already
// scoped to one item's part/make, so this is enough to match a row's current
// selection against one of its own choices.
function locOnlyKey(L) {
  return `${L?.godown_id || ""}||${L?.rack_id || ""}||${L?.box_id || ""}`;
}

// Null-safe: the detail dialog stays mounted with a null note until a row is opened, so
// every totals helper below it runs at least once against nothing.
function pickingAssignedItems(pn) {
  return (pn?.assigned_items || []).length ? (pn?.assigned_items || []) : (pn?.requested_items || []);
}

// Where stock was ACTUALLY picked from, per part/make, out of the completed Picking
// Notes. The Issue Note only ever held a suggested allocation; once the store incharge
// resolves the real godown/rack/box, that supersedes the suggestion everywhere the
// Issue Note is shown or printed.
// Total Picked and Rejected per part/make across the Issue Note's whole Picking Note
// chain — the root note plus every continuation. Derived live rather than snapshotted,
// so a corrected pick shows up on the Issue Note, its print and its export at once.
//
// CLOSED notes are skipped, matching `_enrich_issue_note_totals` on the server: closing
// is the decision that a quantity will never be picked, and whatever draft numbers such
// a note carried were never recorded. Its write-off shows in the Issue Note's STATUS,
// not in these quantities.
function issueQtysByKey(pickingHistory = []) {
  const picked = {}, rejected = {};
  (pickingHistory || []).forEach((pn) => {
    if (pickingNoteIsClosed(pn)) return;
    (pn.items || []).forEach((it) => {
      const k = pickingKey(it);
      picked[k] = (picked[k] || 0) + (parseFloat(it.quantity) || 0);
      rejected[k] = (rejected[k] || 0) + (parseFloat(it.rejected_qty) || 0);
    });
  });
  return { picked, rejected };
}

// The Issue Note's own five totals, aggregated over its Picking Notes. Mirrors
// `_enrich_issue_note_totals` on the server (and `_picking_totals` under it): Pending and
// Extra are floored per part/make before being summed, so a surplus on one item can never
// mask a shortfall on another.
function issueTotals(inn, pickingHistory = []) {
  const { picked, rejected } = issueQtysByKey(pickingHistory);
  const { issued, openKeys } = issuedByKey(inn?.items);
  return rollUp(issued, openKeys, picked, rejected);
}

// Part/make keys whose outstanding quantity was written off by a CLOSED Picking Note.
// The shortfall is real and still shown — this only marks that nobody is chasing it any
// more, which is the difference between "short, follow-up pending" and "short, closed".
function issueWrittenOffKeys(pickingHistory = []) {
  const s = new Set();
  (pickingHistory || []).forEach((pn) => {
    if (!pickingNoteIsClosed(pn)) return;
    pickingAssignedItems(pn).forEach((it) => s.add(pickingKey(it)));
  });
  return s;
}

function issueActualLocations(pickingHistory = []) {
  const m = {};
  (pickingHistory || []).forEach((pn) => {
    if (!(pn.status === "COMPLETED" || pn.status === "RECORDED")) return;
    (pn.items || []).forEach((it) => {
      const qty = parseFloat(it.quantity) || 0;
      if (qty <= 0) return;
      const k = pickingKey(it);
      (m[k] = m[k] || []).push({
        godown_name: it.godown_name || "", rack_no: it.rack_no || "",
        box_no: it.box_no || "", quantity: qty,
      });
    });
  });
  return m;
}

// ---------------------------------------------------------------------------
// The five Stock Out quantities. Only two of them are ever entered — Picked and
// Rejected — and the other three follow from them by arithmetic that is identical
// everywhere: the form, the lists, the detail dialogs, the prints and the backend
// (`_picking_totals` in routes/stock_out.py).
//
//     Pending = max(0, Issued − Picked − Rejected)      never negative, never typed
//     Extra   = max(0, Picked − Issued)                 never negative, never typed
//
// Reject is legal only while Extra is 0: once more came off the shelf than was asked
// for, there is nothing outstanding left to refuse.
// ---------------------------------------------------------------------------
function stockOutQtys(issued, picked, rejected) {
  const p = parseFloat(picked) || 0;
  const r = parseFloat(rejected) || 0;
  // An OPEN line (the office left the quantity to the store incharge) has no target to
  // measure against, so Pending is unknown rather than 0 and nothing is ever Extra.
  if (issued == null || issued === "") return { issued: null, picked: p, rejected: r, pending: null, extra: 0 };
  const i = parseFloat(issued) || 0;
  return { issued: i, picked: p, rejected: r, pending: Math.max(0, i - p - r), extra: Math.max(0, p - i) };
}

// Note-level totals, mirroring the backend exactly: Pending and Extra are floored per
// (part, make) and only then summed, so a surplus on one item can never mask a shortfall
// on another.
function pickingTotals(pn) {
  const { issued, openKeys } = issuedByKey(pickingAssignedItems(pn));
  const picked = {}, rejected = {};
  (pn?.items || []).forEach((it) => {
    const k = pickingKey(it);
    picked[k] = (picked[k] || 0) + (parseFloat(it.quantity) || 0);
    rejected[k] = (rejected[k] || 0) + (parseFloat(it.rejected_qty) || 0);
  });
  return rollUp(issued, openKeys, picked, rejected);
}

// Issued per part/make, keeping OPEN lines (blank quantity) apart from lines that really
// were issued 0 — an open line has no target, so it can be neither short nor exceeded.
function issuedByKey(lines) {
  const issued = {};
  const openKeys = new Set();
  (lines || []).forEach((it) => {
    const k = pickingKey(it);
    if (!(k in issued)) issued[k] = 0;
    if (it.quantity == null) openKeys.add(k);
    else issued[k] += parseFloat(it.quantity) || 0;
  });
  return { issued, openKeys };
}

// Sum the five totals, flooring Pending and Extra per part/make first. Open lines are
// skipped: there is no number they could be measured against.
function rollUp(issued, openKeys, picked, rejected) {
  let pending = 0, extra = 0;
  new Set([...Object.keys(issued), ...Object.keys(picked), ...Object.keys(rejected)]).forEach((k) => {
    if (openKeys.has(k)) return;
    const q = stockOutQtys(issued[k] || 0, picked[k] || 0, rejected[k] || 0);
    pending += q.pending;
    extra += q.extra;
  });
  const sum = (m) => Object.values(m).reduce((s, v) => s + v, 0);
  return { issued: sum(issued), picked: sum(picked), rejected: sum(rejected), pending, extra };
}

// Issued qty for a picking row, from the Issue Note assignment carried on the Picking
// Note. Resolved per LINE so two lines of the same part/make keep their own numbers;
// rows saved before line numbers existed fall back to the part/make total. `null` = the
// office left the quantity open, which every view renders as blank rather than 0.
function pickingRequestedLookup(pn) {
  const byLine = {};
  const byKey = {};
  // Notes saved before line numbers existed get them by position — the same fallback
  // `prepare_picking_note` applies, so both sides agree on which line is which.
  pickingAssignedItems(pn).forEach((it, i) => {
    const line = it.line_no ?? (i + 1);
    const k = pickingKey(it);
    if (it.quantity == null) {
      byLine[line] = null;
      if (!(k in byKey)) byKey[k] = null;
      return;
    }
    const q = parseFloat(it.quantity) || 0;
    byLine[line] = (byLine[line] || 0) + q;
    byKey[k] = (byKey[k] || 0) + q;
  });
  return (row) => (row?.line_no != null && row.line_no in byLine ? byLine[row.line_no] : byKey[pickingKey(row)]);
}

// Single-value accessors for the list columns. Everywhere that needs more than one
// number calls `pickingTotals` once instead, so Pending and Extra have no accessors of
// their own — the views that show them (edit form, detail, print) take the whole set.
function pickingIssuedQty(pn)   { return pickingTotals(pn).issued; }
function pickingPickedQty(pn)   { return pickingTotals(pn).picked; }
function pickingRejectedQty(pn) { return pickingTotals(pn).rejected; }

// Pending and Extra collapsed into one signed number: they are the two directions of a
// single variance and can never both be non-zero on the same note, so one column carries
// both — negative for what's still outstanding (Pending), positive for what went over
// (Extra). Used wherever the list/summary views show them side by side.
function varianceValue(pending, extra) {
  if (extra > 0) return extra;
  if (pending > 0) return -pending;
  return 0;
}

function pickingNoteIsClosed(pn) {
  return (pn?.status || "").toUpperCase() === "CLOSED";
}

// Live Available Qty for the note, supplied by the server (`_enrich_picking_requested_items`).
// Picking Note only — the Issue Note is an office document and never shows availability.
function pickingAvailableQty(pn) {
  return pn?.available_qty_total ?? null;
}

// One normalized row per line of the note, whichever stage it is at. A note with no
// picking rows yet is shown through its ASSIGNED items — and on those rows `quantity` is
// the issued quantity, not a pick, so picked/rejected are pinned to 0. Without that, a
// freshly raised note would print "Picked 10" before anybody had touched a shelf.
function pickingDisplayItems(pn) {
  if ((pn?.items || []).length) {
    return (pn?.items || []).map((it) => ({
      ...it,
      picked_qty: parseFloat(it.quantity) || 0,
      rejected_qty: parseFloat(it.rejected_qty) || 0,
      row_status: pn.status === "COMPLETED" || pn.status === "RECORDED" ? "Picked" : "Draft Pick",
    }));
  }
  return pickingAssignedItems(pn).map((it) => ({
    ...it,
    picked_qty: 0,
    rejected_qty: 0,
    row_status: pn?.status === "PENDING" ? "Pending" : "Assigned",
  }));
}

function pickingDisplayCount(pn) {
  return pickingDisplayItems(pn).length || pn.requested_items_count || (pn.requested_items || []).length || 0;
}

// Live Available Qty per part/make, as served alongside the note. Keyed the same way the
// rows are, so a print never has to go back to the API for it.
function pickingAvailableLookup(pn) {
  const byKey = {};
  (pn?.available_by_item || []).forEach((a) => { byKey[pickingKey(a)] = a.available_qty; });
  return (row) => byKey[pickingKey(row)];
}

// Picking Note print columns: Sr, Part No, Item, Godown, Rack, Box, Issued Qty,
// Available Qty, Picked Qty, Pending Qty, Rejected Qty, Extra Qty, Picker.
// Every number here is produced by `stockOutQtys`, the same function the screen uses —
// the printed sheet and the application can never disagree.
function printPickingNote(pn) {
  const issuedFor = pickingRequestedLookup(pn);
  const availableFor = pickingAvailableLookup(pn);
  const rows = pickingDisplayItems(pn).map((it, idx) => {
    const q = stockOutQtys(issuedFor(it), it.picked_qty, it.rejected_qty);
    const avail = availableFor(it);
    const num = (v) => `<span style="text-align:right;display:block">${htmlEscape(v)}</span>`;
    return [
      String(idx + 1),
      htmlEscape(it.part_no),
      htmlEscape(it.description_1 || it.make || ""),
      htmlEscape(it.godown_name || "—"),
      htmlEscape(it.rack_no || "—"),
      htmlEscape(it.box_no || "—"),
      num(q.issued == null ? "Open" : q.issued),
      num(avail == null ? "—" : avail),
      num(q.picked),
      num(q.pending == null ? "—" : q.pending),
      num(q.rejected),
      num(q.extra),
      htmlEscape(pn.created_by || "—"),
    ];
  });
  const html = buildStandardPrintHtml({
    docTitle: "Picking Note",
    docNo: pn.pn_no,
    statusLabel: pickingNoteStatusLabel(pn.status),
    fieldsLeft: [
      ["Picking No", pn.pn_no],
      ["Picking Date", fmtDate(pn.pn_date)],
      ["Picking Time", fmtTime(pn.created_at)],
      ["Issue Note No", pn.issue_note_no || "—"],
      ["Issue Note Date", fmtDate(pn.issue_note_date)],
      ["Status", pickingNoteStatusLabel(pn.status)],
    ],
    // Quantities live only in the table below, not duplicated up here — one place to
    // read them, and no risk of the header block and the table ever showing different
    // numbers for the same note.
    fieldsRight: [
      ["Assigned To", pn.parent_assigned_to_name || pn.parent_assigned_to_email || "—"],
      ["Picker", pn.created_by || "—"],
    ],
    columns: [
      { label: "Sr" }, { label: "Part No" }, { label: "Item" },
      { label: "Godown" }, { label: "Rack" }, { label: "Box" },
      { label: "Issued Qty", align: "right" }, { label: "Available Qty", align: "right" },
      { label: "Picked Qty", align: "right" }, { label: "Pending Qty", align: "right" },
      { label: "Rejected Qty", align: "right" }, { label: "Extra Qty", align: "right" },
      { label: "Picker" },
    ],
    rows,
    narration: pn.narration || "",
    printedBy: pn.created_by,
  });
  if (!openPrintWindow(html)) toast.error("Popup blocked — allow popups for this site to print");
}

// Issue Note print columns: Sr, Part Number, Item Name, Make, Godown, Rack, Box,
// Issued Qty, Picked Qty, Pending Qty, Rejected Qty, Extra Qty. No Available column —
// availability is the store's live concern and belongs to the Picking Note alone.
function printIssueNote(inn, pickingHistory = []) {
  // Picked and Rejected are derived live from the Picking Notes, so a corrected pick is
  // reflected here the next time the note is printed — nothing is snapshotted.
  const { picked: pickedByKey, rejected: rejectedByKey } = issueQtysByKey(pickingHistory);
  const writtenOffKeys = issueWrittenOffKeys(pickingHistory);
  const actualLocs = issueActualLocations(pickingHistory);
  const rows = [];
  (inn.items || []).forEach((it, idx) => {
    const k = pickingKey(it);
    const q = stockOutQtys(it.quantity, pickedByKey[k], rejectedByKey[k]);
    // Actual pick locations win over the planned allocation once picking has happened.
    // Kept apart from the fallback so the Picked column knows which case it's in — a
    // planned/suggested location has no real pick yet and must never print one.
    const actual = actualLocs[k];
    const isActual = !!(actual && actual.length);
    const locs = isActual ? actual : (it.allocated_locations || []);
    // A pending quantity nobody is chasing any more reads differently from one that is
    // still on somebody's list, so a closed follow-up is called out rather than hidden.
    const pendingCell = q.pending == null ? "—"
      : `${q.pending}${q.pending > 0 && writtenOffKeys.has(k) ? " (closed)" : ""}`;
    const num = (v) => `<span style="text-align:right;display:block">${htmlEscape(v)}</span>`;
    // `rowPicked` is per-row: each row is one actual pick at one location (possibly from
    // a different Picking Note than the row above it), so each carries its own quantity
    // instead of the line's aggregate — that aggregate is still what Issued/Pending/
    // Rejected/Extra describe, which is why only those stay gated by `showItem`.
    const base = (showItem, godownCell, rackCell, boxCell, rowPicked) => [
      String(idx + 1),
      showItem ? htmlEscape(it.part_no) : "",
      showItem ? htmlEscape(it.description_1 || "") : "",
      showItem ? htmlEscape(it.make || "—") : "",
      godownCell, rackCell, boxCell,
      showItem ? num(q.issued == null ? "Open" : q.issued) : "",
      num(isActual ? (rowPicked ?? "—") : (showItem ? q.picked : "")),
      showItem ? num(pendingCell) : "",
      showItem ? num(q.rejected) : "",
      showItem ? num(q.extra) : "",
    ];
    if (locs.length === 0) {
      rows.push(base(true, "—", "—", "—"));
    } else {
      locs.forEach((loc, li) => {
        rows.push(base(li === 0, htmlEscape(loc.godown_name || "—"), htmlEscape(loc.rack_no || "—"), htmlEscape(loc.box_no || "—"), loc.quantity));
      });
    }
  });
  const html = buildStandardPrintHtml({
    docTitle: "Issue Note",
    docNo: inn.in_no,
    statusLabel: issueStatusLabel(inn.status),
    // Same two field blocks, in the same order, as the on-screen preview dialog — the
    // printed sheet and the dialog are the same document and must read identically.
    fieldsLeft: [
      ["Stock Out Type", inn.stock_out_type || "—"],
      ["Issue Note Date", fmtDate(inn.in_date)],
      ["Issue Note No", inn.in_no],
      ["Reference Document Name", inn.reference_doc_name || "—"],
      ["Reference Document Date", inn.reference_doc_date ? fmtDate(inn.reference_doc_date) : "—"],
      ["Reference Document No", inn.reference_doc_no || "—"],
      ["Status", issueStatusLabel(inn.status)],
    ],
    // Quantities live only in the table below, not duplicated up here — one place to
    // read them, and no risk of the header block and the table ever showing different
    // numbers for the same note.
    fieldsRight: [
      ["Status", issueStatusLabel(inn.status)],
      ["Created By", inn.created_by || "—"],
      ["Created At", inn.created_at ? new Date(inn.created_at).toLocaleString() : "—"],
      ["Assigned To", inn.assigned_to_name || inn.assigned_to_email || "—"],
    ],
    columns: [
      { label: "Sr" }, { label: "Part Number" }, { label: "Item Name" }, { label: "Make" },
      { label: "Godown" }, { label: "Rack" }, { label: "Box" },
      { label: "Issued Qty", align: "right" }, { label: "Picked Qty", align: "right" },
      { label: "Pending Qty", align: "right" }, { label: "Rejected Qty", align: "right" },
      { label: "Extra Qty", align: "right" },
    ],
    rows,
    narration: inn.narration || "",
    printedBy: inn.created_by,
  });
  if (!openPrintWindow(html)) toast.error("Popup blocked — allow popups for this site to print");
}

function buildPickingEditItems(editing, preparedItems) {
  const preparedByLocKey = {};
  const preparedByLine = {};
  const preparedByItemKey = {};
  const availableByItemKey = {};
  const availableTotalByItemKey = {};
  const openByItemKey = {};
  (preparedItems || []).forEach((p) => {
    preparedByLocKey[pickingLocKey(p)] = p;
    const k = pickingKey(p);
    if (p.line_no != null && !(p.line_no in preparedByLine)) preparedByLine[p.line_no] = p;
    if (!(k in preparedByItemKey)) preparedByItemKey[k] = p;
    if (!(k in availableTotalByItemKey)) availableTotalByItemKey[k] = p.available_qty ?? 0;
    if (!availableByItemKey[k]) availableByItemKey[k] = p.available_locations || [];
    if (p.open_quantity) openByItemKey[k] = true;
  });
  const existing = editing?.items || [];
  if (existing.length) {
    return existing.map((it) => {
      const k = pickingKey(it);
      // Match the freshly-prepared row by location first, then by Issue Note line, then
      // by part/make. A saved row picked from a different shelf than the current
      // suggestion still has to pick up the CURRENT requested quantity — otherwise an
      // Issue Note edit (e.g. an open line filled in as 8) would never show up here.
      const p = preparedByLocKey[pickingLocKey(it)]
        || (it.line_no != null ? preparedByLine[it.line_no] : null)
        || preparedByItemKey[k]
        || {};
      const open = !!openByItemKey[k];
      return {
      ...it,
      ...locSelKeys(it),
      row_status: editing?.status === "RECORDED" ? "Picked" : "Draft Pick",
      open_quantity: open,
      pending_qty: open ? null : (p.pending_qty ?? it.pending_qty ?? 0),
      requested_qty: open ? null : (p.requested_qty ?? it.requested_qty ?? 0),
      // Rejected Qty is the picker's own second input and belongs to the saved row, not
      // to the freshly-prepared suggestion — an edit must reopen with what was entered.
      rejected_qty: it.rejected_qty ?? 0,
      // Availability is always the CURRENT number, never what it was when the draft was
      // saved: the whole point of the field is that the shelf moves underneath the note.
      available_qty: p.available_qty ?? availableTotalByItemKey[k] ?? 0,
      allocated_qty: p.allocated_qty ?? it.allocated_qty ?? it.quantity ?? 0,
      suggested: p.suggested ?? it.suggested ?? false,
      available_locations: availableByItemKey[k] || it.available_locations || [],
      };
    });
  }
  return (preparedItems || []).map((it) => ({ ...it, ...locSelKeys(it), rejected_qty: 0, row_status: "Assigned" }));
}

/* ==============================================================
   STOCK OUT  (Issue Note + Picking Note)
   ============================================================== */
export default function StockOutPage() {
  const [tab, setTab] = useState("issue-note");
  return (
    <div className="p-8 max-w-[1600px] mx-auto" data-testid="stock-out-page">
      <div className="mb-6">
        <h1 className="text-4xl font-black tracking-tight text-slate-900">Stock Out</h1>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="rounded-sm">
          <TabsTrigger value="issue-note" className="rounded-sm" data-testid="tab-issue-note">
            <FileText size={14} weight="bold" className="mr-2" /> Issue Note
          </TabsTrigger>
          <TabsTrigger value="picking-note" className="rounded-sm" data-testid="tab-picking-note">
            <Package size={14} weight="bold" className="mr-2" /> Picking Note
          </TabsTrigger>
        </TabsList>
        <TabsContent value="issue-note"><IssueNoteTab /></TabsContent>
        <TabsContent value="picking-note"><PickingNoteTab /></TabsContent>
      </Tabs>
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

/* =========================== ISSUE NOTE TAB =========================== */
function IssueNoteTab() {
  const [view, setView] = useState("list");
  const [editing, setEditing] = useState(null);
  const [openIn, setOpenIn] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const goCreate = () => { setEditing(null); setView("create"); };
  const goEdit = (i) => { setEditing(i); setView("edit"); };
  const goList = () => { setEditing(null); setView("list"); setReloadKey((k) => k + 1); };

  return (
    <>
      {view === "list" && <IssueNoteList reloadKey={reloadKey} onCreate={goCreate} onEdit={goEdit} onOpen={setOpenIn} />}
      {(view === "create" || view === "edit") && <IssueNoteForm editing={editing} onCancel={goList} onSaved={goList} />}
      <IssueNoteDetailDialog inn={openIn} onClose={() => setOpenIn(null)} />
    </>
  );
}

function IssueNoteList({ reloadKey, onCreate, onEdit, onOpen }) {
  const { user: me, isAdmin } = useAuth();
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/issue-notes", { params: { page, page_size: PAGE_SIZE, search: search || undefined } });
      setRows(res.data);
      const t = parseInt(res.headers["x-total-count"], 10);
      setTotal(isNaN(t) ? res.data.length : t);
    } finally { setLoading(false); }
  }, [page, search]);
  useEffect(() => { load(); }, [load, reloadKey, search]);
  // Ctrl+F focusses the search input
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleDelete = async (inn) => {
    if (!window.confirm(`Delete ${inn.in_no}?`)) return;
    try {
      await api.delete(`/issue-notes/${inn.id}`);
      toast.success(`${inn.in_no} deleted`);
      load();
    } catch (err) { toast.error(formatApiError(err.response?.data?.detail) || "Could not delete"); }
  };

  const statusLabel = (r) => issueStatusLabel(r.status);

  const columns = useMemo(() => [
    { key: "stock_out_type", label: "STOCK OUT TYPE", value: (r) => r.stock_out_type || "" },
    { key: "in_date", label: "ISSUE NOTE DATE", value: (r) => fmtDate(r.in_date) },
    { key: "in_no", label: "ISSUE NOTE NO", value: (r) => r.in_no || "" },
    { key: "reference_doc_name", label: "REFERENCE DOCUMENT NAME", value: (r) => r.reference_doc_name || "" },
    { key: "reference_doc_date", label: "REFERENCE DOCUMENT DATE", value: (r) => (r.reference_doc_date ? fmtDate(r.reference_doc_date) : "") },
    { key: "reference_doc_no", label: "REFERENCE DOCUMENT NO", value: (r) => r.reference_doc_no || "" },
    // The note's quantities, aggregated server-side over every Picking Note raised
    // against it (`_enrich_issue_note_totals`). Read from the response rather than
    // recomputed here, so the list, the detail dialog and the print sheet agree by
    // construction — the list has no Picking Note history loaded to derive them from.
    // Pending and Extra are combined into one signed column (see `varianceValue`).
    { key: "issued_qty", label: "ISSUED", value: (r) => r.issued_qty_total ?? 0, isQty: true, isNumeric: true },
    { key: "picked_qty", label: "PICKED", value: (r) => r.picked_qty_total ?? 0, isQty: true, isNumeric: true },
    { key: "rejected_qty", label: "REJECTED", value: (r) => r.rejected_qty_total ?? 0, isQty: true, isNumeric: true },
    { key: "variance_qty", label: "PENDING / EXTRA", value: (r) => varianceValue(r.pending_qty_total ?? 0, r.extra_qty_total ?? 0), isQty: true, isNumeric: true },
    { key: "status", label: "STATUS", value: statusLabel },
  ], []);
  const {
    filteredRows, uniqueValues, colFilters, setColFilter, sort, setColumnSort,
  } = useExcelTableFilter(rows, columns);

  const handleExport = () => {
    if (filteredRows.length === 0) { toast.error("No rows to export"); return; }
    const exportCols = [
      { label: "Sl No", value: (r) => filteredRows.indexOf(r) + 1 },
      ...columns,
    ];
    exportToExcel(filteredRows, exportCols, `Issue_Notes_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="mt-4" data-testid="in-list-view">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input
            ref={searchInputRef}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search issue notes…"
            className="rounded-sm font-mono h-9 pl-10 w-full"
            data-testid="in-search-input"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleExport} variant="outline" className="rounded-sm border-slate-300" data-testid="in-export-button">
            <DownloadSimple size={14} weight="bold" className="mr-2" /> Export
          </Button>
          <Button onClick={load} variant="outline" className="rounded-sm border-slate-300" disabled={loading} data-testid="in-refresh-button">
            <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button onClick={onCreate} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="create-in-button">
            <Plus size={16} weight="bold" className="mr-2" /> Create New Issue Note
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-between mb-3 text-xs text-slate-600">
  <div>
    {total === 0 ? "No issue notes" : (
      <>
        Showing <span className="font-semibold text-slate-900">{filteredRows.length}</span>
        {" - "}<span className="font-semibold text-slate-900">{total}</span> total
      </>
    )}
  </div>
  <div className="flex items-center gap-2">
    <Button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading} variant="outline" size="sm" className="rounded-sm h-7">
      <CaretLeft size={12} weight="bold" className="mr-1" /> Prev
    </Button>
    <span className="font-mono">Page {page} of {totalPages}</span>
    <Button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages || loading} variant="outline" size="sm" className="rounded-sm h-7">
      Next <CaretRight size={12} weight="bold" className="ml-1" />
    </Button>
    <span className="text-slate-400 ml-2">{PAGE_SIZE.toLocaleString()} / page</span>
  </div>
</div>
      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto overflow-visible">
        {/* `w-full` alone lets this auto-layout table get squeezed to the container's
            width once enough columns are added — the browser shrinks whichever column
            has the least content to give room to the others, and a date's hyphens are a
            break point, so "07-08-2026" wraps onto two lines. `min-w` gives the table a
            floor at its natural content width instead, so it grows past the container
            and the wrapper's `overflow-x-auto` scrolls it rather than the browser
            crushing a column to fit. */}
        <table className="data-table w-full min-w-[1680px]">
          <thead>
            <tr>
              <th className="w-16 whitespace-nowrap">SL NO</th>
              {columns.map((c) => (
                <th key={c.key} className={c.isQty ? "text-center" : ""}>
                  <ExcelColumnFilter
                    label={c.label}
                    values={uniqueValues[c.key] || []}
                    selected={colFilters[c.key]}
                    onChange={(s) => setColFilter(c.key, s)}
                    sortDir={sort?.key === c.key ? sort.dir : null}
                    onSort={(dir) => setColumnSort(c.key, dir)}
                    isQty={c.isQty}
                    isNumeric={c.isNumeric}
                  />
                </th>
              ))}
              <th className="!text-left">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r, idx) => {
              // Editable only until the first quantity is actually picked — matches the
              // backend rule (a picking note with processed qty flips status off Pending).
              const hasPicking = issueHasProcessed(r.status);
              const lockedToOther = !!r.assigned_to_user_id && r.assigned_to_user_id !== me?.id && !isAdmin;
              const lock = hasPicking || lockedToOther;
              const editTitle = hasPicking ? "Cannot edit — picking has already started"
                : (lockedToOther ? `Locked — assigned to ${r.assigned_to_name || r.assigned_to_email}` : "Edit");
              const deleteTitle = hasPicking ? "Cannot delete — picking has already started"
                : (lockedToOther ? `Locked — assigned to ${r.assigned_to_name || r.assigned_to_email}` : "Delete");
              const label = statusLabel(r);
              const cls = issueStatusClass(r.status);
              return (
                <tr key={r.id} data-testid={`in-row-${r.in_no}`}>
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td className="text-slate-700" data-testid={`in-type-${r.in_no}`}>{r.stock_out_type || "—"}</td>
                  <td className="font-mono text-slate-700 whitespace-nowrap">{fmtDate(r.in_date)}</td>
                  <td>
                    <button onClick={() => onOpen(r)} className="font-mono font-semibold text-blue-700 hover:underline" data-testid={`in-open-${r.in_no}`}>
                      {r.in_no}
                    </button>
                  </td>
                  <td className="text-slate-700 max-w-[220px] truncate" title={r.reference_doc_name || ""}>{r.reference_doc_name || "—"}</td>
                  <td className="font-mono text-slate-700 whitespace-nowrap">{r.reference_doc_date ? fmtDate(r.reference_doc_date) : "—"}</td>
                  <td className="font-mono text-slate-700">{r.reference_doc_no || "—"}</td>
                  <td className="text-center font-mono font-bold text-slate-900 tabular-nums">{r.issued_qty_total || "—"}</td>
                  <td className="text-center font-mono font-bold text-slate-900 tabular-nums">{r.picked_qty_total ?? 0}</td>
                  <td className={`text-center font-mono font-bold tabular-nums ${(r.rejected_qty_total ?? 0) > 0 ? "text-red-700" : "text-slate-400"}`}>{r.rejected_qty_total ?? 0}</td>
                  {/* Pending / Extra as one signed number — negative (amber) for what's
                      still outstanding, positive (emerald) for what went over. */}
                  <td className={`text-center font-mono font-bold tabular-nums ${
                    (r.extra_qty_total ?? 0) > 0 ? "text-emerald-700" : ((r.pending_qty_total ?? 0) > 0 ? "text-amber-700" : "text-slate-400")
                  }`}>
                    {(r.extra_qty_total ?? 0) > 0 ? `+${r.extra_qty_total}` : ((r.pending_qty_total ?? 0) > 0 ? `−${r.pending_qty_total}` : 0)}
                  </td>
                  <td>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${cls}`} data-testid={`in-status-${r.in_no}`}>{label}</span>
                  </td>
                  <td className="text-left whitespace-nowrap">
                    <button onClick={() => onEdit(r)} disabled={lock}
                      title={editTitle}
                      className={`p-1.5 rounded-sm mr-1 ${lock ? "text-slate-300 cursor-not-allowed" : "hover:bg-slate-100"}`}
                      data-testid={`in-edit-${r.in_no}`}>
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => handleDelete(r)} disabled={lock}
                      title={deleteTitle}
                      className={`p-1.5 rounded-sm ${lock ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                      data-testid={`in-delete-${r.in_no}`}>
                      <Trash size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && (
              <tr><td colSpan={columns.length + 2} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? "No issue notes. Click 'Create New Issue Note' to begin." : "No rows match the current filters.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function IssueNoteDetailDialog({ inn, onClose }) {
  const [history, setHistory] = useState([]);
  const actualLocs = useMemo(() => issueActualLocations(history), [history]);
  const { picked: pickedByKey, rejected: rejectedByKey } = useMemo(() => issueQtysByKey(history), [history]);
  const totals = useMemo(() => issueTotals(inn, history), [inn, history]);
  const writtenOffKeys = useMemo(() => issueWrittenOffKeys(history), [history]);

  useEffect(() => {
    if (!inn?.id) {
      setHistory([]);
      return;
    }
    api.get("/picking-notes", { params: { issue_note_id: inn.id, page_size: 100 } })
      .then((r) => setHistory(r.data || []))
      .catch(() => setHistory([]));
  }, [inn?.id]);

  return (
    <Dialog open={!!inn} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto rounded-sm" data-testid="in-detail-dialog">
        {inn && (
          <>
            <div className="text-center text-xl font-black tracking-widest uppercase pt-1 pb-2 border-b border-slate-200">
              ISSUE NOTE
            </div>
            <div className="grid grid-cols-2 gap-6 text-sm pt-3 pb-4 border-b border-slate-200">
              <div className="space-y-2">
                <Detail k="STOCK OUT TYPE" v={inn.stock_out_type || "—"} />
                <Detail k="ISSUE NOTE DATE" v={fmtDate(inn.in_date)} />
                <Detail k="ISSUE NOTE NO" v={inn.in_no} />
                <Detail k="REFERENCE DOCUMENT NAME" v={inn.reference_doc_name || "—"} />
                <Detail k="REFERENCE DOCUMENT DATE" v={inn.reference_doc_date ? fmtDate(inn.reference_doc_date) : "—"} />
                <Detail k="REFERENCE DOCUMENT NO" v={inn.reference_doc_no || "—"} />
                <Detail k="STATUS" v={
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${issueStatusClass(inn.status)}`}>
                    {issueStatusLabel(inn.status)}
                  </span>
                } />
              </div>
              <div className="space-y-2">
                <Detail k="STATUS" v={
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${issueStatusClass(inn.status)}`}>
                    {issueStatusLabel(inn.status)}
                  </span>
                } />
                <Detail k="CREATED BY" v={inn.created_by || "—"} />
                <Detail k="CREATED AT" v={inn.created_at ? new Date(inn.created_at).toLocaleString() : "—"} />
                <div>
                  <div className="label-sm">ASSIGNED TO</div>
                  <div className="mt-1"><AssigneeBadge name={inn.assigned_to_name} email={inn.assigned_to_email} /></div>
                </div>
              </div>
            </div>
            {inn.narration && (
              <div className="pt-3 pb-1 border-b border-slate-200">
                <div className="label-sm mb-1">NARRATION</div>
                <div className="text-sm text-slate-700 whitespace-pre-wrap">{inn.narration}</div>
              </div>
            )}
            {/* Note totals, aggregated across every Picking Note raised against this
                Issue Note. Same five numbers as the print sheet and as each line's
                columns below, from the same helper — they cannot drift apart. */}
            <div className="mt-3 grid grid-cols-5 gap-3 bg-slate-50 border border-slate-200 rounded-sm px-4 py-3">
              <Detail k="ISSUED QTY" v={<span className="font-bold">{totals.issued || "—"}</span>} />
              <Detail k="PICKED QTY" v={<span className="font-bold">{totals.picked}</span>} />
              <Detail k="PENDING QTY" v={<span className={`font-bold ${totals.pending > 0 ? "text-amber-700" : "text-slate-500"}`}>{totals.pending}</span>} />
              <Detail k="REJECTED QTY" v={<span className={`font-bold ${totals.rejected > 0 ? "text-red-700" : "text-slate-500"}`}>{totals.rejected}</span>} />
              <Detail k="EXTRA QTY" v={<span className={`font-bold ${totals.extra > 0 ? "text-emerald-700" : "text-slate-500"}`}>{totals.extra}</span>} />
            </div>
            <div className="mt-2">
              <div className="label-sm mb-2">Items ({(inn.items || []).length})</div>
              <div className="overflow-x-auto">
                <table className="data-table w-full">
                  <thead>
                    <tr>
                      <th className="w-14">SL NO</th><th className="w-28">MODEL</th><th>PART NO</th><th>DESCRIPTION 1</th><th>MAKE</th>
                      <th className="text-center">ISSUED QTY</th>
                      <th className="text-center">PICKED QTY</th>
                      <th className="text-center">PENDING QTY</th>
                      <th className="text-center">REJECTED QTY</th>
                      <th className="text-center">EXTRA QTY</th>
                      <th>GODOWN</th><th>RACK</th><th>BOX</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(inn.items || []).flatMap((it, idx) => {
                      // Same rule as the print: show where stock was actually picked
                      // from once picking is done, else the planned allocation. Kept
                      // apart from the fallback so the Picked column below knows which
                      // case it's in — a planned/suggested location has no real pick
                      // yet, so it must never be shown as if it did.
                      const k = pickingKey(it);
                      const actual = actualLocs[k];
                      const isActual = !!(actual && actual.length);
                      const locs = isActual ? actual : (it.allocated_locations || []);
                      // The four derived/aggregated quantities for this line, rolled up
                      // over the whole Picking Note chain. Pending whose follow-up note
                      // has been closed is flagged, so "still being chased" and "written
                      // off" never look the same.
                      const q = stockOutQtys(it.quantity, pickedByKey[k], rejectedByKey[k]);
                      const closedOut = writtenOffKeys.has(k);
                      // Pending/Rejected/Extra describe the LINE as a whole, not any one
                      // shelf, so they print once, on the line's first row.
                      const lineCells = (
                        <>
                          <td className={`text-center font-mono font-bold ${q.pending > 0 ? "text-amber-700" : "text-slate-400"}`}>
                            {q.pending == null ? "—" : (
                              <>
                                {q.pending}
                                {q.pending > 0 && closedOut && <span className="block text-[9px] font-bold tracking-wide text-slate-500">CLOSED</span>}
                              </>
                            )}
                          </td>
                          <td className={`text-center font-mono font-bold ${q.rejected > 0 ? "text-red-700" : "text-slate-400"}`}>
                            {q.rejected || "—"}
                          </td>
                          <td className={`text-center font-mono font-bold ${q.extra > 0 ? "text-emerald-700" : "text-slate-400"}`}>
                            {q.extra > 0 ? (
                              <>
                                {q.extra}
                                <span className="block text-[9px] font-bold tracking-wide">TAKEN</span>
                              </>
                            ) : "—"}
                          </td>
                        </>
                      );
                      // Issued Qty belongs to the LINE, not to any one shelf — it is
                      // printed once, on the line's first row, even when the quantity is
                      // spread over several locations (each of which carries its own
                      // quantity next to its box).
                      const issueQty = it.quantity == null
                        ? <span className="text-blue-700">Open</span>
                        : it.quantity;
                      if (locs.length === 0) {
                        return [(
                          <tr key={`${idx}-none`}>
                            <td className="font-mono text-slate-500">{idx + 1}</td>
                            <td className="text-slate-700">{it.model || "—"}</td>
                            <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                            <td className="text-slate-700">{it.description_1 || "—"}</td>
                            <td>{it.make}</td>
                            <td className="text-center font-mono font-bold">{issueQty}</td>
                            <td className="text-center font-mono font-bold text-slate-700">{q.picked || "—"}</td>
                            {lineCells}
                            <td colSpan={3} className="text-slate-400 italic">
                              {it.quantity == null ? "Quantity & location decided at picking" : "No stock currently available"}
                            </td>
                          </tr>
                        )];
                      }
                      return locs.map((loc, li) => (
                        <tr key={`${idx}-${li}`}>
                          <td className="font-mono text-slate-500">{idx + 1}{locs.length > 1 ? `.${li + 1}` : ""}</td>
                          <td className="text-slate-700">{li === 0 ? (it.model || "—") : ""}</td>
                          <td>{li === 0 ? <PartNoLink partNo={it.part_no} make={it.make} /> : ""}</td>
                          <td className="text-slate-700">{li === 0 ? (it.description_1 || "—") : ""}</td>
                          <td>{li === 0 ? it.make : ""}</td>
                          <td className="text-center font-mono font-bold">{li === 0 ? issueQty : ""}</td>
                          {/* Picked — shown on EVERY row, not just the first: each row is
                              one actual pick at one location (possibly from a different
                              Picking Note), so each carries its own quantity rather than
                              the line's aggregate. A planned/suggested location (nothing
                              picked yet) has no real number here — it prints "—", never a
                              fabricated one. */}
                          <td className="text-center font-mono font-bold text-slate-700">
                            {isActual ? (loc.quantity ?? "—") : "—"}
                          </td>
                          {/* Pending/Rejected/Extra belong to the line, so they print on
                              its first row only — the rows below are extra locations,
                              not extra lines. */}
                          {li === 0 ? lineCells : <><td /><td /><td /></>}
                          <td className="font-mono">{loc.godown_name || "—"}</td>
                          <td className="font-mono">{loc.rack_no || "—"}</td>
                          <td className="font-mono">{loc.box_no || "—"}</td>
                        </tr>
                      ));
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="mt-6 border-t border-slate-200 pt-4">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-700 mb-2 pb-1 border-b border-slate-200">Picking History Details</div>
              <table className="data-table w-full text-xs">
                <thead>
                  <tr>
                    <th>PARENT PN</th><th>PN NO</th>
                    <th className="text-center">ISSUED</th><th className="text-center">PICKED</th>
                    <th className="text-center">PENDING</th><th className="text-center">REJECTED</th>
                    <th className="text-center">EXTRA</th>
                    <th>STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  {[...history].sort((a, b) => (a.serial || 0) - (b.serial || 0)).map((pn) => {
                    const parent = history.find((h) => h.id === pn.parent_picking_note_id);
                    const t = pickingTotals(pn);
                    const closed = pickingNoteIsClosed(pn);
                    return (
                      <tr key={pn.id} className={closed ? "bg-slate-50" : ""}>
                        <td className="font-mono">{parent?.pn_no || "—"}</td>
                        <td className="font-mono font-semibold">{pn.pn_no}</td>
                        <td className="text-center font-mono font-bold">{t.issued || "—"}</td>
                        <td className="text-center font-mono font-bold">{t.picked}</td>
                        {/* Pending is what carries into the next Picking Note — except on
                            a closed note, where the ✕ marks that nobody is chasing it. */}
                        <td className={`text-center font-mono font-bold ${t.pending > 0 ? (closed ? "text-slate-500" : "text-amber-700") : "text-slate-400"}`}
                          title={closed && t.pending > 0 ? "Written off — this note was closed"
                            : (t.pending > 0 ? "Carries forward into the next Picking Note" : "Nothing outstanding on this note")}>
                          {t.pending}{closed && t.pending > 0 ? " ✕" : ""}
                        </td>
                        <td className={`text-center font-mono font-bold ${t.rejected > 0 ? "text-red-700" : "text-slate-400"}`}
                          title={t.rejected > 0 ? "Refused — no stock moved and no follow-up note is raised for it" : ""}>
                          {t.rejected}
                        </td>
                        <td className={`text-center font-mono font-bold ${t.extra > 0 ? "text-emerald-700" : "text-slate-400"}`}
                          title={t.extra > 0 ? "Extra taken over the issued quantity" : ""}>
                          {t.extra}
                        </td>
                        <td>
                          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${pickingNoteStatusClass(pn.status)}`}
                            title={closed ? (pn.close_reason || "Closed — this quantity will not be picked") : ""}>
                            {pickingNoteStatusLabel(pn.status)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {history.length === 0 && (
                    <tr><td colSpan={8} className="text-center py-6 text-slate-500">No picking notes yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-2 pt-4 border-t border-slate-200 mt-6">
              <Button variant="outline" size="sm" className="rounded-sm" onClick={() => printIssueNote(inn, history)} data-testid="in-detail-print">
                <Printer size={14} weight="bold" className="mr-1.5" /> Print
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const emptyIssueItem = () => ({
  part_no: "",
  make: "",
  quantity: "",
  description_1: "",
  model: "",
  selected_godown_id: null,
  selected_godown_name: null,
  godowns: [],
  makes: [],
  partLooked: false,
  available_qty: 0,
});

function IssueNoteForm({ editing, onCancel, onSaved }) {
  const isEdit = !!editing;
  const isDraftEdit = isEdit && editing.status === "DRAFT";
  const isFinalEdit = isEdit && !isDraftEdit;
  const [inNo, setInNo] = useState("");
  const [inDate, setInDate] = useState("");
  const [stockOutType, setStockOutType] = useState("");
  const [stockOutTypes, setStockOutTypes] = useState([]);
  const [newTypeOpen, setNewTypeOpen] = useState(false);
  const [newTypeName, setNewTypeName] = useState("");
  const [creatingType, setCreatingType] = useState(false);
  const [refDocName, setRefDocName] = useState("");
  const [refDocDate, setRefDocDate] = useState("");
  const [refDocNo, setRefDocNo] = useState("");
  const [items, setItems] = useState([emptyIssueItem()]);
  const [narration, setNarration] = useState("");
  const [addCount, setAddCount] = useState("");
  const [savingDraft, setSavingDraft] = useState(false);
  const [savingFinal, setSavingFinal] = useState(false);
  const [assignedToUserId, setAssignedToUserId] = useState("");
  const fileInputRef = useRef(null);

  const loadStockOutTypes = useCallback(async () => {
    try {
      const { data } = await api.get("/stock-out-types");
      setStockOutTypes(data || []);
    } catch { /* dropdown just stays empty */ }
  }, []);
  useEffect(() => { loadStockOutTypes(); }, [loadStockOutTypes]);

  const createStockOutType = async () => {
    const name = newTypeName.trim();
    if (!name) { toast.error("Enter a type name"); return; }
    setCreatingType(true);
    try {
      const { data } = await api.post("/stock-out-types", { name });
      await loadStockOutTypes();
      setStockOutType(data.name);
      setNewTypeName("");
      setNewTypeOpen(false);
      toast.success(`Stock Out Type '${data.name}' created`);
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not create type");
    } finally { setCreatingType(false); }
  };

  useEffect(() => {
    if (isEdit) {
      setInNo(editing.in_no || "");
      setInDate(editing.in_date || "");
      setStockOutType(editing.stock_out_type || "");
      setRefDocName(editing.reference_doc_name || "");
      setRefDocDate(editing.reference_doc_date || "");
      setRefDocNo(editing.reference_doc_no || "");
      setAssignedToUserId(editing.assigned_to_user_id || "");
      setNarration(editing.narration || "");
      const initial = (editing.items || []).map((it) => ({
        part_no: it.part_no || "", make: it.make || "", quantity: it.quantity ?? "",
        description_1: it.description_1 || "",
        model: it.model || "",
        selected_godown_id: it.selected_godown_id || null,
        selected_godown_name: it.selected_godown_name || null,
        godowns: it.selected_godown_id ? [{
          godown_id: it.selected_godown_id,
          godown_name: it.selected_godown_name || "",
          available_qty: 0,
        }] : [],
        makes: it.make ? [{ make: it.make, available_qty: 0 }] : [], partLooked: !!it.part_no, available_qty: 0,
      }));
      setItems(initial.length ? initial : [emptyIssueItem()]);
      // Refresh stock-aware makes list per row
      initial.forEach((row, idx) => {
        if (!row.part_no) return;
        api.get(`/issue-notes/lookup/${encodeURIComponent(row.part_no)}`)
          .then(({ data }) => {
            const makesArr = data.makes || [];
            const found = makesArr.find((m) => m.make === row.make);
            setItems((prev) => prev.map((r, i) => i === idx ? {
              ...r, makes: makesArr, available_qty: found?.available_qty || 0,
              description_1: r.description_1 || found?.description_1 || "",
              model: r.model || found?.model || "",
            } : r));
            if (row.make) loadIssueGodowns(idx, row.part_no, row.make, row.selected_godown_id);
          })
          .catch(() => {});
      });
    } else {
      api.get("/issue-notes/next-no").then((r) => { setInNo(r.data.next_in_no); setInDate(r.data.in_date); })
        .catch(() => toast.error("Could not preview issue-note number"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, editing]);

  // Same semantics as Receipt Note's Add Row: the count box means "I want N rows in
  // total from here", so one row already on screen counts toward N.
  const addItems = () => {
    let n = Math.max(1, Math.min(500, parseInt(addCount, 10) || 1));
    if (addCount && parseInt(addCount, 10) > 0) {
      n = Math.max(1, n - 1);
    }
    setItems((p) => [...p, ...Array.from({ length: n }, emptyIssueItem)]);
    setAddCount("");
  };
  const insertItemAfter = (i) => setItems((p) => {
    const next = [...p];
    next.splice(i + 1, 0, emptyIssueItem());
    return next;
  });
  const removeItem = (i) => setItems((p) => (p.length === 1 ? p : p.filter((_, idx) => idx !== i)));
  const updateItem = (i, patch) => setItems((p) => p.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  const loadIssueGodowns = async (i, partNo, makeVal, keepGodownId = null) => {
    const p = (partNo || "").trim();
    const m = (makeVal || "").trim();
    if (!p || !m) {
      updateItem(i, { godowns: [], selected_godown_id: null, selected_godown_name: null });
      return;
    }
    try {
      const { data } = await api.get(`/issue-notes/lookup/${encodeURIComponent(p)}/godowns`, { params: { make: m } });
      const list = data.godowns || [];
      const kept = keepGodownId ? list.find((g) => g.godown_id === keepGodownId) : null;
      const auto = kept || (list.length === 1 ? list[0] : null);
      updateItem(i, {
        godowns: list,
        selected_godown_id: auto ? auto.godown_id : null,
        selected_godown_name: auto ? auto.godown_name : null,
      });
    } catch {
      updateItem(i, { godowns: [], selected_godown_id: null, selected_godown_name: null });
    }
  };

  const lookupMakes = async (i, partNo) => {
    const v = (partNo || "").trim();
    if (!v) { updateItem(i, { makes: [], make: "", description_1: "", model: "", partLooked: false, available_qty: 0, godowns: [], selected_godown_id: null, selected_godown_name: null }); return; }
    try {
      const { data } = await api.get(`/issue-notes/lookup/${encodeURIComponent(v)}`);
      const list = data.makes || [];
      const auto = list.length === 1 ? list[0] : null;
      updateItem(i, {
        makes: list, partLooked: true,
        make: auto ? auto.make : "",
        available_qty: auto ? auto.available_qty : 0,
        description_1: auto ? (auto.description_1 || "") : "",
        model: auto ? (auto.model || "") : "",
        godowns: [],
        selected_godown_id: null,
        selected_godown_name: null,
      });
      if (auto) loadIssueGodowns(i, v, auto.make);
    } catch { updateItem(i, { makes: [], partLooked: true, make: "", description_1: "", model: "", available_qty: 0 }); }
  };

  const onMakeChange = (i, makeVal) => {
    const row = items[i];
    const found = (row.makes || []).find((m) => m.make === makeVal);
    updateItem(i, {
      make: makeVal, available_qty: found?.available_qty || 0,
      description_1: found?.description_1 || "",
      model: found?.model || "",
      godowns: [], selected_godown_id: null, selected_godown_name: null,
    });
    loadIssueGodowns(i, row.part_no, makeVal);
  };

  const onIssueGodownChange = (i, gid) => {
    if (gid === NO_GODOWN) {
      updateItem(i, { selected_godown_id: null, selected_godown_name: null });
      return;
    }
    const row = items[i];
    const found = (row.godowns || []).find((g) => g.godown_id === gid);
    // Narrowing to a godown can shrink the pool below what's already typed — pull the
    // quantity down with it rather than leaving an unsavable number on screen.
    const cap = found?.available_qty ?? 0;
    const typed = parseInt(row.quantity);
    updateItem(i, {
      selected_godown_id: found?.godown_id || null,
      selected_godown_name: found?.godown_name || null,
      ...(found && !isNaN(typed) && typed > cap ? { quantity: String(cap) } : {}),
    });
  };

  // Sum requested qty per (part_no, make) across all rows so multiple rows of the same part/make
  // are validated together (mirrors backend aggregation).
  const requestedByKey = useMemo(() => {
    const m = {};
    items.forEach((r) => {
      if (!r.part_no || !r.make || isOpenQty(r)) return;
      const k = `${r.part_no}||${r.make}`;
      m[k] = (m[k] || 0) + (parseInt(r.quantity) || 0);
    });
    return m;
  }, [items]);

  const requestedByGodownKey = useMemo(() => {
    const m = {};
    items.forEach((r) => {
      if (!r.part_no || !r.make || !r.selected_godown_id || isOpenQty(r)) return;
      const k = `${r.part_no}||${r.make}||${r.selected_godown_id}`;
      m[k] = (m[k] || 0) + (parseInt(r.quantity) || 0);
    });
    return m;
  }, [items]);

  // Hard ceiling for a row's Quantity: live stock for that part/make — narrowed to the
  // selected godown when one is chosen — minus whatever the other rows already claim
  // from the same pool. Mirrors the backend's aggregate check, applied as you type so
  // an impossible number can never be entered in the first place.
  const maxQtyForRow = (idx) => {
    const row = items[idx];
    if (!row?.part_no || !row?.make) return 0;
    const selected = (row.godowns || []).find((g) => g.godown_id === row.selected_godown_id);
    const pool = row.selected_godown_id && selected ? (selected.available_qty || 0) : (row.available_qty || 0);
    const claimedByOthers = items.reduce((sum, r, i) => {
      if (i === idx || r.part_no !== row.part_no || r.make !== row.make) return sum;
      // A row scoped to a godown only competes with other rows on that same godown.
      if (row.selected_godown_id && r.selected_godown_id !== row.selected_godown_id) return sum;
      return sum + (parseInt(r.quantity) || 0);
    }, 0);
    return Math.max(0, pool - claimedByOthers);
  };

  const onQtyChange = (idx, raw) => {
    if (raw === "") { updateItem(idx, { quantity: "" }); return; }   // blank = open line
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 0) return;
    const cap = maxQtyForRow(idx);
    updateItem(idx, { quantity: String(Math.min(n, cap)) });
  };

  const validateRows = () => {
    if (items.length === 0) { toast.error("Add at least one item"); return false; }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.part_no.trim()) { toast.error(`Row ${i + 1}: Part No required`); return false; }
      if (!it.make.trim()) { toast.error(`Row ${i + 1}: Make required`); return false; }
      // Quantity is optional — a blank means "store incharge decides at picking time".
      if (isOpenQty(it)) continue;
      const q = parseInt(it.quantity);
      if (isNaN(q) || q <= 0) { toast.error(`Row ${i + 1}: Quantity must be > 0, or leave it blank for the store incharge`); return false; }
      if (q > (it.available_qty || 0) + 1e-6) {
        toast.error(`Row ${i + 1}: ${it.part_no}/${it.make} — only ${it.available_qty} in stock, cannot issue ${q}`);
        return false;
      }
      if (it.selected_godown_id) {
        const selected = (it.godowns || []).find((g) => g.godown_id === it.selected_godown_id);
        if (selected && q > (selected.available_qty || 0) + 1e-6) {
          toast.error(`Row ${i + 1}: ${it.part_no}/${it.make} — only ${selected.available_qty || 0} in ${it.selected_godown_name || "selected godown"}, cannot issue ${q}`);
          return false;
        }
      }
    }
    // Cross-row aggregation: sum of qty across rows for same (part,make) must not exceed available
    for (const [k, total] of Object.entries(requestedByKey)) {
      const [p, m] = k.split("||");
      const row = items.find((r) => r.part_no === p && r.make === m);
      const avail = row?.available_qty || 0;
      if (total > avail + 1e-6) {
        toast.error(`${p}/${m}: total requested across rows is ${total} but only ${avail} in stock`);
        return false;
      }
    }
    for (const [k, total] of Object.entries(requestedByGodownKey)) {
      const [p, m, gid] = k.split("||");
      const row = items.find((r) => r.part_no === p && r.make === m && r.selected_godown_id === gid);
      const selected = (row?.godowns || []).find((g) => g.godown_id === gid);
      if (selected && total > (selected.available_qty || 0) + 1e-6) {
        toast.error(`${p}/${m}: total requested from ${selected.godown_name || "selected godown"} is ${total} but only ${selected.available_qty || 0} is available there`);
        return false;
      }
    }
    return true;
  };

  // Mirrors Receipt Note: Final Save needs an identified item on every row; Quantity is
  // explicitly not part of this — a blank quantity is a valid, intentional state.
  const canFinalize = items.length > 0 && items.every((it) => it.part_no.trim() && it.make.trim());

  const buildPayload = (asDraft) => ({
    stock_out_type: stockOutType || "",
    reference_doc_name: refDocName.trim(),
    reference_doc_date: refDocDate || "",
    reference_doc_no: refDocNo.trim(),
    assigned_to_user_id: assignedToUserId || null,
    narration: narration.trim(),
    save_as_draft: asDraft,
    items: items.map((it) => ({
      part_no: it.part_no.trim(),
      make: it.make.trim(),
      // null (not 0) marks an open quantity for the store incharge to fill in.
      quantity: isOpenQty(it) ? null : parseInt(it.quantity),
      description_1: it.description_1 || "",
      selected_godown_id: it.selected_godown_id || null,
      selected_godown_name: it.selected_godown_name || null,
    })),
  });

  const saveDraft = async () => {
    if (!validateRows()) return;
    setSavingDraft(true);
    try {
      const payload = buildPayload(true);
      const { data } = isEdit
        ? await api.put(`/issue-notes/${editing.id}`, payload)
        : await api.post("/issue-notes", payload);
      toast.success(`Draft saved · ${data.in_no}`);
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save draft");
    } finally { setSavingDraft(false); }
  };

  const saveFinal = async () => {
    if (!validateRows()) return;
    setSavingFinal(true);
    try {
      const payload = buildPayload(false);
      let inId, inNoDisplay;
      if (isEdit) {
        const { data } = await api.put(`/issue-notes/${editing.id}`, payload);
        inId = data.id; inNoDisplay = data.in_no;
        if (isDraftEdit) {
          await api.post(`/issue-notes/${inId}/finalize`);
          toast.success(`Issue Note ${inNoDisplay} finalized — picking pending`);
        } else {
          toast.success(`Issue Note ${inNoDisplay} updated`);
        }
      } else {
        const { data } = await api.post("/issue-notes", payload);
        inNoDisplay = data.in_no;
        toast.success(`Issue Note ${inNoDisplay} saved — picking pending`);
      }
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Could not save");
    } finally { setSavingFinal(false); }
  };

  const handleDownloadTemplate = () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Part No", "Make", "Quantity", "Godown Preference"],
      ["EXAMPLE-001", "ACME", 5, ""],
      // Blank Quantity is valid — imports as an open line for the store incharge.
      ["EXAMPLE-002", "ACME", "", ""],
      ["", "", "", ""],
    ]);
    ws["!cols"] = [{ wch: 18 }, { wch: 16 }, { wch: 12 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Issue Note Template");
    XLSX.writeFile(wb, "Issue_Note_Template.xlsx");
    toast.success("Template downloaded");
  };

  const handleExcelImport = async (file) => {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
      if (!rows.length) { toast.error("Excel file has no rows"); return; }
      const norm = (s) => String(s || "").toLowerCase().replace(/[\s_-]+/g, "");
      const pickCol = (row, names) => {
        const map = {};
        Object.keys(row).forEach((k) => { map[norm(k)] = k; });
        for (const n of names) {
          const k = map[norm(n)];
          if (k != null) return row[k];
        }
        return "";
      };
      const newRows = [];
      for (const row of rows) {
        const part_no = String(pickCol(row, ["part no", "partno", "part_no", "part number"]) || "").trim();
        const make = String(pickCol(row, ["make"]) || "").trim();
        const qtyRaw = pickCol(row, ["quantity", "qty", "requested quantity", "requested_qty"]);
        const godownPref = String(pickCol(row, ["godown preference", "godown", "godown_preference"]) || "").trim();
        if (!part_no && (qtyRaw === "" || qtyRaw == null)) continue;
        if (!part_no) { toast.error("Skipped row — Part No missing"); continue; }
        // Blank Quantity is imported as an open line (store incharge fills it in).
        const blankQty = qtyRaw === "" || qtyRaw == null;
        const qty = blankQty ? "" : parseInt(qtyRaw);
        if (!blankQty && (isNaN(qty) || qty <= 0)) { toast.error(`Row for ${part_no} skipped — Quantity must be > 0 or blank`); continue; }
        newRows.push({
          ...emptyIssueItem(),
          part_no, make, quantity: qty, _godownPrefName: godownPref,
          // Stable id to re-find this exact row across the two chained async lookups
          // below — matching by object reference breaks once the first lookup's
          // setItems() has already replaced the row with a new object (which is
          // what was happening: the godown lookup's setItems could never find its
          // row again, so `godowns` never got populated and the Godown Preference
          // dropdown stayed permanently disabled after an import).
          _importId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        });
      }
      if (!newRows.length) { toast.error("No valid rows found in file"); return; }
      setItems((prev) => {
        const onlyEmpty = prev.length === 1 && !prev[0].part_no && !prev[0].quantity;
        return onlyEmpty ? newRows : [...prev, ...newRows];
      });
      newRows.forEach((row) => {
        const importId = row._importId;
        setTimeout(() => {
          api.get(`/issue-notes/lookup/${encodeURIComponent(row.part_no)}`)
            .then(({ data }) => {
              const list = data.makes || [];
              const matched = row.make ? list.find((m) => m.make === row.make) : (list.length === 1 ? list[0] : null);
              setItems((prev) => prev.map((r) => {
                if (r._importId !== importId) return r;
                const avail = matched ? matched.available_qty : 0;
                const typed = parseInt(r.quantity);
                return {
                  ...r, makes: list, partLooked: true,
                  make: matched ? matched.make : row.make,
                  available_qty: avail,
                  // A spreadsheet can ask for more than exists — cap it on arrival so the
                  // grid never holds a quantity the user could not have typed by hand.
                  quantity: !isNaN(typed) && typed > avail ? String(avail) : r.quantity,
                  description_1: matched ? (matched.description_1 || "") : "",
                  model: matched ? (matched.model || "") : "",
                };
              }));
              if (matched) {
                api.get(`/issue-notes/lookup/${encodeURIComponent(row.part_no)}/godowns`, { params: { make: matched.make } })
                  .then(({ data: gd }) => {
                    const glist = gd.godowns || [];
                    const gmatch = row._godownPrefName
                      ? glist.find((g) => g.godown_name.toLowerCase() === row._godownPrefName.toLowerCase())
                      : (glist.length === 1 ? glist[0] : null);
                    setItems((prev) => prev.map((r) => r._importId !== importId ? r : {
                      ...r, godowns: glist,
                      selected_godown_id: gmatch ? gmatch.godown_id : null,
                      selected_godown_name: gmatch ? gmatch.godown_name : null,
                    }));
                  }).catch(() => {});
              }
            })
            .catch(() => {
              setItems((prev) => prev.map((r) => r._importId !== importId ? r : { ...r, partLooked: true }));
            });
        }, 0);
      });
      toast.success(`Imported ${newRows.length} row${newRows.length > 1 ? "s" : ""} from Excel`);
    } catch (err) {
      toast.error("Could not read Excel file");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="mt-4 space-y-6" data-testid="in-create-view">
      <div className="flex items-center justify-between">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="in-back-button">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
        {isDraftEdit && (
          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm bg-slate-100 text-slate-600">Draft</span>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-sm p-6 grid grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <Label className="label-sm">Stock Out Type</Label>
          <div className="flex items-center gap-2 mt-2">
            <Select value={stockOutType || undefined} onValueChange={setStockOutType}>
              <SelectTrigger className="rounded-sm min-w-0 flex-1" data-testid="in-stock-out-type">
                <SelectValue placeholder={stockOutTypes.length === 0 ? "No types yet — create one" : "Select type"} />
              </SelectTrigger>
              <SelectContent>
                {stockOutTypes.map((t) => (
                  <SelectItem key={t.id} value={t.name} data-testid={`in-stock-out-type-option-${t.name}`}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              className="rounded-sm border-slate-300 shrink-0 px-2"
              onClick={() => setNewTypeOpen(true)}
              title="Create a new Stock Out Type"
              data-testid="in-stock-out-type-new"
            >
              <Plus size={14} weight="bold" />
            </Button>
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Shared list · reused on every Issue Note</div>
        </div>
        <div>
          <Label className="label-sm">Issue Note Date</Label>
          <Input value={inDate} disabled className="mt-2 rounded-sm font-mono bg-slate-50" data-testid="in-date-input" />
          <div className="text-[11px] text-slate-500 mt-1">Auto · today's date</div>
        </div>
        <div>
          <Label className="label-sm">Issue Note No</Label>
          <Input value={inNo} disabled className="mt-2 rounded-sm font-mono font-semibold bg-blue-50 text-blue-900" data-testid="in-no-input" />
          <div className="text-[11px] text-slate-500 mt-1">Auto · resets each FY</div>
        </div>
        <div>
          <Label className="label-sm">Reference Document Name</Label>
          <Input
            value={refDocName}
            onChange={(e) => setRefDocName(e.target.value)}
            placeholder="e.g. Sales Order"
            className="mt-2 rounded-sm font-mono"
            data-testid="in-ref-doc-name"
          />
          <div className="text-[11px] text-slate-500 mt-1">Optional</div>
        </div>
        <div>
          <Label className="label-sm">Reference Document Date</Label>
          <Input
            type="date"
            value={refDocDate}
            onChange={(e) => setRefDocDate(e.target.value)}
            className="mt-2 rounded-sm font-mono"
            data-testid="in-ref-doc-date"
          />
          <div className="text-[11px] text-slate-500 mt-1">Optional</div>
        </div>
        <div>
          <Label className="label-sm">Reference Document No</Label>
          <Input
            value={refDocNo}
            onChange={(e) => setRefDocNo(e.target.value)}
            placeholder="e.g. SO-1024"
            className="mt-2 rounded-sm font-mono"
            data-testid="in-ref-doc-no"
          />
          <div className="text-[11px] text-slate-500 mt-1">Optional</div>
        </div>
        <div className="col-span-2 lg:col-span-3">
          <AssigneeSelect
            value={assignedToUserId}
            onChange={setAssignedToUserId}
            module="stock_out"
            testid="in-assignee"
          />
        </div>
      </div>

      {/* CREATE STOCK OUT TYPE */}
      <Dialog open={newTypeOpen} onOpenChange={(o) => { if (!o) { setNewTypeOpen(false); setNewTypeName(""); } }}>
        <DialogContent className="max-w-md rounded-sm" data-testid="in-new-type-dialog">
          <div className="text-lg font-black tracking-tight text-slate-900">New Stock Out Type</div>
          <div className="text-xs text-slate-500 -mt-2">
            Created once and reused everywhere, so the same classification is always spelled the same way.
          </div>
          <div className="mt-2">
            <Label className="label-sm">Type Name</Label>
            <Input
              autoFocus
              value={newTypeName}
              onChange={(e) => setNewTypeName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); createStockOutType(); } }}
              placeholder="e.g. Sample, Warranty Replacement"
              className="mt-2 rounded-sm font-mono"
              data-testid="in-new-type-name"
            />
          </div>
          <div className="flex items-center justify-end gap-2 pt-4">
            <Button variant="outline" className="rounded-sm" onClick={() => { setNewTypeOpen(false); setNewTypeName(""); }}>
              Cancel
            </Button>
            <Button
              className="rounded-sm bg-blue-700 hover:bg-blue-800"
              onClick={createStockOutType}
              disabled={creatingType}
              data-testid="in-new-type-save"
            >
              {creatingType ? "Creating…" : "Create Type"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div className="bg-white border border-slate-200 rounded-sm">
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <div>
            <div className="label-sm">Items Issued</div>
            <div className="text-xs text-slate-500 mt-0.5">{items.length} row{items.length !== 1 ? "s" : ""}</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => handleExcelImport(e.target.files?.[0])}
              className="hidden"
              data-testid="in-excel-input"
            />
            <Button
              onClick={handleDownloadTemplate}
              variant="outline"
              className="rounded-sm border-slate-300"
              data-testid="in-excel-template-button"
              title="Download an empty Excel template (Part No, Make, Quantity, Godown Preference)"
            >
              <DownloadSimple size={16} weight="bold" className="mr-2" /> Download Template
            </Button>
            <Button
              onClick={() => fileInputRef.current?.click()}
              variant="outline"
              className="rounded-sm border-slate-300"
              data-testid="in-excel-import-button"
              title="Columns: Part No, Make, Quantity, Godown Preference"
            >
              <UploadSimple size={16} weight="bold" className="mr-2" /> Import Excel
            </Button>
            <Input
              type="number"
              min="1"
              max="500"
              value={addCount}
              onChange={(e) => setAddCount(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addItems(); } }}
              placeholder="Qty"
              className="rounded-sm font-mono h-9 w-24 text-center"
              data-testid="in-add-row-count"
              title="Number of rows to add at once (default 1)"
            />
            <Button onClick={addItems} variant="outline" className="rounded-sm border-slate-300" data-testid="in-add-row-button">
              <Plus size={16} weight="bold" className="mr-2" /> Add Row{addCount && parseInt(addCount, 10) > 1 ? "s" : ""}
            </Button>
          </div>
        </div>

        {/* Fixed column widths (table-layout:fixed + colgroup): every control keeps the
            same footprint whether or not it holds a value, so rows never reflow as the
            user types. Description takes whatever width is left over. */}
        <div className="overflow-x-auto">
        <table className="data-table data-table-fixed w-full min-w-[1100px]">
          <colgroup>
            <col style={{ width: "56px" }} />
            <col style={{ width: "120px" }} />
            <col style={{ width: "180px" }} />
            <col />
            <col style={{ width: "160px" }} />
            <col style={{ width: "130px" }} />
            <col style={{ width: "180px" }} />
            <col style={{ width: "84px" }} />
          </colgroup>
          <thead>
            <tr><th>SL NO</th><th>MODEL</th><th>PART NO</th><th>DESCRIPTION</th><th>MAKE</th>{/* This is the source of Issued Qty — the same number every downstream Stock Out
                view calls "Issued", named identically here so the trail is obvious. */}
            <th className="!text-center">ISSUED QTY</th><th>GODOWN PREFERENCE</th><th></th></tr>
          </thead>
          <tbody>
            {items.map((it, idx) => {
              const openQty = isOpenQty(it);
              const overStock = !openQty && it.available_qty !== undefined && (parseInt(it.quantity) || 0) > (it.available_qty || 0) + 1e-6;
              const selectedGodown = (it.godowns || []).find((g) => g.godown_id === it.selected_godown_id);
              const overGodown = !openQty && !!it.selected_godown_id && selectedGodown && (parseInt(it.quantity) || 0) > (selectedGodown.available_qty || 0) + 1e-6;
              const rowCap = maxQtyForRow(idx);
              const atCap = !openQty && rowCap > 0 && (parseInt(it.quantity) || 0) === rowCap;
              return (
              <tr key={idx} data-testid={`in-item-row-${idx}`} className={(overStock || overGodown) ? "bg-red-50" : ""}>
                <td className="font-mono text-slate-500 align-middle">{idx + 1}</td>
                <td className="align-middle">
                  <div
                    className="h-8 flex items-center text-xs text-slate-700 px-2 bg-slate-50 rounded-sm border border-slate-200 overflow-hidden whitespace-nowrap text-ellipsis"
                    title={it.model || "—"}
                    data-testid={`in-model-${idx}`}
                  >
                    <span className="truncate">{it.model || <span className="text-slate-400 italic">(auto)</span>}</span>
                  </div>
                </td>
                <td>
                  <Input value={it.part_no}
                    onChange={(e) => updateItem(idx, {
                      part_no: e.target.value,
                      partLooked: false,
                      makes: [],
                      make: "",
                      available_qty: 0,
                      godowns: [],
                      selected_godown_id: null,
                      selected_godown_name: null,
                    })}
                    onBlur={(e) => lookupMakes(idx, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Tab" || e.shiftKey) return;
                      // The Make dropdown is disabled until the lookup resolves, so a
                      // plain Tab would land nowhere. Hold focus, run the lookup, then
                      // hand focus to Make once its options exist.
                      e.preventDefault();
                      const val = e.target.value;
                      lookupMakes(idx, val).then(() => {
                        setTimeout(() => document.querySelector(`[data-testid="in-make-${idx}"]`)?.focus(), 0);
                      });
                    }}
                    placeholder="Enter part no"
                    className="rounded-sm font-mono font-semibold text-sm h-8 w-full px-2 text-slate-900"
                    data-testid={`in-part-no-${idx}`} />
                </td>
                <td className="align-middle" data-testid={`in-description-${idx}`}>
                  <div className="h-8 flex items-center text-xs text-slate-600 overflow-hidden" title={it.description_1 || ""}>
                    <span className="truncate">{it.description_1 || "—"}</span>
                  </div>
                </td>
                <td className="align-middle">
                  <Select disabled={!it.partLooked || it.makes.length === 0}
                    value={it.make || undefined} onValueChange={(v) => onMakeChange(idx, v)}>
                    <SelectTrigger className="rounded-sm h-8 w-full text-xs [&>span]:truncate" data-testid={`in-make-${idx}`}>
                      <SelectValue placeholder={!it.partLooked ? "Part No first" : (it.makes.length === 0 ? "No stock" : "Select make")} />
                    </SelectTrigger>
                    <SelectContent>
                      {it.makes.map((m) => (
                        <SelectItem key={m.make} value={m.make} data-testid={`in-make-${idx}-option-${m.make}`}>
                          <span className="font-mono">{m.make}</span>
                          <span className="ml-3 text-xs text-slate-500">avail {m.available_qty}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="align-middle">
                  <Input type="number" min="1" step="1" max={rowCap || undefined} value={it.quantity}
                    disabled={!it.make}
                    onChange={(e) => onQtyChange(idx, e.target.value)}
                    placeholder="Optional"
                    title={it.make
                      ? `Up to ${rowCap} available. Leave blank to let the store incharge decide.`
                      : "Leave blank to let the store incharge decide the quantity while picking"}
                    className={`rounded-sm font-mono h-8 w-full text-center px-1 ${overStock || overGodown ? "border-red-400" : ""}`}
                    data-testid={`in-qty-${idx}`} />
                  {/* Always rendered (invisible when there's nothing to say) so the row
                      height never changes as makes/quantities are filled in. */}
                  <div
                    className={`h-[14px] leading-[14px] text-[10px] mt-0.5 text-center overflow-hidden whitespace-nowrap text-ellipsis ${
                      !it.make ? "invisible"
                        : (overStock || overGodown ? "text-red-600 font-bold"
                          : (atCap ? "text-amber-600 font-bold" : "text-slate-500"))
                    }`}
                    title={it.make && openQty ? `Open — the store incharge decides (available ${it.available_qty})` : undefined}
                    data-testid={`in-avail-hint-${idx}`}
                  >
                    {openQty ? `Open · avail ${rowCap}`
                      : (overGodown ? `Over ${it.quantity}/${selectedGodown?.available_qty || 0}`
                        : (overStock ? `Over ${it.quantity}/${it.available_qty}`
                          : (atCap ? `Max ${rowCap}` : `Avail ${rowCap}`)))}
                  </div>
                </td>
                <td className="align-middle">
                  <Select
                    disabled={!it.make || (it.godowns || []).length === 0}
                    value={it.selected_godown_id || NO_GODOWN}
                    onValueChange={(v) => onIssueGodownChange(idx, v)}
                  >
                    <SelectTrigger className="rounded-sm h-8 w-full text-xs [&>span]:truncate" data-testid={`in-godown-${idx}`}>
                      <SelectValue placeholder={!it.make ? "Select make first" : "No godown preference"} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_GODOWN}>No godown preference</SelectItem>
                      {(it.godowns || []).map((g) => (
                        <SelectItem key={g.godown_id} value={g.godown_id} data-testid={`in-godown-${idx}-option-${g.godown_id}`}>
                          <span className="font-mono">{g.godown_name}</span>
                          <span className="ml-3 text-xs text-slate-500">avail {g.available_qty}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="align-middle">
                  <div className="flex items-center gap-1 h-8">
                    <button onClick={() => insertItemAfter(idx)}
                      className="p-1.5 rounded-sm hover:bg-blue-50 text-blue-700"
                      title="Add row below"
                      data-testid={`in-add-row-${idx}`}><Plus size={14} /></button>
                    <button onClick={() => removeItem(idx)} disabled={items.length === 1}
                      onKeyDown={(e) => {
                        if (e.key === "Tab" && !e.shiftKey && idx === items.length - 1 && items.length > 1) {
                          e.preventDefault();
                          document.querySelector('[data-testid="in-narration"]')?.focus();
                        }
                      }}
                      className={`p-1.5 rounded-sm ${items.length === 1 ? "text-slate-300 cursor-not-allowed" : "hover:bg-red-50 text-red-700"}`}
                      data-testid={`in-remove-row-${idx}`}><Trash size={14} /></button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        </div>

        {/* SAVE BAR — narration on left, action buttons on right */}
        <div className="flex items-start justify-between gap-4 p-4 border-t border-slate-200 bg-slate-50">
          <div className="flex-1 max-w-sm">
            <label className="label-sm block mb-1.5">Narration</label>
            <textarea
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Tab" && !e.shiftKey) {
                  e.preventDefault();
                  const draftBtn = document.querySelector('[data-testid="in-save-draft-button"]');
                  if (draftBtn && !draftBtn.disabled) {
                    draftBtn.focus();
                  } else {
                    document.querySelector('[data-testid="in-save-final-button"]')?.focus();
                  }
                }
              }}
              placeholder="Optional narration…"
              rows={2}
              className="w-full rounded-sm border border-slate-300 bg-white px-3 py-1.5 text-sm font-mono resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
              data-testid="in-narration"
            />
          </div>
          <div className="flex items-center gap-2 pt-7">
            {!isFinalEdit && (
              <Button
                onClick={saveDraft}
                disabled={savingDraft || savingFinal}
                variant="outline"
                className="rounded-sm border-blue-700 text-blue-700 hover:bg-blue-50"
                data-testid="in-save-draft-button"
              >
                <FloppyDisk size={14} weight="bold" className="mr-2" />
                {savingDraft ? "Saving…" : "Save as Draft"}
              </Button>
            )}
            <Button
              onClick={saveFinal}
              disabled={savingDraft || savingFinal || (!canFinalize && !isFinalEdit)}
              className="rounded-sm bg-blue-700 hover:bg-blue-800 disabled:bg-slate-300 disabled:cursor-not-allowed"
              data-testid="in-save-final-button"
              title={!canFinalize && !isFinalEdit
                ? "Fill Part No and Make on every row to enable Final Save (Quantity may be left blank)"
                : (isFinalEdit ? "Update Issue Note" : "Final Save — releases for picking")}
            >
              <CheckCircle size={14} weight="bold" className="mr-2" />
              {savingFinal ? "Saving…" : (isFinalEdit ? "Update Issue Note" : "Save Final")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================== PICKING NOTE TAB =========================== */
function PickingNoteTab() {
  const [view, setView] = useState("list");
  const [editing, setEditing] = useState(null);
  const [openPn, setOpenPn] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const goEdit = (p) => { setEditing(p); setView("edit"); };
  const goList = () => { setEditing(null); setView("list"); setReloadKey((k) => k + 1); };

  return (
    <>
      {view === "list" && <PickingNoteList reloadKey={reloadKey} onEdit={goEdit} onOpen={setOpenPn} onRecorded={() => setReloadKey((k) => k + 1)} />}
      {view === "edit" && <PickingNoteForm editing={editing} onCancel={goList} onSaved={goList} />}
      <PickingNoteDetailDialog pn={openPn} onClose={() => setOpenPn(null)} />
    </>
  );
}

function PickingNoteList({ reloadKey, onEdit, onOpen, onRecorded }) {
  const { user: me, isAdmin } = useAuth();
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [recordingId, setRecordingId] = useState(null);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/picking-notes", { params: { page, page_size: PAGE_SIZE, search: search || undefined } });
      setRows(res.data);
      const t = parseInt(res.headers["x-total-count"], 10);
      setTotal(isNaN(t) ? res.data.length : t);
    } finally { setLoading(false); }
  }, [page, search]);
  useEffect(() => { load(); }, [load, reloadKey, search]);
  // Ctrl+F focusses the search input
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // No Close action: writing a quantity off is now done by REJECTING it on the note
  // itself — reject the whole outstanding amount and the request is settled, with no
  // stock movement and no follow-up note. That keeps one way to refuse a quantity
  // instead of two. Notes CLOSED before this change still display as Closed.
  const handleRecord = async (pn) => {
    if (!window.confirm(`Record ${pn.pn_no} as Stock Out?\n\n${pn.items.length} OUT transaction(s) will be created.`)) return;
    setRecordingId(pn.id);
    try {
      const { data } = await api.post(`/picking-notes/${pn.id}/record`);
      toast.success(`Recorded · ${data.transactions_created} stock-out transaction(s) created`);
      if (data.remaining_picking_note?.pn_no) {
        toast.info(`Remaining quantity moved to ${data.remaining_picking_note.pn_no}`);
      }
      load(); onRecorded?.();
    } catch (err) { toast.error(formatApiError(err.response?.data?.detail) || "Could not record"); }
    finally { setRecordingId(null); }
  };

  // Header labels stay in full form — the column widths below are sized to fit them on
  // one line rather than the labels being shortened to fit the columns.
  const columns = useMemo(() => [
    { key: "pn_date", label: "PICKING NOTE DATE", value: (r) => fmtDate(r.pn_date) },
    { key: "pn_no", label: "PICKING NOTE NO", value: (r) => r.pn_no || "" },
    { key: "in_date", label: "ISSUE NOTE DATE", value: (r) => fmtDate(r.issue_note_date) },
    { key: "in_no", label: "ISSUE NOTE NO", value: (r) => r.issue_note_no || "" },
    { key: "parent_assigned_to_name", label: "ASSIGNED TO", value: (r) => r.parent_assigned_to_name || "" },
    { key: "items_count", label: "ITEMS", value: (r) => pickingDisplayCount(r), isQty: true, isNumeric: true },
    // The list is a working queue, not a report: Issued/Picked/Rejected are what tell an
    // operator whether a note still needs attention. Available is live stock (it belongs
    // to the pick itself), and Pending/Extra are derived — all three are on the note's
    // detail, edit and print views instead of crowding the list.
    { key: "issued_qty", label: "ISSUED", value: (r) => pickingIssuedQty(r), isQty: true, isNumeric: true },
    { key: "picked_qty", label: "PICKED", value: (r) => pickingPickedQty(r), isQty: true, isNumeric: true },
    { key: "rejected_qty", label: "REJECTED", value: (r) => pickingRejectedQty(r), isQty: true, isNumeric: true },
    { key: "status", label: "STATUS", value: (r) => pickingNoteStatusLabel(r.status) },
  ], []);
  const {
    filteredRows, uniqueValues, colFilters, setColFilter, sort, setColumnSort,
  } = useExcelTableFilter(rows, columns);

  const handleExport = () => {
    if (filteredRows.length === 0) { toast.error("No rows to export"); return; }
    const exportCols = [
      { label: "Sl No", value: (r) => filteredRows.indexOf(r) + 1 },
      ...columns,
    ];
    exportToExcel(filteredRows, exportCols, `Picking_Notes_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="mt-4" data-testid="pn-list-view">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input
            ref={searchInputRef}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search picking notes…"
            className="rounded-sm font-mono h-9 pl-10 w-full"
            data-testid="pn-search-input"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleExport} variant="outline" className="rounded-sm border-slate-300" data-testid="pn-export-button">
            <DownloadSimple size={14} weight="bold" className="mr-2" /> Export
          </Button>
          <Button onClick={load} variant="outline" className="rounded-sm border-slate-300" disabled={loading} data-testid="pn-refresh-button">
            <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button disabled variant="outline" className="rounded-sm border-slate-300 text-slate-400" title="Picking Notes are auto-generated when Issue Notes are saved" data-testid="create-pn-button">
            <Package size={16} weight="bold" className="mr-2" /> Auto Generated
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-between mb-3 text-xs text-slate-600">
  <div>
    {total === 0 ? "No picking notes" : (
      <>
        Showing <span className="font-semibold text-slate-900">{filteredRows.length}</span>
        {" - "}<span className="font-semibold text-slate-900">{total}</span> total
      </>
    )}
  </div>
  <div className="flex items-center gap-2">
    <Button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading} variant="outline" size="sm" className="rounded-sm h-7">
      <CaretLeft size={12} weight="bold" className="mr-1" /> Prev
    </Button>
    <span className="font-mono">Page {page} of {totalPages}</span>
    <Button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages || loading} variant="outline" size="sm" className="rounded-sm h-7">
      Next <CaretRight size={12} weight="bold" className="ml-1" />
    </Button>
    <span className="text-slate-400 ml-2">{PAGE_SIZE.toLocaleString()} / page</span>
  </div>
</div>
      {/* Column widths are cut to fit each full header label on one line — nothing is
          clipped or abbreviated. The page scrolls normally; only the horizontal
          overflow is handled here. */}
      <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto" data-testid="pn-scroller">
        <table className="data-table data-table-fixed w-full min-w-[1500px]">
          <colgroup>
            <col style={{ width: "70px" }} />
            <col style={{ width: "176px" }} />
            <col style={{ width: "160px" }} />
            <col style={{ width: "160px" }} />
            <col style={{ width: "144px" }} />
            {/* ASSIGNED TO was left unconstrained (`<col />`) — on a fixed table that
                absorbs whatever is left over, and it collapsed to almost nothing after
                the table's min-width was trimmed down when Available/Pending/Extra were
                removed from this list, clipping the header word entirely. Fixed width. */}
            <col style={{ width: "160px" }} />
            <col style={{ width: "72px" }} />
            {/* The three quantity columns — each sized to its full header label. */}
            <col style={{ width: "88px" }} />
            <col style={{ width: "88px" }} />
            <col style={{ width: "100px" }} />
            {/* Wide enough for the "Completed" pill plus its padding, and for the
                "Recording…" button label at its longest. */}
            <col style={{ width: "116px" }} />
            {/* Edit + Record side by side. */}
            <col style={{ width: "132px" }} />
          </colgroup>
          <thead>
            <tr>
              <th>SL NO</th>
              {columns.map((c) => (
                <th key={c.key} className={c.isQty ? "!text-center" : ""}>
                  <ExcelColumnFilter
                    label={c.label}
                    values={uniqueValues[c.key] || []}
                    selected={colFilters[c.key]}
                    onChange={(s) => setColFilter(c.key, s)}
                    sortDir={sort?.key === c.key ? sort.dir : null}
                    onSort={(dir) => setColumnSort(c.key, dir)}
                    isQty={c.isQty}
                    isNumeric={c.isNumeric}
                  />
                </th>
              ))}
              <th className="text-left">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r, idx) => {
              const t = pickingTotals(r);
              const recorded = r.status === "RECORDED" || r.status === "COMPLETED";
              const closed = pickingNoteIsClosed(r);
              const pending = r.status === "PENDING";
              const aId = r.parent_assigned_to_user_id;
              const aName = r.parent_assigned_to_name;
              const aEmail = r.parent_assigned_to_email;
              const lockedToOther = !!aId && aId !== me?.id && !isAdmin;
              // A closed note is as final as a recorded one — nothing about it can change.
              const lock = recorded || closed || lockedToOther;
              const editTitle = recorded ? "Cannot edit — already recorded"
                : closed ? "Cannot edit — this note was closed as unpickable"
                : (lockedToOther ? `Locked — assigned to ${aName || aEmail}` : (pending ? "Open Picking" : "Edit"));
              const recordTitle = recorded ? "Already recorded"
                : closed ? "Closed — nothing to record"
                : (pending ? "Open Picking and save a draft first" : (lockedToOther ? `Locked — assigned to ${aName || aEmail}` : "Record as Stock Out"));
              const recordDisabled = lock || pending || recordingId === r.id;
              return (
                <tr key={r.id} data-testid={`pn-row-${r.pn_no}`} className={`transition-colors duration-100 ${closed ? "bg-slate-50" : ""}`}>
                  <td className="font-mono text-slate-500">{idx + 1}</td>
                  <td className="font-mono text-slate-700">{fmtDate(r.pn_date)}</td>
                  <td>
                    <button onClick={() => onOpen(r)} className="font-mono font-semibold text-blue-700 hover:underline" data-testid={`pn-open-${r.pn_no}`}>{r.pn_no}</button>
                  </td>
                  <td className="font-mono text-slate-700">{fmtDate(r.issue_note_date)}</td>
                  <td className="font-mono text-slate-700">{r.issue_note_no || "—"}</td>
                  <td className="text-slate-700 truncate" title={r.parent_assigned_to_name || ""}>{r.parent_assigned_to_name || "—"}</td>
                  <td className="font-mono text-slate-600 tabular-nums text-center">{pickingDisplayCount(r)}</td>
                  <td className="font-mono font-bold text-slate-900 tabular-nums text-center">{t.issued || "—"}</td>
                  <td className="font-mono font-bold text-slate-900 tabular-nums text-center">{t.picked}</td>
                  <td className={`font-mono font-bold tabular-nums text-center ${t.rejected > 0 ? "text-red-700" : "text-slate-400"}`}>{t.rejected}</td>
                  <td>
                    {/* inline-block + nowrap keeps the pill a solid, self-contained block
                        so it can never bleed into the neighbouring cell. */}
                    <span className={`inline-block whitespace-nowrap text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${pickingNoteStatusClass(r.status)}`}
                      title={closed ? (r.close_reason || "Closed — this quantity will not be picked") : ""}
                      data-testid={`pn-status-${r.pn_no}`}>
                      {pickingNoteStatusLabel(r.status)}
                    </span>
                  </td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button onClick={() => onEdit(r)} disabled={lock}
                        title={editTitle}
                        className={`p-1.5 rounded-sm shrink-0 ${lock ? "text-slate-300 cursor-not-allowed" : "hover:bg-slate-100"}`}
                        data-testid={`pn-edit-${r.pn_no}`}>
                        <Pencil size={14} />
                      </button>
                      <Button onClick={() => handleRecord(r)} disabled={recordDisabled} size="sm"
                        title={recordTitle}
                        className={`rounded-sm h-7 text-[11px] px-2 shrink-0 ${recordDisabled ? "bg-slate-200 text-slate-500 cursor-not-allowed hover:bg-slate-200" : "bg-emerald-700 hover:bg-emerald-800 text-white"}`}
                        data-testid={`pn-record-${r.pn_no}`}>
                        <CheckCircle size={12} weight="bold" className="mr-1" />
                        {recorded ? "Recorded" : (recordingId === r.id ? "Recording…" : "Record")}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && (
              <tr><td colSpan={columns.length + 2} className="text-center py-12 text-slate-500">{loading ? "Loading…" : (rows.length === 0 ? "No picking notes yet — they are created automatically when an Issue Note is saved." : "No rows match the current filters.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PickingNoteDetailDialog({ pn, onClose }) {
  const issuedFor = pn ? pickingRequestedLookup(pn) : () => null;
  const availableFor = pn ? pickingAvailableLookup(pn) : () => null;
  const totals = pickingTotals(pn);
  const available = pickingAvailableQty(pn);
  return (
    <Dialog open={!!pn} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl max-h-[92vh] overflow-y-auto rounded-sm" data-testid="pn-detail-dialog">
        {pn && (
          <>
            <div className="text-center text-xl font-black tracking-widest uppercase pt-1 pb-2 border-b border-slate-200">
              PICKING NOTE
            </div>
            <div className="grid grid-cols-2 gap-6 text-sm pt-3 pb-4 border-b border-slate-200">
              <div className="space-y-2">
                <Detail k="PICKING NOTE DATE" v={fmtDate(pn.pn_date)} />
                <Detail k="PICKING NOTE NO" v={pn.pn_no} />
                <Detail k="ISSUE NOTE NO" v={pn.issue_note_no || "—"} />
                <Detail k="STATUS" v={
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm ${pickingNoteStatusLabel(pn.status) === "Completed" ? "bg-green-100 text-green-800" : (pickingNoteStatusLabel(pn.status) === "Pending" ? "bg-blue-50 text-blue-800" : "bg-amber-50 text-amber-700")}`}>
                    {pickingNoteStatusLabel(pn.status)}
                  </span>
                } />
              </div>
              <div className="space-y-2">
                <Detail k="CREATED BY (PICKER)" v={pn.created_by || "—"} />
                <Detail k="CREATED AT" v={new Date(pn.created_at).toLocaleString()} />
                <Detail k="ISSUED QTY / AVAILABLE QTY" v={
                  <span className="font-mono">
                    {totals.issued || "—"}
                    <span className="text-slate-400"> / </span>
                    {available == null ? "—" : available}
                  </span>
                } />
                <Detail k="PICKED QTY" v={<span className="font-mono font-bold">{totals.picked}</span>} />
                <Detail k="PENDING QTY" v={
                  <span className={`font-mono font-bold ${totals.pending > 0 ? "text-amber-700" : "text-slate-500"}`}>
                    {totals.pending}
                    {totals.pending > 0 && !pickingNoteIsClosed(pn) && <span className="ml-2 text-[10px] font-normal text-slate-500">carries to the next Picking Note</span>}
                    {totals.pending > 0 && pickingNoteIsClosed(pn) && <span className="ml-2 text-[10px] font-normal text-slate-500">written off — note closed</span>}
                  </span>
                } />
                <Detail k="REJECTED QTY / EXTRA QTY" v={
                  <span className="font-mono font-bold">
                    <span className={totals.rejected > 0 ? "text-red-700" : "text-slate-500"}>{totals.rejected}</span>
                    <span className="text-slate-400"> / </span>
                    <span className={totals.extra > 0 ? "text-emerald-700" : "text-slate-500"}>{totals.extra}</span>
                    {totals.extra > 0 && <span className="ml-2 text-[10px] font-normal text-emerald-700">extra taken</span>}
                  </span>
                } />
                {pickingNoteIsClosed(pn) && (
                  <Detail k="CLOSED" v={
                    <span className="text-slate-700">
                      {pn.closed_at ? new Date(pn.closed_at).toLocaleString() : "—"}
                      {pn.closed_by ? ` · ${pn.closed_by}` : ""}
                      {pn.close_reason ? <div className="text-xs text-slate-500 mt-0.5">{pn.close_reason}</div> : null}
                    </span>
                  } />
                )}
                <div>
                  <div className="label-sm">ASSIGNED TO (FROM ISSUE NOTE)</div>
                  <div className="mt-1"><AssigneeBadge name={pn.parent_assigned_to_name} email={pn.parent_assigned_to_email} /></div>
                </div>
              </div>
            </div>
            {pn.narration && (
              <div className="pt-3 pb-1 border-b border-slate-200">
                <div className="label-sm mb-1">NARRATION</div>
                <div className="text-sm text-slate-700 whitespace-pre-wrap">{pn.narration}</div>
              </div>
            )}
            <div className="mt-2">
              <div className="label-sm mb-2">Items ({pickingDisplayItems(pn).length})</div>
              <div className="overflow-x-auto">
                <table className="data-table w-full text-xs">
                  <thead><tr><th>SL</th><th>PART NO</th><th>MAKE</th><th>DESCRIPTION</th><th>STATUS</th><th className="text-center">ISSUED QTY</th><th className="text-center">AVAILABLE QTY</th><th className="text-center">PICKED QTY</th><th className="text-center">PENDING QTY</th><th className="text-center">REJECTED QTY</th><th className="text-center">EXTRA QTY</th><th>GODOWN</th><th>RACK</th><th>BOX</th></tr></thead>
                  <tbody>
                    {pickingDisplayItems(pn).map((it, idx) => {
                      const q = stockOutQtys(issuedFor(it), it.picked_qty, it.rejected_qty);
                      const avail = availableFor(it);
                      return (
                      <tr key={idx}>
                        <td className="font-mono text-slate-500">{idx + 1}</td>
                        <td><PartNoLink partNo={it.part_no} make={it.make} /></td>
                        <td>{it.make}</td>
                        <td className="text-slate-700 max-w-[260px] truncate">{it.description_1 || "—"}</td>
                        <td className="font-mono text-slate-600">{it.row_status || "—"}</td>
                        <td className="text-center font-mono font-bold text-slate-600">{q.issued == null ? <span className="text-blue-700">Open</span> : q.issued}</td>
                        <td className="text-center font-mono text-slate-600" title="Live stock for this item">{avail == null ? "—" : avail}</td>
                        <td className="text-center font-mono font-bold">{q.picked}</td>
                        <td className={`text-center font-mono font-bold ${q.pending > 0 ? "text-amber-700" : "text-slate-400"}`}>
                          {q.pending == null ? "—" : q.pending}
                        </td>
                        <td className={`text-center font-mono font-bold ${q.rejected > 0 ? "text-red-700" : "text-slate-400"}`}>
                          {q.rejected || "—"}
                        </td>
                        <td className={`text-center font-mono font-bold ${q.extra > 0 ? "text-emerald-700" : "text-slate-400"}`}>
                          {q.extra || "—"}
                        </td>
                        <td className="font-mono">{it.godown_name || "—"}</td>
                        <td className="font-mono">{it.rack_no || "—"}</td>
                        <td className="font-mono">{it.box_no || "—"}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="flex items-center gap-2 pt-4 border-t border-slate-200 mt-6">
              <Button onClick={() => printPickingNote(pn)} variant="outline" size="sm" className="rounded-sm" data-testid="pn-print-button">
                <Printer size={14} weight="bold" className="mr-1.5" /> Print
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PickingNoteForm({ editing, onCancel, onSaved }) {
  const isEdit = !!editing;
  const [pnNo, setPnNo] = useState("");
  const [pnDate, setPnDate] = useState("");
  const [pendingIns, setPendingIns] = useState([]);
  const [selectedInId, setSelectedInId] = useState("");
  const [assignedToName, setAssignedToName] = useState("");
  const [items, setItems] = useState([]);
  const [narration, setNarration] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isEdit) {
      setPnNo(editing.pn_no);
      setPnDate(editing.pn_date);
      setSelectedInId(editing.issue_note_id);
      setAssignedToName(editing.parent_assigned_to_name || "");
      setNarration(editing.narration || "");
      setPendingIns([{ id: editing.issue_note_id, in_no: editing.issue_note_no, in_date: editing.issue_note_date, assigned_to_name: editing.parent_assigned_to_name }]);
      api.get(`/picking-notes/prepare/${editing.issue_note_id}`, { params: { exclude_pn_id: editing.id } })
        .then((r) => {
          setItems(buildPickingEditItems(editing, r.data.items || []));
        }).catch(() => setItems((editing.items || []).map((it) => ({
          ...it, ...locSelKeys(it), pending_qty: 0, requested_qty: 0, allocated_qty: it.quantity || 0,
          rejected_qty: it.rejected_qty ?? 0, available_qty: 0,
          // Prepare failed — fall back to a single-option location list so the
          // dropdown/qty editing still works using the row's already-stored location.
          available_locations: it.godown_id ? [{
            godown_id: it.godown_id, godown_name: it.godown_name, rack_id: it.rack_id, rack_no: it.rack_no,
            box_id: it.box_id, box_no: it.box_no, box_category: it.box_category, current_qty: it.quantity || 0,
          }] : [],
        }))));
    } else {
      api.get("/picking-notes/next-no").then((r) => { setPnNo(r.data.next_pn_no); setPnDate(r.data.pn_date); })
        .catch(() => toast.error("Could not preview picking-note number"));
      api.get("/issue-notes", { params: { not_status: "COMPLETE", page_size: 100 } })
        .then((r) => setPendingIns(r.data || []));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, editing]);

  const handleInChange = async (id) => {
    setSelectedInId(id);
    if (!id) { setItems([]); setAssignedToName(""); return; }
    const inn = pendingIns.find((x) => x.id === id);
    setAssignedToName(inn?.assigned_to_name || "");
    try {
      const { data } = await api.get(`/picking-notes/prepare/${id}`);
      setItems((data.items || []).map((it) => ({ ...it, ...locSelKeys(it), rejected_qty: 0, row_status: "Assigned" })));
    } catch (err) { toast.error(formatApiError(err.response?.data?.detail) || "Could not prepare items"); }
  };

  const updateItem = (i, patch) => setItems((p) => p.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  // The Issue Note's godown preference is a SUGGESTION, not a lock: the picker resolves
  // the real location here, one level at a time, from whatever currently holds stock for
  // this part/make. Whatever is chosen is what gets recorded, printed and previewed.
  const godownOptions = (row) => {
    const seen = new Set();
    return (row.available_locations || []).filter((L) => {
      const id = L.godown_id || "";
      if (!id || seen.has(id)) return false;   // stock with no godown can't be picked
      seen.add(id);
      return true;
    });
  };
  const rackOptions = (row) => {
    const seen = new Set();
    return (row.available_locations || [])
      .filter((L) => (L.godown_id || "") === (row.godown_id || ""))
      .filter((L) => {
        const id = L.rack_id || "";
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
  };
  const boxOptions = (row) => (row.available_locations || []).filter(
    (L) => (L.godown_id || "") === (row.godown_id || "") && (L.rack_id || "") === (row.rack_id || ""),
  );

  // There is nothing to choose when the only thing on offer is "none" — a godown with no
  // racking, or a rack with no boxes. Those cells render as a plain "—" instead of a
  // dropdown that demands an answer the warehouse cannot give.
  const rackChoiceExists = (row) => {
    const opts = rackOptions(row);
    return opts.length > 1 || opts.some((L) => L.rack_id);
  };
  const boxChoiceExists = (row) => {
    const opts = boxOptions(row);
    return opts.length > 1 || opts.some((L) => L.box_id);
  };

  // Picking a level clears everything below it, then auto-resolves any level that has
  // only one possible answer — so a single-rack/single-box godown needs just one click.
  const onGodownSelect = (i, godownId) => {
    const row = items[i];
    const patch = {
      godown_id: godownId,
      godown_name: (row.available_locations || []).find((L) => L.godown_id === godownId)?.godown_name || "",
      rack_id: "", rack_no: "", box_id: "", box_no: "", box_category: "",
      rack_sel: "", box_sel: "", quantity: "",
    };
    const racks = rackOptions({ ...row, godown_id: godownId });
    if (racks.length === 1) {
      patch.rack_id = racks[0].rack_id || "";
      patch.rack_no = racks[0].rack_no || "";
      patch.rack_sel = racks[0].rack_id || NO_RACK;
      const boxes = boxOptions({ ...row, godown_id: godownId, rack_id: racks[0].rack_id });
      if (boxes.length === 1) {
        patch.box_id = boxes[0].box_id || "";
        patch.box_no = boxes[0].box_no || "";
        patch.box_category = boxes[0].box_category || "";
        patch.box_sel = boxes[0].box_id || NO_BOX;
      }
    }
    updateItem(i, patch);
  };
  const onRackSelect = (i, rackKey) => {
    const row = items[i];
    const rack = rackOptions(row).find((L) => (L.rack_id || NO_RACK) === rackKey);
    if (!rack) return;
    const patch = {
      rack_id: rack.rack_id || "", rack_no: rack.rack_no || "", rack_sel: rackKey,
      box_id: "", box_no: "", box_category: "", box_sel: "", quantity: "",
    };
    const boxes = boxOptions({ ...row, rack_id: rack.rack_id || "" });
    if (boxes.length === 1) {
      patch.box_id = boxes[0].box_id || "";
      patch.box_no = boxes[0].box_no || "";
      patch.box_category = boxes[0].box_category || "";
      patch.box_sel = boxes[0].box_id || NO_BOX;
    }
    updateItem(i, patch);
  };
  const onBoxSelect = (i, boxKey) => {
    const row = items[i];
    const box = boxOptions(row).find((L) => (L.box_id || NO_BOX) === boxKey);
    if (!box) return;
    updateItem(i, {
      box_id: box.box_id || "", box_no: box.box_no || "",
      box_category: box.box_category || "", box_sel: boxKey,
    });
  };

  // A row is pickable only once all three levels have been chosen AND they resolve to a
  // real stock location.
  const locationResolved = (row) => (
    !!row.godown_id && !!row.rack_sel && !!row.box_sel
    && (row.available_locations || []).some((L) => locOnlyKey(L) === locOnlyKey(row))
  );

  // Split an item across another location: append a fresh row for the same part/make
  // (qty starts blank) so the picker can partially pick the suggestion and take the
  // remainder from somewhere else, without being forced to choose just one location.
  const addLocationRow = (i) => {
    const row = items[i];
    setItems((prev) => {
      const copy = [...prev];
      copy.splice(i + 1, 0, {
        ...row, quantity: "",
        godown_id: "", godown_name: "", rack_id: "", rack_no: "", box_id: "", box_no: "", box_category: "",
        rack_sel: "", box_sel: "",
        row_status: "Assigned", allocated_qty: 0, suggested: false, manual: true,
      });
      return copy;
    });
  };
  const removeLocationRow = (i) => setItems((prev) => prev.filter((_, idx) => idx !== i));

  // Issued Qty for THIS row's line — read-only, and per line so two lines of the same
  // part keep their own 15 and 5 instead of sharing one number. It is a target, not a
  // limit: the picker may take more (an Extra). `null` = open line (the office left the
  // quantity to the store incharge), displayed blank.
  const rowIssued = (row) => (row.open_quantity ? null : (row.requested_qty ?? null));
  // Live "available here" per row, netting out what other rows in this same form
  // already claim at the identical location (server does the authoritative check).
  const availableAtRow = (row, idx) => {
    const loc = (row.available_locations || []).find((L) => locOnlyKey(L) === locOnlyKey(row));
    if (!loc) return 0;
    const claimedElsewhere = items.reduce((sum, r, ri) => {
      if (ri === idx || r.part_no !== row.part_no || r.make !== row.make) return sum;
      return locOnlyKey(r) === locOnlyKey(row) ? sum + (parseInt(r.quantity) || 0) : sum;
    }, 0);
    return Math.max(0, (loc.current_qty || 0) - claimedElsewhere);
  };

  // Rows created by "+ Split" share their Issue Note line with the row they came from,
  // so Issued is a budget for the LINE, not for one row. Everything below is therefore
  // computed over all rows of the same line.
  const lineKey = (row) => (row.line_no != null ? `L${row.line_no}` : `K${pickingKey(row)}`);
  const linePicked = (rows, row) => rows.reduce(
    (sum, r) => (lineKey(r) === lineKey(row) ? sum + (parseInt(r.quantity) || 0) : sum), 0,
  );
  // Rejecting is a decision about the LINE, not about one shelf, so it is entered once
  // (on the line's first row) and summed the same way picking is.
  const lineRejected = (rows, row) => rows.reduce(
    (sum, r) => (lineKey(r) === lineKey(row) ? sum + (parseInt(r.rejected_qty) || 0) : sum), 0,
  );
  // The line's whole arithmetic in one place — the same function every other view uses.
  const lineQtys = (rows, row) => stockOutQtys(rowIssued(row), linePicked(rows, row), lineRejected(rows, row));

  // Pending, Rejected and Extra describe the LINE, so they are shown once per line — on
  // its first row — rather than repeated identically on every split row of the same line.
  const lineHeadIdx = useMemo(() => {
    const m = {};
    items.forEach((r, i) => {
      const k = r.line_no != null ? `L${r.line_no}` : `K${pickingKey(r)}`;
      if (!(k in m)) m[k] = i;
    });
    return m;
  }, [items]);

  // Picked Qty is clamped to what is physically at the chosen location — the picker may
  // freely go above or below the issued quantity, but never above real stock. Under
  // leaves a Pending quantity that rolls into a follow-up note; over is an Extra and
  // simply stands.
  //
  // Raising Picked above Issued also clears any Rejected on the line: Reject is only
  // legal while Extra is 0, and silently leaving a stale number behind for the server to
  // refuse would be worse than resetting the field the rule has just disabled.
  const onPickedQtyChange = (idx, raw) => {
    const n = raw === "" ? null : parseInt(raw, 10);
    if (raw !== "" && (isNaN(n) || n < 0)) return;
    const cap = availableAtRow(items[idx], idx);
    const next = raw === "" ? "" : String(Math.min(n, cap));
    const row = items[idx];
    const after = items.map((r, i) => (i === idx ? { ...r, quantity: next } : r));
    if (lineQtys(after, row).extra > 0) {
      const lk = lineKey(row);
      setItems(after.map((r) => (lineKey(r) === lk ? { ...r, rejected_qty: 0 } : r)));
      return;
    }
    updateItem(idx, { quantity: next });
  };

  // Rejected Qty — the second and only other input. Bounded by what is still outstanding
  // on the line (Issued − Picked), because rejecting is refusing the remainder, not
  // refusing stock that has already been picked. Blocked outright once the line is over-
  // picked; an open line has no target to measure against, so only the stock rules apply.
  const onRejectedQtyChange = (idx, raw) => {
    const n = raw === "" ? null : parseInt(raw, 10);
    if (raw !== "" && (isNaN(n) || n < 0)) return;
    const row = items[idx];
    const q = lineQtys(items, row);
    if (q.extra > 0) return;   // input is disabled in this state; ignore stray writes
    if (raw === "") { updateItem(idx, { rejected_qty: "" }); return; }
    const outstanding = q.issued == null ? n : Math.max(0, q.issued - q.picked);
    updateItem(idx, { rejected_qty: String(Math.min(n, outstanding)) });
  };

  const save = async () => {
    if (!selectedInId) { toast.error("Select an Issue Note"); return; }
    if (items.length === 0) { toast.error("No items to pick"); return; }
    // Every Issue Note line is sent, including any picked as 0 — a 0 is a real answer
    // ("this line was covered elsewhere / not taken") and the row must survive the save
    // instead of collapsing away. Only empty manual split rows are dropped as noise.
    const pickRows = items.filter((it) => (parseInt(it.quantity) || 0) > 0 || (parseInt(it.rejected_qty) || 0) > 0 || !it.manual);
    // Rejecting the whole quantity is a valid answer — it settles the request without
    // stock moving — so a note that only rejects is a legitimate note to save.
    if (!items.some((it) => (parseInt(it.quantity) || 0) > 0 || (parseInt(it.rejected_qty) || 0) > 0)) {
      toast.error("Enter a Picked Qty or a Rejected Qty on at least one row");
      return;
    }
    // Reject is only legal while Extra is 0. The input is disabled in that state, so this
    // is the belt-and-braces check against a stale value surviving an edit.
    for (const it of items) {
      const q = lineQtys(items, it);
      if (q.extra > 0 && q.rejected > 0) {
        toast.error(`${it.part_no} / ${it.make}: Rejected Qty must be 0 — ${q.picked} was picked against ${q.issued} issued`);
        return;
      }
    }
    for (let i = 0; i < pickRows.length; i++) {
      const rowNo = items.indexOf(pickRows[i]) + 1;
      const it = pickRows[i];
      const q = parseInt(it.quantity) || 0;
      if (q < 0) { toast.error(`Row ${rowNo}: quantity cannot be negative`); return; }
      if ((parseInt(it.rejected_qty) || 0) < 0) { toast.error(`Row ${rowNo}: Rejected Qty cannot be negative`); return; }
      if (q === 0) continue;   // nothing leaves the shelf — no location needed
      // All three levels must be settled, but "settled" means chosen from what actually
      // exists: a godown with no racking settles its rack/box as "none", which is a valid
      // answer — hence the *_sel keys rather than the raw ids.
      if (!it.godown_id) { toast.error(`Row ${rowNo}: Godown is required`); return; }
      if (!it.rack_sel) { toast.error(`Row ${rowNo}: Rack is required`); return; }
      if (!it.box_sel) { toast.error(`Row ${rowNo}: Box is required`); return; }
      if (!locationResolved(it)) { toast.error(`Row ${rowNo}: choose a location that holds stock`); return; }
      // Real stock is the only ceiling — picking more or less than requested is fine.
      const availHere = availableAtRow(it, items.indexOf(it));
      if (q > availHere + 1e-6) {
        toast.error(`Row ${rowNo}: only ${availHere} available at ${it.godown_name || "—"}/${it.rack_no || "—"}/${it.box_no || "—"}`);
        return;
      }
    }

    setSaving(true);
    try {
      const payload = {
        issue_note_id: selectedInId,
        narration,
          items: pickRows.map((it) => ({
          part_no: it.part_no, make: it.make, line_no: it.line_no ?? null,
          quantity: parseInt(it.quantity) || 0,
          rejected_qty: parseInt(it.rejected_qty) || 0,
          model: it.model || "", old_part_no: it.old_part_no || "", make_part_no: it.make_part_no || "",
          description_1: it.description_1 || "", description_2: it.description_2 || "",
          remarks_oem: it.remarks_oem || "", remarks_others: it.remarks_others || "",
          item_category: it.item_category || "",
          godown_id: it.godown_id || "", godown_name: it.godown_name || "",
          rack_id: it.rack_id || "", rack_no: it.rack_no || "",
          box_id: it.box_id || "", box_no: it.box_no || "", box_category: it.box_category || "",
        })),
      };
      const { data } = isEdit
        ? await api.put(`/picking-notes/${editing.id}`, payload)
        : await api.post("/picking-notes", payload);
      toast.success(`Picking Note ${data.pn_no} ${isEdit ? "updated" : "saved"}`);
      onSaved();
    } catch (err) { toast.error(formatApiError(err.response?.data?.detail) || "Could not save"); }
    finally { setSaving(false); }
  };

  return (
    <div className="mt-4 space-y-6" data-testid="pn-create-view">
      <div className="flex items-center justify-between">
        <Button onClick={onCancel} variant="outline" className="rounded-sm border-slate-300" data-testid="pn-back-button">
          <ArrowLeft size={14} weight="bold" className="mr-2" /> Back to list
        </Button>
        <Button onClick={save} disabled={saving} className="rounded-sm bg-blue-700 hover:bg-blue-800" data-testid="pn-save-button">
          <FloppyDisk size={14} weight="bold" className="mr-2" /> {saving ? "Saving…" : (isEdit ? "Update Picking Note" : "Save Picking Note")}
        </Button>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm p-6 grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div>
          <Label className="label-sm">Picking Note Date</Label>
          <Input value={pnDate} disabled className="mt-2 rounded-sm font-mono bg-slate-50" data-testid="pn-date-input" />
        </div>
        <div>
          <Label className="label-sm">Picking Note No</Label>
          <Input value={pnNo} disabled className="mt-2 rounded-sm font-mono font-semibold bg-blue-50 text-blue-900" data-testid="pn-no-input" />
        </div>
        <div>
          <Label className="label-sm">Issue Note *</Label>
          <Select value={selectedInId || undefined} onValueChange={handleInChange} disabled={isEdit}>
            <SelectTrigger className="mt-2 rounded-sm" data-testid="pn-in-select">
              <SelectValue placeholder={pendingIns.length === 0 ? "No issue notes pending" : "Select issue note"} />
            </SelectTrigger>
            <SelectContent>
              {pendingIns.map((inn) => (
                <SelectItem key={inn.id} value={inn.id} data-testid={`pn-in-option-${inn.in_no}`}>
                  <span className="font-mono">{inn.in_no}</span><span className="ml-3 text-slate-500 text-xs">{fmtDate(inn.in_date)} · {inn.assigned_to_name || "—"}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="label-sm">Assigned To</Label>
          <Input value={assignedToName} disabled className="mt-2 rounded-sm bg-slate-50" data-testid="pn-assigned-to" />
        </div>
        {/* The picker's own note — why a line came up short, whose shelf the stock was
            really found on, who approved an over-pick. Kept separate from the Issue
            Note's narration, which is the office's instruction and is never overwritten. */}
        <div className="col-span-2 lg:col-span-4">
          <Label className="label-sm">Narration</Label>
          <textarea
            value={narration}
            onChange={(e) => setNarration(e.target.value)}
            rows={2}
            placeholder="Anything worth recording about this pick — shortages, substitutions, who authorised an over-pick…"
            className="mt-2 w-full rounded-sm border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600/30 focus:border-blue-600"
            data-testid="pn-narration-input"
          />
        </div>
      </div>

      {items.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-sm overflow-x-auto">
          <div className="px-4 pt-3 text-xs text-slate-500">
            Enter <span className="font-bold">Picked</span> and <span className="font-bold text-red-700">Rejected</span> only — the rest is worked out.
            Picking is capped at <span className="font-bold">Available</span>.
            <span className="font-bold text-amber-700"> −qty</span> is pending and rolls into a new Picking Note;
            <span className="font-bold text-emerald-700"> +qty</span> is extra taken.
          </div>
          {/* `data-table-wrap-head` (index.css): the plain fixed-table rules clip any
              header wider than its column instead of showing it, which is what hid
              "PENDING / EXTRA" and "SL NO" outright. It lets long labels wrap and adds
              the spacing between columns. */}
          <table className="data-table data-table-fixed data-table-wrap-head w-full text-xs min-w-[1720px]">
            <colgroup>
              <col style={{ width: "64px" }} />
              <col style={{ width: "100px" }} />
              <col style={{ width: "118px" }} />
              <col style={{ width: "92px" }} />
              {/* Fixed rather than auto: an unconstrained `<col />` on a fixed-layout
                  table absorbs every pixel of slack left over from the other columns,
                  which is what stretched a huge gap in after Description. Truncation +
                  the row's `title` attribute still cover a longer description. */}
              <col style={{ width: "220px" }} />
              <col style={{ width: "112px" }} />
              <col style={{ width: "130px" }} />
              <col style={{ width: "100px" }} />
              <col style={{ width: "100px" }} />
              {/* The five quantity columns: two read-only, two inputs, one derived.
                  Each is wide enough for its own header at the padding set above, so
                  nothing has to be abbreviated to fit. */}
              <col style={{ width: "104px" }} />
              <col style={{ width: "120px" }} />
              <col style={{ width: "108px" }} />
              <col style={{ width: "120px" }} />
              <col style={{ width: "140px" }} />
              {/* Two 28px icon buttons (split + delete) plus cell padding — 64px clipped
                  the delete button on added rows. */}
              <col style={{ width: "88px" }} />
            </colgroup>
            <thead>
              <tr>
                <th>SL NO</th>
                <th>MODEL</th>
                <th>PART NO</th>
                <th>MAKE</th>
                <th>DESCRIPTION</th>
                <th>CATEGORY</th>
                <th>GODOWN</th>
                <th>RACK</th>
                <th>BOX</th>
                <th>ISSUED</th>
                <th>AVAILABLE</th>
                <th>PICKED</th>
                <th>REJECTED</th>
                <th>PENDING / EXTRA</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => {
                const issued = rowIssued(it);
                const noStockAtAll = (it.available_locations || []).length === 0;
                const resolved = locationResolved(it);
                const availHere = availableAtRow(it, idx);
                const q = parseInt(it.quantity) || 0;
                // Line-level arithmetic: split rows share one Issue Note line, so Pending,
                // Rejected and Extra are computed over the whole line and shown (and, for
                // Rejected, entered) once, on its first row.
                const lineHead = lineHeadIdx[lineKey(it)] === idx;
                const line = lineQtys(items, it);
                return (
                  <tr key={idx} data-testid={`pn-item-row-${idx}`} className={noStockAtAll ? "bg-amber-50" : ""}>
                    <td className="font-mono text-slate-500 align-middle">{idx + 1}</td>
                    <td className="font-mono text-slate-600 align-middle truncate" title={it.model || ""}>{it.model || "—"}</td>
                    <td className="align-middle"><PartNoLink partNo={it.part_no} make={it.make} /></td>
                    <td className="align-middle truncate" title={it.make}>{it.make}</td>
                    <td className="text-slate-700 align-middle truncate" title={it.description_1}>{it.description_1 || "—"}</td>
                    <td className="text-slate-600 align-middle truncate" title={it.item_category || ""}>{it.item_category || "—"}</td>
                    <td className="align-middle">
                      {noStockAtAll ? (
                        <span className="text-[11px] text-amber-700 italic">
                          No stock{it.unallocated_shortfall ? ` (short ${it.unallocated_shortfall})` : ""}
                        </span>
                      ) : (
                        <>
                          <Select value={it.godown_id || undefined} onValueChange={(v) => onGodownSelect(idx, v)}>
                            <SelectTrigger className="rounded-sm h-8 w-full text-xs [&>span]:truncate" data-testid={`pn-godown-${idx}`}>
                              <SelectValue placeholder="Godown *" />
                            </SelectTrigger>
                            <SelectContent>
                              {godownOptions(it).map((L) => (
                                <SelectItem key={L.godown_id} value={L.godown_id} data-testid={`pn-godown-${idx}-option-${L.godown_id}`}>
                                  <span className="font-mono">{L.godown_name}</span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {it.suggested && <div className="text-[10px] font-bold text-blue-700 mt-0.5 leading-tight">Suggested</div>}
                        </>
                      )}
                    </td>
                    <td className="align-middle">
                      {!noStockAtAll && it.godown_id && !rackChoiceExists(it) ? (
                        <span className="text-slate-400 font-mono" title="This godown has no racking" data-testid={`pn-rack-${idx}-none`}>—</span>
                      ) : !noStockAtAll && (
                        <Select value={it.rack_sel || undefined} disabled={!it.godown_id}
                          onValueChange={(v) => onRackSelect(idx, v)}>
                          <SelectTrigger className="rounded-sm h-8 w-full text-xs [&>span]:truncate" data-testid={`pn-rack-${idx}`}>
                            <SelectValue placeholder={it.godown_id ? "Rack *" : "—"} />
                          </SelectTrigger>
                          <SelectContent>
                            {rackOptions(it).map((L) => (
                              <SelectItem key={L.rack_id || NO_RACK} value={L.rack_id || NO_RACK} data-testid={`pn-rack-${idx}-option-${L.rack_id || NO_RACK}`}>
                                <span className="font-mono">{L.rack_no || "(no rack)"}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </td>
                    <td className="align-middle">
                      {!noStockAtAll && it.rack_sel && !boxChoiceExists(it) ? (
                        <span className="text-slate-400 font-mono" title="This location has no boxes" data-testid={`pn-box-${idx}-none`}>—</span>
                      ) : !noStockAtAll && (
                        <Select value={it.box_sel || undefined}
                          disabled={!it.rack_sel}
                          onValueChange={(v) => onBoxSelect(idx, v)}>
                          <SelectTrigger className="rounded-sm h-8 w-full text-xs [&>span]:truncate" data-testid={`pn-box-${idx}`}>
                            <SelectValue placeholder={it.rack_sel ? "Box *" : "—"} />
                          </SelectTrigger>
                          <SelectContent>
                            {boxOptions(it).map((L) => (
                              <SelectItem key={L.box_id || NO_BOX} value={L.box_id || NO_BOX} data-testid={`pn-box-${idx}-option-${L.box_id || NO_BOX}`}>
                                <span className="font-mono">{L.box_no || "(no box)"}</span>
                                <span className="ml-2 text-xs text-slate-500">avail {L.current_qty}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </td>
                    {/* Issued — read-only, blank when the office left the line open. */}
                    <td className="text-left font-mono font-bold text-slate-700 align-middle" data-testid={`pn-issued-${idx}`}>
                      {issued == null || issued === 0 ? "" : issued}
                    </td>
                    {/* Available — read-only and LIVE: the total currently on the shelf for
                        this part/make, which is the real ceiling on Picked Qty. When it has
                        dropped below Issued, the picker takes what is there and the rest
                        stays Pending for a follow-up note. */}
                    <td className="text-left font-mono align-middle" data-testid={`pn-available-${idx}`}>
                      <span className={(it.available_qty ?? 0) < (issued ?? 0) ? "font-bold text-amber-700" : "text-slate-600"}
                        title={(it.available_qty ?? 0) < (issued ?? 0)
                          ? `Only ${it.available_qty ?? 0} in stock against ${issued} issued — pick what is there; the rest stays Pending`
                          : "Live stock across every location holding this item"}>
                        {it.available_qty ?? 0}
                      </span>
                    </td>
                    <td className="align-middle">
                      <Input type="number" min="0" step="1" max={availHere || undefined} value={it.quantity}
                        disabled={noStockAtAll || !resolved}
                        onChange={(e) => onPickedQtyChange(idx, e.target.value)}
                        title={noStockAtAll ? "Nothing on the shelf for this item"
                          : (!resolved ? "Select Godown, Rack and Box first" : `Up to ${availHere} available at this location`)}
                        className="rounded-sm font-mono h-8 text-left w-full px-2"
                        data-testid={`pn-qty-${idx}`} />
                      {/* Fixed-height hint so rows never change height as quantities change. */}
                      <div className={`h-[14px] leading-[14px] text-[10px] mt-0.5 text-left overflow-hidden whitespace-nowrap text-ellipsis ${
                        noStockAtAll ? "invisible" : (!resolved ? "text-slate-400" : (q === availHere && availHere > 0 ? "text-amber-600 font-bold" : "text-slate-500"))
                      }`} data-testid={`pn-avail-hint-${idx}`}>
                        {!resolved ? "Pick location" : (q === availHere && availHere > 0 ? `Max ${availHere}` : `Avail ${availHere}`)}
                      </div>
                    </td>
                    {/* Rejected — the picker's second and last input, entered once per
                        line. Refusing the outstanding quantity settles it with no stock
                        movement and no follow-up note; rejecting the whole outstanding
                        amount is how a note that can never be picked is written off.
                        Disabled the moment the line runs an Extra: there is then nothing
                        outstanding left to refuse. */}
                    <td className="text-left align-middle" data-testid={`pn-rejected-${idx}`}>
                      {!lineHead ? <span className="text-slate-300">·</span> : (
                        <>
                          <Input type="number" min="0" step="1" value={it.rejected_qty ?? ""}
                            disabled={line.extra > 0}
                            onChange={(e) => onRejectedQtyChange(idx, e.target.value)}
                            title={line.extra > 0
                              ? `Reject unavailable — ${line.picked} picked against ${line.issued} issued leaves nothing outstanding to refuse`
                              : (line.issued == null ? "Open line — reject as much as is being refused"
                                : `Up to ${Math.max(0, line.issued - line.picked)} outstanding on this line`)}
                            className={`rounded-sm font-mono h-8 text-left w-full px-2 ${line.extra > 0 ? "bg-slate-100 text-slate-400" : ""}`}
                            data-testid={`pn-reject-input-${idx}`} />
                          <div className={`h-[14px] leading-[14px] text-[10px] mt-0.5 text-left overflow-hidden whitespace-nowrap text-ellipsis ${
                            line.extra > 0 ? "text-slate-400" : "invisible"
                          }`}>
                            Extra — N/A
                          </div>
                        </>
                      )}
                    </td>
                    {/* Pending / Extra — the two derived quantities in one signed column,
                        because they are the two directions of a single variance and can
                        never both be non-zero on a line:
                            −qty  short of what was issued, and rolls into a new Picking
                                  Note when this one is recorded (unless it is rejected)
                            +qty  taken over and above what was issued
                        Never typed, never negative in the underlying figures — the sign
                        here is presentation, so one glance says which way the line went. */}
                    <td className="text-left align-middle" data-testid={`pn-variance-${idx}`}>
                      {!lineHead ? <span className="text-slate-300">·</span>
                        : line.extra > 0 ? (
                          <span className="font-mono font-bold text-emerald-700" title={`Extra — ${line.extra} taken over the ${line.issued} issued`}>
                            +{line.extra}
                          </span>
                        ) : line.pending == null ? <span className="text-slate-400">—</span>
                        : line.pending > 0 ? (
                          <span className="font-mono font-bold text-amber-700" title={`Pending — ${line.pending} still outstanding (Issued − Picked − Rejected). Carries into a new Picking Note when this one is recorded`}>
                            −{line.pending}
                          </span>
                        ) : <span className="font-mono text-slate-400" title="Fully settled — nothing pending, nothing extra">0</span>}
                    </td>
                    <td className="align-middle">
                      <div className="flex items-center gap-1 h-8 whitespace-nowrap">
                        <button type="button" onClick={() => addLocationRow(idx)} title="Add a row for this item at another location"
                          className="p-1.5 rounded-sm shrink-0 hover:bg-blue-50 text-blue-700" data-testid={`pn-split-row-${idx}`}>
                          <Plus size={14} />
                        </button>
                        {/* Only rows the picker added here can be deleted — the Issue
                            Note's own lines have to stay on the note. */}
                        <button type="button" onClick={() => removeLocationRow(idx)}
                          disabled={!it.manual}
                          onKeyDown={(e) => {
                            // End of the last row — the Save button sits above the table
                            // in DOM order, so forward Tab would otherwise leave the form.
                            if (e.key === "Tab" && !e.shiftKey && idx === items.length - 1) {
                              e.preventDefault();
                              document.querySelector('[data-testid="pn-save-button"]')?.focus();
                            }
                          }}
                          title={it.manual ? "Delete this added row" : "Issue Note lines cannot be deleted — set Picked Qty to 0 instead"}
                          className={`p-1.5 rounded-sm shrink-0 ${it.manual ? "hover:bg-red-50 text-red-700" : "text-slate-300 cursor-not-allowed"}`}
                          data-testid={`pn-remove-row-${idx}`}>
                          <Trash size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!selectedInId && !isEdit && (
        <div className="bg-amber-50 border border-amber-200 rounded-sm p-6 text-sm text-amber-800">
          Pick an Issue Note above to load its items for picking.
        </div>
      )}
    </div>
  );
}
