import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import StockMasterPage from "./pages/StockMasterPage";
import LocationsPage from "./pages/LocationsPage";
import StockTransactionPage from "./pages/StockTransactionPage";
import StockBalancePage from "./pages/StockBalancePage";
import TransactionsPage from "./pages/TransactionsPage";
import LowStockPage from "./pages/LowStockPage";
import { Toaster } from "./components/ui/sonner";
import "./App.css";

function Protected({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen flex items-center justify-center text-slate-500 text-sm">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
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
          <Route path="/register" element={<Public><RegisterPage /></Public>} />
          <Route path="/" element={<Protected><Dashboard /></Protected>} />
          <Route path="/stock-master" element={<Protected><StockMasterPage /></Protected>} />
          <Route path="/locations" element={<Protected><LocationsPage /></Protected>} />
          <Route path="/stock-in" element={<Protected><StockTransactionPage type="IN" /></Protected>} />
          <Route path="/stock-out" element={<Protected><StockTransactionPage type="OUT" /></Protected>} />
          <Route path="/balance" element={<Protected><StockBalancePage /></Protected>} />
          <Route path="/transactions" element={<Protected><TransactionsPage /></Protected>} />
          <Route path="/low-stock" element={<Protected><LowStockPage /></Protected>} />
        </Routes>
      </BrowserRouter>
      <Toaster position="top-right" richColors />
    </AuthProvider>
  );
}

export default App;
