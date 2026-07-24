import React, { useEffect, useMemo, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import NotificationBell from "./NotificationBell";
import {
  SquaresFour,
  Package,
  MagnifyingGlass,
  Buildings,
  ArrowDown,
  ArrowUp,
  ArrowsLeftRight,
  Scales,
  ClockCounterClockwise,
  SignOut,
  Warning,
  Users,
  UserCircle,
  DotsSixVertical,
  ArrowCounterClockwise,
  FileCsv,
} from "@phosphor-icons/react";

const NAV = [
  { to: "/", label: "Dashboard", icon: SquaresFour, testid: "nav-dashboard" },
  { to: "/stock-master", label: "Stock Master", icon: Package, testid: "nav-stock-master", module: "stock_master" },
  { to: "/item-details", label: "Item Details", icon: MagnifyingGlass, testid: "nav-item-details", module: "item_details" },
  { to: "/locations", label: "Location Master", icon: Buildings, testid: "nav-locations", module: "locations" },
  { to: "/stock-in", label: "Stock In", icon: ArrowDown, testid: "nav-stock-in", module: "stock_in" },
  { to: "/stock-out", label: "Stock Out", icon: ArrowUp, testid: "nav-stock-out", module: "stock_out" },
  { to: "/stock-transfer", label: "Stock Transfer", icon: ArrowsLeftRight, testid: "nav-stock-transfer", module: "stock_transfer" },
  { to: "/balance", label: "Stock Summary", icon: Scales, testid: "nav-balance", module: "stock_summary" },
  { to: "/transactions", label: "Transactions", icon: ClockCounterClockwise, testid: "nav-transactions", module: "transactions" },
  { to: "/low-stock", label: "Low Stock", icon: Warning, testid: "nav-low-stock", module: "low_stock" },
  { to: "/users", label: "Users", icon: Users, testid: "nav-users", adminOnly: true },
];

const STORAGE_KEY_PREFIX = "stockmgmt:nav_order:v1:";

function loadOrder(userId) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + (userId || "anon"));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveOrder(userId, order) {
  try {
    localStorage.setItem(STORAGE_KEY_PREFIX + (userId || "anon"), JSON.stringify(order));
  } catch {
    /* ignore quota errors */
  }
}

/**
 * Returns NAV reordered by `order` (array of `to` paths). Items present in NAV but
 * missing from `order` are appended in their original order (for forward compatibility
 * when new nav items are added in code).
 */
function applyOrder(items, order) {
  if (!order || order.length === 0) return items;
  const byTo = new Map(items.map((it) => [it.to, it]));
  const ordered = [];
  const seen = new Set();
  for (const to of order) {
    const it = byTo.get(to);
    if (it) { ordered.push(it); seen.add(to); }
  }
  for (const it of items) if (!seen.has(it.to)) ordered.push(it);
  return ordered;
}

