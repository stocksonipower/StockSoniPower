import { createContext, useContext } from "react";

/**
 * Cross-tab navigation bus for the Stock In page. Lets a nested SRN/ERN/RKN
 * preview (opened from within the Receipt Note dialog) jump straight to
 * another linked document's EDIT form — switching the active tab and
 * populating that tab's edit state — instead of only opening another
 * read-only preview.
 */
export const StockInNavContext = createContext(null);

export function useStockInNav() {
  return useContext(StockInNavContext);
}
