import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import {
  SquaresFour,
  Package,
  Buildings,
  ArrowDown,
  ArrowUp,
  Scales,
  ClockCounterClockwise,
  SignOut,
  Warning,
} from "@phosphor-icons/react";

const NAV = [
  { to: "/", label: "Dashboard", icon: SquaresFour, testid: "nav-dashboard" },
  { to: "/stock-master", label: "Stock Master", icon: Package, testid: "nav-stock-master" },
  { to: "/locations", label: "Location Master", icon: Buildings, testid: "nav-locations" },
  { to: "/stock-in", label: "Stock In", icon: ArrowDown, testid: "nav-stock-in" },
  { to: "/stock-out", label: "Stock Out", icon: ArrowUp, testid: "nav-stock-out" },
  { to: "/balance", label: "Stock Balance", icon: Scales, testid: "nav-balance" },
  { to: "/transactions", label: "Transactions", icon: ClockCounterClockwise, testid: "nav-transactions" },
  { to: "/low-stock", label: "Low Stock", icon: Warning, testid: "nav-low-stock" },
];

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();

  const handleLogout = () => {
    logout();
    nav("/login");
  };

  return (
    <div className="min-h-screen flex bg-white" data-testid="app-layout">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col sticky top-0 h-screen">
        <div className="p-5 border-b border-slate-200 flex items-center gap-3">
          <div className="h-9 w-9 bg-slate-900 flex items-center justify-center rounded-sm">
            <Package size={20} weight="bold" className="text-white" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-slate-500">Stock Master</div>
            <div className="font-bold text-slate-900 text-sm">Warehouse Control</div>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                data-testid={item.testid}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2.5 rounded-sm text-sm font-medium transition-colors duration-100 ${
                    isActive
                      ? "bg-slate-900 text-white"
                      : "text-slate-700 hover:bg-slate-100"
                  }`
                }
              >
                <Icon size={18} weight="bold" />
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <div className="border-t border-slate-200 p-3">
          <div className="px-3 py-2 mb-2">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-slate-500">Signed in</div>
            <div className="text-sm font-semibold text-slate-900 truncate" data-testid="current-user-name">
              {user?.name || user?.email}
            </div>
            <div className="text-xs text-slate-500 truncate">{user?.email}</div>
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 rounded-sm transition-colors"
            data-testid="logout-button"
          >
            <SignOut size={16} weight="bold" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-x-hidden">{children}</main>
    </div>
  );
}
