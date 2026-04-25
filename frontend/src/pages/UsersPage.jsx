import React, { useEffect, useMemo, useState } from "react";
import { api, formatApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "../components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "../components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import { toast } from "sonner";
import {
  Users, ArrowsClockwise, Plus, PencilSimple, Power, LockKey, ShieldCheck, ShieldWarning,
} from "@phosphor-icons/react";

const MODULE_LABELS = {
  stock_master: "Stock Master",
  locations: "Location Master",
  stock_in: "Stock In",
  stock_out: "Stock Out",
  stock_summary: "Stock Summary",
  low_stock: "Low Stock",
  transactions: "Transactions",
};
const MODULE_KEYS = Object.keys(MODULE_LABELS);

const fmtDate = (iso) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const mn = String(d.getMinutes()).padStart(2, "0");
    return `${dd}-${mm}-${yyyy} ${hh}:${mn}`;
  } catch { return "—"; }
};

const isLocked = (u) => {
  if (!u?.lockout_until) return false;
  try { return new Date(u.lockout_until) > new Date(); } catch { return false; }
};

export default function UsersPage() {
  const { user: me } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dlgOpen, setDlgOpen] = useState(false);
  const [editing, setEditing] = useState(null); // null = create
  const [confirm, setConfirm] = useState(null); // {action, user}

  const blank = useMemo(() => ({
    name: "", email: "", password: "", role: "staff",
    is_active: true,
    force_password_reset: true,
    module_access: Object.fromEntries(MODULE_KEYS.map((k) => [k, true])),
  }), []);
  const [form, setForm] = useState(blank);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/users");
      setRows(data);
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail) || "Failed to load users");
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm(blank);
    setDlgOpen(true);
  };

  const openEdit = (u) => {
    setEditing(u);
    setForm({
      name: u.name || "",
      email: u.email || "",
      password: "",
      role: u.role || "staff",
      is_active: u.is_active !== false,
      force_password_reset: !!u.force_password_reset,
      module_access: { ...Object.fromEntries(MODULE_KEYS.map((k) => [k, true])), ...(u.module_access || {}) },
    });
    setDlgOpen(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    try {
      if (editing) {
        const payload = {
          name: form.name.trim(),
          email: form.email.trim().toLowerCase(),
          role: form.role,
          is_active: form.is_active,
          module_access: form.module_access,
          force_password_reset: form.force_password_reset,
        };
        if (form.password) payload.password = form.password;
        await api.put(`/users/${editing.id}`, payload);
        toast.success("User updated");
      } else {
        if (!form.password || form.password.length < 6) {
          toast.error("Password must be at least 6 characters");
          return;
        }
        await api.post("/users", {
          name: form.name.trim(),
          email: form.email.trim().toLowerCase(),
          password: form.password,
          role: form.role,
          module_access: form.module_access,
          force_password_reset: form.force_password_reset,
        });
        toast.success("User created");
      }
      setDlgOpen(false);
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Save failed");
    }
  };

  const toggleActive = async (u) => {
    try {
      if (u.is_active === false) {
        await api.put(`/users/${u.id}`, { is_active: true });
        toast.success("User reactivated");
      } else {
        await api.delete(`/users/${u.id}`);
        toast.success("User deactivated");
      }
      load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail) || "Action failed");
    } finally { setConfirm(null); }
  };

  const resetLockout = async (u) => {
    try {
      // toggling is_active false->true is already an action; for lockout reset we re-set is_active=true (also clears in backend update)
      // Backend update_user clears lockout when setting is_active true. To force-clear without changing flag, set it again.
      await api.put(`/users/${u.id}`, { is_active: true });
      toast.success("Lockout cleared");
      load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail) || "Action failed");
    }
  };

  const allModulesOn = MODULE_KEYS.every((k) => form.module_access[k]);
  const toggleAllModules = () => {
    const next = !allModulesOn;
    setForm((f) => ({ ...f, module_access: Object.fromEntries(MODULE_KEYS.map((k) => [k, next])) }));
  };

  return (
    <div className="p-8 max-w-[1400px] mx-auto" data-testid="users-page">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-sm flex items-center justify-center bg-blue-50 text-blue-700">
            <Users size={24} weight="bold" />
          </div>
          <div>
            <div className="label-sm mb-1">Administration</div>
            <h1 className="text-4xl font-black tracking-tight text-slate-900">Users</h1>
            <p className="text-sm text-slate-600 mt-2">
              Create and manage warehouse staff accounts. Control which modules each user can access.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={load} variant="outline" className="rounded-sm border-slate-300" disabled={loading} data-testid="users-refresh-button">
            <ArrowsClockwise size={14} weight="bold" className={`mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button onClick={openCreate} className="rounded-sm bg-blue-700 hover:bg-blue-800 text-white" data-testid="users-new-button">
            <Plus size={14} weight="bold" className="mr-2" />
            New User
          </Button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-sm overflow-hidden">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Modules</th>
              <th>Last Login</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-12 text-slate-500">No users found.</td></tr>
            ) : rows.map((u) => {
              const locked = isLocked(u);
              const moduleCount = u.role === "admin"
                ? MODULE_KEYS.length
                : MODULE_KEYS.filter((k) => (u.module_access || {})[k] !== false).length;
              return (
                <tr key={u.id} data-testid={`user-row-${u.id}`}>
                  <td className="font-semibold text-slate-900">{u.name || "—"}</td>
                  <td className="font-mono text-xs text-slate-700">{u.email}</td>
                  <td>
                    <span className={`inline-block px-2 py-0.5 text-[10px] uppercase tracking-wide font-bold rounded-sm ${
                      u.role === "admin" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"
                    }`}>
                      {u.role}
                    </span>
                  </td>
                  <td>
                    {u.is_active === false ? (
                      <span className="inline-block px-2 py-0.5 text-[10px] uppercase tracking-wide font-bold rounded-sm bg-red-50 text-red-700 border border-red-200">Deactivated</span>
                    ) : locked ? (
                      <span className="inline-block px-2 py-0.5 text-[10px] uppercase tracking-wide font-bold rounded-sm bg-amber-50 text-amber-800 border border-amber-200">Locked</span>
                    ) : (
                      <span className="inline-block px-2 py-0.5 text-[10px] uppercase tracking-wide font-bold rounded-sm bg-emerald-50 text-emerald-700 border border-emerald-200">Active</span>
                    )}
                  </td>
                  <td className="text-xs text-slate-600">
                    {u.role === "admin" ? "All (admin)" : `${moduleCount} / ${MODULE_KEYS.length}`}
                  </td>
                  <td className="text-xs text-slate-700 font-mono">{fmtDate(u.last_login)}</td>
                  <td className="text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        onClick={() => openEdit(u)}
                        className="p-1.5 hover:bg-slate-100 rounded-sm text-slate-700"
                        title="Edit user"
                        data-testid={`user-edit-${u.id}`}
                      >
                        <PencilSimple size={14} weight="bold" />
                      </button>
                      {locked && (
                        <button
                          onClick={() => resetLockout(u)}
                          className="p-1.5 hover:bg-amber-50 rounded-sm text-amber-700"
                          title="Clear lockout"
                          data-testid={`user-unlock-${u.id}`}
                        >
                          <LockKey size={14} weight="bold" />
                        </button>
                      )}
                      {me?.id !== u.id && (
                        <button
                          onClick={() => setConfirm({ action: u.is_active === false ? "activate" : "deactivate", user: u })}
                          className={`p-1.5 hover:bg-slate-100 rounded-sm ${u.is_active === false ? "text-emerald-700" : "text-red-700"}`}
                          title={u.is_active === false ? "Reactivate" : "Deactivate"}
                          data-testid={`user-toggle-${u.id}`}
                        >
                          <Power size={14} weight="bold" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Create / Edit Dialog */}
      <Dialog open={dlgOpen} onOpenChange={setDlgOpen}>
        <DialogContent className="sm:max-w-2xl rounded-sm" data-testid="user-dialog">
          <DialogHeader>
            <DialogTitle className="text-2xl font-black tracking-tight">
              {editing ? "Edit User" : "New User"}
            </DialogTitle>
            <DialogDescription className="text-sm text-slate-600">
              {editing ? "Update account details, role, and module access." : "Create a new staff or admin account with controlled module access."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-5 pt-2">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="label-sm">Full Name</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="mt-2 rounded-sm border-slate-300"
                  required
                  data-testid="user-form-name"
                />
              </div>
              <div>
                <Label className="label-sm">Email</Label>
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="mt-2 rounded-sm border-slate-300"
                  required
                  data-testid="user-form-email"
                />
              </div>
              <div>
                <Label className="label-sm">Role</Label>
                <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
                  <SelectTrigger className="mt-2 rounded-sm border-slate-300" data-testid="user-form-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="staff">Staff</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="label-sm">
                  Password {editing && <span className="text-slate-400 normal-case font-normal">(leave blank to keep current)</span>}
                </Label>
                <Input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  className="mt-2 rounded-sm border-slate-300"
                  placeholder={editing ? "••••••••" : "Min 6 characters"}
                  data-testid="user-form-password"
                />
              </div>
            </div>

            <div className="flex items-center gap-6 pt-1">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={form.is_active}
                  onCheckedChange={(v) => setForm({ ...form, is_active: !!v })}
                  data-testid="user-form-active"
                />
                <span className="font-medium text-slate-800">Active</span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={form.force_password_reset}
                  onCheckedChange={(v) => setForm({ ...form, force_password_reset: !!v })}
                  data-testid="user-form-force-reset"
                />
                <span className="font-medium text-slate-800">Force password change on next login</span>
              </label>
            </div>

            <div className="border-t border-slate-200 pt-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="label-sm flex items-center gap-2">
                    {form.role === "admin" ? <ShieldCheck size={14} weight="bold" /> : <ShieldWarning size={14} weight="bold" />}
                    Module Access
                  </div>
                  {form.role === "admin" && (
                    <div className="text-xs text-slate-500 mt-1">Admins always have access to all modules.</div>
                  )}
                </div>
                {form.role !== "admin" && (
                  <button
                    type="button"
                    onClick={toggleAllModules}
                    className="text-xs font-semibold text-blue-700 hover:underline"
                    data-testid="user-form-toggle-all-modules"
                  >
                    {allModulesOn ? "Uncheck all" : "Check all"}
                  </button>
                )}
              </div>
              <div className={`grid grid-cols-2 sm:grid-cols-3 gap-2 ${form.role === "admin" ? "opacity-50 pointer-events-none" : ""}`}>
                {MODULE_KEYS.map((k) => (
                  <label key={k} className="flex items-center gap-2 text-sm cursor-pointer p-2 border border-slate-200 rounded-sm hover:bg-slate-50">
                    <Checkbox
                      checked={!!form.module_access[k]}
                      onCheckedChange={(v) =>
                        setForm({ ...form, module_access: { ...form.module_access, [k]: !!v } })
                      }
                      data-testid={`user-form-module-${k}`}
                    />
                    <span className="font-medium text-slate-800">{MODULE_LABELS[k]}</span>
                  </label>
                ))}
              </div>
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setDlgOpen(false)} className="rounded-sm border-slate-300" data-testid="user-form-cancel">
                Cancel
              </Button>
              <Button type="submit" className="rounded-sm bg-blue-700 hover:bg-blue-800 text-white" data-testid="user-form-submit">
                {editing ? "Save Changes" : "Create User"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Confirm activate/deactivate */}
      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent className="rounded-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.action === "activate" ? "Reactivate user?" : "Deactivate user?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.action === "activate"
                ? `${confirm?.user?.email} will be able to sign in again.`
                : `${confirm?.user?.email} will no longer be able to sign in. Their historic records remain intact.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-sm" data-testid="user-confirm-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => toggleActive(confirm.user)}
              className={`rounded-sm text-white ${confirm?.action === "activate" ? "bg-emerald-700 hover:bg-emerald-800" : "bg-red-700 hover:bg-red-800"}`}
              data-testid="user-confirm-action"
            >
              {confirm?.action === "activate" ? "Reactivate" : "Deactivate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
