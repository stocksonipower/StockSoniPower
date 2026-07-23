import React, { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, formatApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { toast } from "sonner";
import { UserCircle, Warning, FloppyDisk } from "@phosphor-icons/react";

export default function ProfilePage() {
  const { user, refresh } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const mustReset = !!user?.force_password_reset || new URLSearchParams(loc.search).get("reset") === "1";

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { setName(user?.name || ""); }, [user?.name]);

  const submit = async (e) => {
    e.preventDefault();
    if (password && password.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    if (password && password !== confirm) {
      toast.error("Passwords do not match");
      return;
    }
    if (mustReset && !password) {
      toast.error("You must set a new password to continue");
      return;
    }
    setSaving(true);
    try {
      const payload = {};
      if (name && name !== user?.name) payload.name = name.trim();
      if (password) payload.password = password;
      if (Object.keys(payload).length === 0) {
        toast.info("Nothing to save");
        setSaving(false);
        return;
      }
      await api.put("/auth/me", payload);
      toast.success("Profile updated");
      setPassword("");
      setConfirm("");
      const fresh = await refresh();
      if (mustReset && fresh && !fresh.force_password_reset) {
        nav("/", { replace: true });
      }
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail) || "Save failed");
    } finally { setSaving(false); }
  };

  if (!user) return null;

  return (
    <div className="p-8 max-w-2xl mx-auto" data-testid="profile-page">
      <div className="mb-6 flex items-center gap-4">
        <div className="h-12 w-12 rounded-sm flex items-center justify-center bg-slate-900 text-white">
          <UserCircle size={24} weight="bold" />
        </div>
        <div>
          <div className="label-sm mb-1">Account</div>
          <h1 className="text-4xl font-black tracking-tight text-slate-900">My Profile</h1>
        </div>
      </div>

      {mustReset && (
        <div className="mb-6 flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-sm" data-testid="force-reset-banner">
          <Warning size={20} weight="fill" className="text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold text-amber-900 text-sm">Password change required</div>
            <div className="text-xs text-amber-800 mt-1">
              Your administrator requires you to set a new password before continuing to use the system.
            </div>
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-sm p-6">
        <form onSubmit={submit} className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="label-sm">Email</Label>
              <Input
                value={user.email}
                disabled
                className="mt-2 rounded-sm border-slate-300 bg-slate-50 font-mono text-xs"
                data-testid="profile-email"
              />
            </div>
            <div>
              <Label className="label-sm">Role</Label>
              <Input
                value={user.role}
                disabled
                className="mt-2 rounded-sm border-slate-300 bg-slate-50 capitalize"
                data-testid="profile-role"
              />
            </div>
          </div>

          <div>
            <Label className="label-sm">Full Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-2 rounded-sm border-slate-300"
              required
              data-testid="profile-name"
            />
          </div>

          <div className="border-t border-slate-200 pt-5">
            <div className="label-sm mb-3">Change Password</div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="label-sm">New Password</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Min 6 characters"
                  className="mt-2 rounded-sm border-slate-300"
                  data-testid="profile-password"
                />
              </div>
              <div>
                <Label className="label-sm">Confirm Password</Label>
                <Input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="mt-2 rounded-sm border-slate-300"
                  data-testid="profile-password-confirm"
                />
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-2">
              Leave blank to keep your current password.
            </p>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              type="submit"
              disabled={saving}
              className="rounded-sm bg-blue-700 hover:bg-blue-800 text-white"
              data-testid="profile-save"
            >
              <FloppyDisk size={14} weight="bold" className="mr-2" />
              {saving ? "Saving…" : "Save Changes"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
