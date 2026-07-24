import React from "react";
import { Link } from "react-router-dom";

/**
 * Renders a part-number cell that deep-links to /item-details?part_no=…&make=…
 * Used everywhere across the app (RN/SRN/ERN/RKN/IN/PN/STR/STN/Stock Balance/Low Stock/Transactions/etc.).
 *
 * Falls back to plain text if part_no is empty.
 */
export default function PartNoLink({ partNo, make, className = "", children, "data-testid": testId }) {
  const pn = (partNo || "").trim();
  const mk = (make || "").trim();
  if (!pn) return <span className={className}>—</span>;
  const href = `/item-details?part_no=${encodeURIComponent(pn)}${mk ? `&make=${encodeURIComponent(mk)}` : ""}`;
  return (
    <Link
      to={href}
      title={`View item details for ${pn}${mk ? ` / ${mk}` : ""}`}
      className={`font-mono font-semibold text-blue-700 hover:underline focus:underline ${className}`}
      data-testid={testId || `part-no-link-${pn}`}
    >
      {children || pn}
    </Link>
  );
}