export default function Layout({ children }) {
  const { user, logout, isAdmin, canAccess } = useAuth();
  const nav = useNavigate();

  // Visible items (after permission filter)
  const visibleItems = useMemo(() => NAV.filter((item) => {
    if (item.adminOnly) return isAdmin;
    if (item.module) return canAccess(item.module);
    return true;
  }), [isAdmin, canAccess]);

  // Persisted order — initialise from localStorage; default to permission-filtered code order
  const [order, setOrder] = useState(() => {
    const saved = loadOrder(user?.id);
    return saved || visibleItems.map((i) => i.to);
  });

  // If permissions/user change, reconcile order with newly visible items
  useEffect(() => {
    setOrder((prev) => {
      const allowed = new Set(visibleItems.map((i) => i.to));
      const filtered = prev.filter((to) => allowed.has(to));
      const additions = visibleItems.map((i) => i.to).filter((to) => !filtered.includes(to));
      return [...filtered, ...additions];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleItems.length, user?.id]);

  // Persist whenever order changes
  useEffect(() => {
    if (order && order.length) saveOrder(user?.id, order);
  }, [order, user?.id]);

  const orderedItems = applyOrder(visibleItems, order);

  // Drag state
  const [dragFrom, setDragFrom] = useState(null);
  const [dragOver, setDragOver] = useState(null);

  const onDragStart = (idx) => (e) => {
    setDragFrom(idx);
    try {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(idx));
    } catch { /* some browsers throw if not configured */ }
  };
  const onDragOver = (idx) => (e) => {
    e.preventDefault();
    if (dragOver !== idx) setDragOver(idx);
    e.dataTransfer.dropEffect = "move";
  };
  const onDrop = (idx) => (e) => {
    e.preventDefault();
    const from = dragFrom !== null ? dragFrom : Number(e.dataTransfer.getData("text/plain"));
    setDragFrom(null);
    setDragOver(null);
    if (from === null || isNaN(from) || from === idx) return;
    setOrder((prev) => {
      // operate on the currently-visible (filtered) list; map back to all-tos
      const visibleTos = orderedItems.map((i) => i.to);
      const moved = visibleTos[from];
      const next = visibleTos.filter((_, i) => i !== from);
      next.splice(idx, 0, moved);
      // include any non-visible (out-of-permission but persisted) order entries at the end so we don't drop them
      const visibleSet = new Set(visibleTos);
      const hidden = prev.filter((to) => !visibleSet.has(to));
      return [...next, ...hidden];
    });
  };
  const onDragEnd = () => { setDragFrom(null); setDragOver(null); };

  const resetOrder = () => {
    const def = visibleItems.map((i) => i.to);
    setOrder(def);
  };

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

        <div className="px-3 pt-3 pb-1 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-slate-400">Navigation</span>
          <button
            onClick={resetOrder}
            className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 hover:text-slate-700 flex items-center gap-1"
            title="Reset menu order"
            data-testid="nav-reset-order"
          >
            <ArrowCounterClockwise size={11} weight="bold" /> Reset
          </button>
        </div>

        <nav className="flex-1 px-3 pb-3 space-y-0.5 overflow-y-auto" data-testid="nav-list">
          {orderedItems.map((item, idx) => {
            const Icon = item.icon;
            const isDragging = dragFrom === idx;
            const isDropTarget = dragOver === idx && dragFrom !== null && dragFrom !== idx;
            return (
              <div
                key={item.to}
                onDragOver={onDragOver(idx)}
                onDrop={onDrop(idx)}
                onDragEnd={onDragEnd}
                className={`group relative flex items-stretch rounded-sm transition-opacity ${isDragging ? "opacity-40" : ""} ${isDropTarget ? "ring-2 ring-blue-500 ring-offset-1" : ""}`}
                data-testid={`nav-row-${item.to}`}
              >
                {/* Drag handle — only this initiates drag */}
                <button
                  type="button"
                  draggable
                  onDragStart={onDragStart(idx)}
                  onDragEnd={onDragEnd}
                  className="flex items-center justify-center w-5 cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-700 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Drag to reorder"
                  aria-label={`Reorder ${item.label}`}
                  data-testid={`nav-drag-handle-${item.to}`}
                >
                  <DotsSixVertical size={14} weight="bold" />
                </button>
                <NavLink
                  to={item.to}
                  end={item.to === "/"}
                  data-testid={item.testid}
                  className={({ isActive }) =>
                    `flex-1 flex items-center gap-3 pl-1 pr-3 py-2.5 rounded-sm text-sm font-medium transition-colors duration-100 ${
                      isActive
                        ? "bg-slate-900 text-white"
                        : "text-slate-700 hover:bg-slate-100"
                    }`
                  }
                >
                  <Icon size={18} weight="bold" />
                  {item.label}
                </NavLink>
              </div>
            );
          })}
        </nav>

        <div className="border-t border-slate-200 p-3">
          <NavLink
            to="/profile"
            className={({ isActive }) =>
              `block px-3 py-2 mb-2 rounded-sm transition-colors ${isActive ? "bg-slate-100" : "hover:bg-slate-100"}`
            }
            data-testid="nav-profile"
          >
            <div className="flex items-center gap-2">
              <UserCircle size={16} weight="bold" className="text-slate-500" />
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-slate-500">Signed in</div>
            </div>
            <div className="text-sm font-semibold text-slate-900 truncate mt-1" data-testid="current-user-name">
              {user?.name || user?.email}
            </div>
            <div className="text-xs text-slate-500 truncate">{user?.email}</div>
          </NavLink>
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
      <main className="flex-1 overflow-x-hidden flex flex-col">
        <div className="sticky top-0 z-30 bg-white/80 backdrop-blur border-b border-slate-200 px-6 h-12 flex items-center justify-end gap-2">
          <NotificationBell />
        </div>
        <div className="flex-1">{children}</div>
      </main>
    </div>
  );
}
