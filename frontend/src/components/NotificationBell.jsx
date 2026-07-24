import React, { useEffect, useRef, useState, useCallback } from "react";
import { api } from "../lib/api";
import {
  Bell, SignIn, Lock, UserPlus, UserCircle, Package, ArrowDown, ArrowUp, Trash, PencilSimple, CheckCircle,
} from "@phosphor-icons/react";

const TYPE_ICON = {
  "auth.login": SignIn,
  "auth.lockout": Lock,
  "user.created": UserPlus,
  "user.updated": PencilSimple,
  "user.deactivated": Lock,
  "user.reactivated": UserCircle,
  "stock_master.created": Package,
  "stock_master.deleted": Trash,
  "receipt_note.created": ArrowDown,
  "stock_in.recorded": ArrowDown,
  "issue_note.created": ArrowUp,
  "stock_out.recorded": ArrowUp,
};

const TYPE_COLOR = {
  "auth.login": "bg-blue-50 text-blue-700",
  "auth.lockout": "bg-amber-50 text-amber-700",
  "user.created": "bg-emerald-50 text-emerald-700",
  "user.updated": "bg-slate-100 text-slate-700",
  "user.deactivated": "bg-red-50 text-red-700",
  "user.reactivated": "bg-emerald-50 text-emerald-700",
  "stock_master.created": "bg-indigo-50 text-indigo-700",
  "stock_master.deleted": "bg-red-50 text-red-700",
  "receipt_note.created": "bg-emerald-50 text-emerald-700",
  "stock_in.recorded": "bg-emerald-50 text-emerald-700",
  "issue_note.created": "bg-orange-50 text-orange-700",
  "stock_out.recorded": "bg-orange-50 text-orange-700",
};

function timeAgo(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const s = Math.max(1, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const ref = useRef(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/notifications", { params: { limit: 50 } });
      setItems(data.items || []);
      setUnread(data.unread_count || 0);
    } catch { /* ignore */ }
  }, []);

  // Poll every 30s + on focus + initial mount
  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, [load]);

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = async () => {
    if (!open) await load();
    setOpen((o) => !o);
  };

  const markAllRead = async () => {
    if (unread === 0) return;
    setLoading(true);
    try {
      await api.post("/notifications/mark-read", { ids: null });
      await load();
    } finally { setLoading(false); }
  };

  const clearNotifications = async () => {
    if (items.length === 0) return;
    if (!window.confirm("Clear all visible notifications?")) return;
    setLoading(true);
    try {
      await api.post("/notifications/clear", { ids: null });
      await load();
    } finally { setLoading(false); }
  };

  const markOneRead = async (id) => {
    if (items.find((i) => i.id === id)?.read) return;
    try {
      await api.post("/notifications/mark-read", { ids: [id] });
      await load();
    } catch { /* ignore */ }
  };

  return (
    <div ref={ref} className="relative" data-testid="notification-bell">
      <button
        onClick={toggle}
        className="relative p-2 rounded-sm hover:bg-slate-100 transition-colors text-slate-700"
        aria-label="Notifications"
        data-testid="notification-bell-button"
      >
        <Bell size={20} weight="bold" />
        {unread > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 bg-red-600 text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-white"
            data-testid="notification-unread-count"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 mt-2 w-[380px] max-h-[520px] bg-white border border-slate-200 rounded-sm shadow-xl z-50 flex flex-col"
          data-testid="notification-dropdown"
        >
          <div className="px-4 py-3 border-b border-slate-200">
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-slate-500">Activity</div>
              <div className="font-bold text-slate-900 text-sm">Notifications</div>
            </div>
          </div>

          <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 flex items-center gap-2">
            <button
              onClick={markAllRead}
              disabled={loading || unread === 0}
              className="h-8 px-3 rounded-sm border border-slate-200 bg-white text-xs font-semibold text-blue-700 hover:bg-blue-50 disabled:text-slate-400 disabled:bg-slate-100 disabled:cursor-not-allowed"
              data-testid="notification-mark-all-read"
            >
              <CheckCircle size={12} weight="bold" className="inline mr-1" />
              Mark all read
            </button>
            <button
              onClick={clearNotifications}
              disabled={loading || items.length === 0}
              className="h-8 px-3 rounded-sm border border-red-200 bg-white text-xs font-semibold text-red-700 hover:bg-red-50 disabled:text-slate-400 disabled:border-slate-200 disabled:bg-slate-100 disabled:cursor-not-allowed"
              data-testid="notification-clear"
            >
              <Trash size={12} weight="bold" className="inline mr-1" />
              Clear notifications
            </button>
          </div>

          <div className="overflow-y-auto flex-1">
            {items.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-slate-500" data-testid="notification-empty">
                No notifications yet.
              </div>
            ) : (
              items.map((n) => {
                const Icon = TYPE_ICON[n.type] || Bell;
                const color = TYPE_COLOR[n.type] || "bg-slate-100 text-slate-700";
                return (
                  <button
                    key={n.id}
                    onClick={() => markOneRead(n.id)}
                    className={`w-full text-left px-4 py-3 border-b border-slate-100 hover:bg-slate-50 transition-colors flex gap-3 ${
                      n.read ? "" : "bg-blue-50/40"
                    }`}
                    data-testid={`notification-item-${n.id}`}
                  >
                    <div className={`h-8 w-8 rounded-sm flex items-center justify-center flex-shrink-0 ${color}`}>
                      <Icon size={14} weight="bold" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <div className={`text-sm truncate ${n.read ? "font-medium text-slate-700" : "font-bold text-slate-900"}`}>
                          {n.title}
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono whitespace-nowrap">{timeAgo(n.created_at)}</div>
                      </div>
                      {n.message && (
                        <div className="text-xs text-slate-600 mt-0.5 line-clamp-2">{n.message}</div>
                      )}
                    </div>
                    {!n.read && <div className="h-2 w-2 bg-blue-600 rounded-full mt-2 flex-shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
