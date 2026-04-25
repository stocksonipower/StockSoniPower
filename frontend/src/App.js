import React from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import LoginPage from "./pages/LoginPage";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import StockMasterPage from "./pages/StockMasterPage";
import LocationsPage from "./pages/LocationsPage";
import StockInPage from "./pages/StockInPage";
import StockOutPage from "./pages/StockOutPage";
import StockBalancePage from "./pages/StockBalancePage";
import TransactionsPage from "./pages/TransactionsPage";
import LowStockPage from "./pages/LowStockPage";
import UsersPage from "./pages/UsersPage";
import ProfilePage from "./pages/ProfilePage";
import { Toaster } from "./components/ui/sonner";
import "./App.css";

function Protected({ children, module, adminOnly }) {
  const { user, loading, isAdmin, canAccess } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="min-h-screen flex items-center justify-center text-slate-500 text-sm">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  // Force reset: redirect anywhere except /profile itself (otherwise ProfilePage never renders)
  if (user.force_password_reset && loc.pathname !== "/profile") {
    return <Navigate to="/profile?reset=1" replace />;
  }
  if (adminOnly && !isAdmin) return <Layout><AccessDenied moduleName="Users" /></Layout>;
  if (module && !canAccess(module)) return <Layout><AccessDenied moduleName={module} /></Layout>;
  return <Layout>{children}</Layout>;
}

function AccessDenied({ moduleName }) {
  return (
    <div className="p-12 max-w-2xl mx-auto text-center" data-testid="access-denied">
      <div className="text-6xl font-black text-slate-300 mb-4">403</div>
      <h1 className="text-3xl font-black tracking-tight text-slate-900 mb-2">Access Denied</h1>
      <p className="text-slate-600">You don't have permission to view the <span className="font-mono font-semibold">{moduleName}</span> module. Contact your administrator if you need access.</p>
    </div>
  );
}

function Public({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) return <Navigate to="/" replace />;
  return children;
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Public><LoginPage /></Public>} />
          <Route path="/" element={<Protected><Dashboard /></Protected>} />
          <Route path="/profile" element={<Protected><ProfilePage /></Protected>} />
          <Route path="/users" element={<Protected adminOnly><UsersPage /></Protected>} />
          <Route path="/stock-master" element={<Protected module="stock_master"><StockMasterPage /></Protected>} />
          <Route path="/locations" element={<Protected module="locations"><LocationsPage /></Protected>} />
          <Route path="/stock-in" element={<Protected module="stock_in"><StockInPage /></Protected>} />
          <Route path="/stock-out" element={<Protected module="stock_out"><StockOutPage /></Protected>} />
          <Route path="/balance" element={<Protected module="stock_summary"><StockBalancePage /></Protected>} />
          <Route path="/transactions" element={<Protected module="transactions"><TransactionsPage /></Protected>} />
          <Route path="/low-stock" element={<Protected module="low_stock"><LowStockPage /></Protected>} />
        </Routes>
      </BrowserRouter>
      <Toaster position="top-right" richColors />
    </AuthProvider>
  );
}

export default App;
