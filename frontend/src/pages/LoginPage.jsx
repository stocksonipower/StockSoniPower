import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { formatApiError } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { SignIn } from "@phosphor-icons/react";

export default function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
    <div className="min-h-screen flex items-center justify-center bg-slate-50" data-testid="login-page">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-sm p-8 shadow-sm">
        <div className="mb-8 text-center">
          <img src="/logo.png" alt="Soni Power" className="h-16 w-auto mx-auto mb-4" />
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Sign In</h1>
        </div>

        <form onSubmit={submit} className="space-y-5">
          <div>
            <Label htmlFor="email" className="label-sm">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter your email"
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
              placeholder="Enter your password"
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

        <div className="mt-6 text-center">
          <p className="text-xs text-slate-500">Contact Admin for access</p>
        </div>
      </div>
    </div>
  );
}