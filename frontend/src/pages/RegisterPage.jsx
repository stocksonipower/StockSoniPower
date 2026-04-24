import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { formatApiError } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Package } from "@phosphor-icons/react";

export default function RegisterPage() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await register(form.email, form.password, form.name);
      nav("/");
    } catch (err) {
      setError(formatApiError(err.response?.data?.detail) || err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-6" data-testid="register-page">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-sm p-8">
        <div className="flex items-center gap-3 mb-8">
          <div className="h-10 w-10 bg-slate-900 flex items-center justify-center rounded-sm">
            <Package size={22} weight="bold" className="text-white" />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] font-bold text-slate-500">Stock Master</div>
            <div className="font-bold text-slate-900">Create Account</div>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-5">
          <div>
            <Label className="label-sm">Name</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="mt-2 rounded-sm"
              required
              data-testid="register-name-input"
            />
          </div>
          <div>
            <Label className="label-sm">Email</Label>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="mt-2 rounded-sm"
              required
              data-testid="register-email-input"
            />
          </div>
          <div>
            <Label className="label-sm">Password</Label>
            <Input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="mt-2 rounded-sm"
              required
              minLength={6}
              data-testid="register-password-input"
            />
          </div>
          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-sm" data-testid="register-error">
              {error}
            </div>
          )}
          <Button
            type="submit"
            disabled={loading}
            className="w-full rounded-sm bg-blue-700 hover:bg-blue-800 text-white font-semibold h-11"
            data-testid="register-submit-button"
          >
            {loading ? "Creating…" : "Create Account"}
          </Button>
        </form>

        <div className="mt-6 text-sm text-slate-600 text-center">
          Already have an account?{" "}
          <Link to="/login" className="font-semibold text-blue-700 hover:underline" data-testid="login-link">
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
