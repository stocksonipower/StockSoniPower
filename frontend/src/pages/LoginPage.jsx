import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { formatApiError } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Package, SignIn } from "@phosphor-icons/react";

export default function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("admin@stockmgmt.com");
  const [password, setPassword] = useState("admin123");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      nav("/");
    } catch (err) {
      setError(formatApiError(err.response?.data?.detail) || err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-white" data-testid="login-page">
      {/* Left: form */}
      <div className="flex items-center justify-center px-6 sm:px-12 py-12">
        <div className="w-full max-w-md">
          <div className="flex items-center gap-3 mb-10">
            <div className="h-10 w-10 bg-slate-900 flex items-center justify-center rounded-sm">
              <Package size={22} weight="bold" className="text-white" />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.2em] font-bold text-slate-500">Stock Master</div>
              <div className="font-bold text-slate-900">Warehouse Control</div>
            </div>
          </div>

          <h1 className="text-4xl font-black tracking-tight text-slate-900 mb-2">Sign In</h1>
          <p className="text-sm text-slate-600 mb-8">Enter your credentials to access the inventory system.</p>

          <form onSubmit={submit} className="space-y-5">
            <div>
              <Label htmlFor="email" className="label-sm">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-2 rounded-sm border-slate-300 focus-visible:ring-blue-700"
                required
                data-testid="login-email-input"
              />
            </div>
            <div>
              <Label htmlFor="password" className="label-sm">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-2 rounded-sm border-slate-300 focus-visible:ring-blue-700"
                required
                data-testid="login-password-input"
              />
            </div>
            {error && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-sm" data-testid="login-error">
                {error}
              </div>
            )}
            <Button
              type="submit"
              disabled={loading}
              className="w-full rounded-sm bg-blue-700 hover:bg-blue-800 text-white font-semibold h-11"
              data-testid="login-submit-button"
            >
              <SignIn size={18} weight="bold" className="mr-2" />
              {loading ? "Signing in…" : "Sign In"}
            </Button>
          </form>

          <div className="mt-6 text-sm text-slate-600">
            No account?{" "}
            <Link to="/register" className="font-semibold text-blue-700 hover:underline" data-testid="register-link">
              Create one
            </Link>
          </div>

          <div className="mt-10 p-4 bg-slate-50 border border-slate-200 rounded-sm">
            <div className="label-sm mb-1">Demo Credentials</div>
            <div className="text-xs font-mono text-slate-700">admin@stockmgmt.com / admin123</div>
          </div>
        </div>
      </div>

      {/* Right: warehouse image */}
      <div
        className="hidden lg:block relative bg-cover bg-center"
        style={{
          backgroundImage:
            "url('https://images.pexels.com/photos/14554082/pexels-photo-14554082.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940')",
        }}
      >
        <div className="absolute inset-0 bg-slate-900/50" />
        <div className="absolute bottom-0 left-0 right-0 p-12 text-white">
          <div className="text-[11px] uppercase tracking-[0.25em] font-bold text-blue-200 mb-3">
            Precision Inventory
          </div>
          <div className="text-3xl font-black tracking-tight max-w-md leading-tight">
            Every part, every rack, every box — accounted for.
          </div>
        </div>
      </div>
    </div>
  );
}
