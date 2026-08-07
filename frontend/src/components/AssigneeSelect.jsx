import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Label } from "./ui/label";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "./ui/select";
import { UserCircle } from "@phosphor-icons/react";
import { assigneeLabel, userLabel } from "../lib/assignee";

/**
 * Dropdown to assign a workflow note (Receipt Note / Issue Note) to a specific user.
 * `value` is the assigned user id (or "" / null = unassigned).
 * `module` is "stock_in" | "stock_out" — limits choices to users with that module enabled.
 */
const UNASSIGNED = "__unassigned__";

export default function AssigneeSelect({ label = "Assign To", value, onChange, module, testid }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get("/users/assignable", { params: module ? { module } : {} })
      .then(({ data }) => setUsers(data || []))
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }, [module]);

  const selectedValue = value || UNASSIGNED;

  return (
    <div data-testid={testid ? `${testid}-wrap` : undefined}>
      <Label className="label-sm flex items-center gap-1">
        <UserCircle size={12} weight="bold" /> {label}
      </Label>
      <Select
        value={selectedValue}
        onValueChange={(v) => onChange(v === UNASSIGNED ? "" : v)}
      >
        <SelectTrigger
          className="mt-2 rounded-sm h-9"
          data-testid={testid || "assignee-select"}
        >
          <SelectValue placeholder={loading ? "Loading…" : "Unassigned"} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNASSIGNED} data-testid={`${testid || "assignee"}-option-unassigned`}>
            <span className="text-slate-500 italic">— Unassigned (anyone) —</span>
          </SelectItem>
          {/* Users are chosen and shown by NAME. The email address is deliberately
              not rendered — it is the account identifier, not how anyone refers to
              a colleague, and what is picked here is what ends up on the note, its
              preview and its printed copy. */}
          {users.map((u) => (
            <SelectItem key={u.id} value={u.id} data-testid={`${testid || "assignee"}-option-${u.id}`}>
              <span className="font-semibold">{userLabel(u)}</span>
              {u.role === "admin" && <span className="ml-2 text-[10px] text-blue-700 font-bold">ADMIN</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="text-[11px] text-slate-500 mt-1">
        Only the assigned user (or an admin) can {module === "stock_in" ? "rack" : "pick"} this. Leave unassigned for anyone with module access.
      </div>
    </div>
  );
}

/** Compact, inline assignee chip for list rows / detail dialogs. Always a name. */
export function AssigneeBadge({ name, email, testid }) {
  if (!name && !email) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm bg-slate-100 text-slate-500" data-testid={testid}>
        <UserCircle size={10} weight="bold" /> Unassigned
      </span>
    );
  }
  const label = assigneeLabel(name, email, "Unassigned");
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm bg-violet-50 text-violet-800"
      title={label}
      data-testid={testid}
    >
      <UserCircle size={10} weight="bold" /> {label}
    </span>
  );
}
