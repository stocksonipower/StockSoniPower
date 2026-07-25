import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api } from "./api";

const AuthContext = createContext(null);

function getCachedUser() {
  try {
    const token = localStorage.getItem("token");
    const raw = localStorage.getItem("user");
    if (token && raw) return JSON.parse(raw);
  } catch {}
  return null;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(getCachedUser);
  // Skip the loading spinner when we already have a cached session —
  // the background validation will redirect to login if the token is truly invalid.
  const [loading, setLoading] = useState(() => !getCachedUser());

  const refresh = useCallback(async () => {
    const token = localStorage.getItem("token");
    if (!token) { setUser(null); return null; }
    try {
      const { data } = await api.get("/auth/me");
      setUser(data);
      localStorage.setItem("user", JSON.stringify(data));
      return data;
    } catch (err) {
      // Only destroy the session when the server explicitly rejects the token.
      // Network failures / 5xx errors are transient — don't log the user out.
      const status = err?.response?.status;
      if (status === 401 || status === 403) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        setUser(null);
      }
      return null;
    }
  }, []);

  useEffect(() => { refresh().finally(() => setLoading(false)); }, [refresh]);

  // Cross-tab logout: if another tab clears the token, clear this tab too.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === "token" && !e.newValue) {
        setUser(null);
        localStorage.removeItem("user");
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const login = async (email, password) => {
    const { data } = await api.post("/auth/login", { email, password });
    localStorage.setItem("token", data.token);
    localStorage.setItem("user", JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  };

  const logout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setUser(null);
  };

  const isAdmin = user?.role === "admin";
  const canAccess = (mod) => {
    if (!user) return false;
    if (user.role === "admin") return true;
    const access = user.module_access || {};
    return access[mod] !== false; // default true if missing
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh, isAdmin, canAccess }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
