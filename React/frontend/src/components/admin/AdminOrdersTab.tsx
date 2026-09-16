import { useEffect, useRef, useState } from "react";
import * as api from "@/services/api/adminApi";
import type { AdminOrder } from "@/services/api/adminApi";
import { useAdminStore } from "@/store/adminStore";
import { pushToast } from "@/store/toastStore";
import { toApiError } from "@/services/api/apiClient";
import { ConsoleLoading } from "@/components/console/ConsoleBits";

/** _orderStatusStyle(). */
const STATUS_STYLE: Record<string, string> = {
  upcoming: "vm-accent-text border-blue-800 bg-blue-900/30",
  serving: "vm-accent-text border-cyan-800 vm-accent-soft/30",
  waitlisted: "text-yellow-400 border-yellow-800 bg-yellow-900/30",
  completed: "text-emerald-400 border-emerald-900 bg-emerald-900/30",
  cancelled: "text-red-400 border-red-800 bg-red-900/30",
  no_show: "vm-text-muted border-gray-700 bg-gray-800/30",
  expired: "vm-text-muted border-gray-700 bg-gray-800/30",
};

/** _orderStatusLabel(). */
const STATUS_LABEL: Record<string, string> = {
  upcoming: "Upcoming",
  serving: "Serving",
  waitlisted: "Waitlisted",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No Show",
  expired: "Expired",
};

/** The dropdown's options, in the Vanilla order. */
const STATUS_OPTIONS: Array<[string, string]> = [
  ["upcoming", "Upcoming"],
  ["serving", "Serving"],
  ["completed", "Completed"],
  ["cancelled", "Cancelled"],
  ["no_show", "No Show"],
  ["expired", "Expired"],
];

/** The filter select's options, which include waitlisted but not expired. */
const FILTER_OPTIONS: Array<[string, string]> = [
  ["upcoming", "Upcoming"],
  ["serving", "Serving"],
  ["waitlisted", "Waitlisted"],
  ["completed", "Completed"],
  ["cancelled", "Cancelled"],
  ["no_show", "No Show"],
];

/**
 * Port of renderAdminOrders() and its filter/detail helpers.
 *
 * The search box keeps the original 400ms debounce. In the Vanilla version
 * that debounce fought the render model: every keystroke re-rendered the
 * whole page from a template string, which destroyed and rebuilt the input,
 * so a focus-restoring hack was needed to put the caret back. A controlled
 * input has no such problem.
 */
export default function AdminOrdersTab() {
  const orders = useAdminStore((s) => s.orders);
  const filters = useAdminStore((s) => s.orderFilters);
  const loadOrders = useAdminStore((s) => s.loadOrders);

  const [search, setSearch] = useState(filters.search ?? "");
  const [date, setDate] = useState(filters.date ?? "");
  const [status, setStatus] = useState(filters.status ?? "");
  const [detail, setDetail] = useState<AdminOrder | null>(null);
  const searchTimer = useRef<number | undefined>(undefined);

  // The debounce timer must be cleared on unmount, or a keystroke typed just
  // before leaving the tab fires a fetch into an unmounted component.
  useEffect(() => () => window.clearTimeout(searchTimer.current), []);

  const apply = (next: Partial<{ search: string; date: string; status: string }> = {}) => {
    void loadOrders({
      search: next.search ?? search,
      date: next.date ?? date,
      status: next.status ?? status,
    });
  };

  const onSearch = (v: string) => {
    setSearch(v);
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => apply({ search: v }), 400);
  };

  const clearFilters = () => {
    setSearch("");
    setDate("");
    setStatus("");
    void loadOrders({});
  };

  const setOrderStatus = async (bookingId: string, next: string) => {
    if (!next) return;
    try {
      await api.updateAdminOrderStatus(bookingId, next);
      pushToast(`Status updated to "${next}"`, "success");
      await loadOrders();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    }
  };

  if (orders === null) return <ConsoleLoading label="Loading orders..." />;

  const s = orders.summary ?? {};
  const stations = orders.stations ?? [];

  const stats: Array<[string, number, string, string]> = [
    ["Total Shown", s.total ?? 0, "fa-list", "vm-text"],
    ["Today", s.today ?? 0, "fa-calendar-day", "text-emerald-400"],
    ["Upcoming", s.upcoming ?? 0, "fa-clock", "vm-accent-text"],
    ["Serving", s.serving ?? 0, "fa-gas-pump", "vm-accent-text"],
    ["Completed", s.completed ?? 0, "fa-check-circle", "text-emerald-400"],
    ["Cancelled", s.cancelled ?? 0, "fa-times-circle", "text-red-400"],
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="vm-stat-value" style={{ fontSize: 22 }}>
            Orders &amp; Bookings
          </h2>
          <p className="vm-text-muted text-sm mt-1">All fuel slot bookings across every station.</p>
        </div>
        <button
          onClick={() => void loadOrders()}
          className="flex items-center gap-2 px-4 py-2 vm-bg-surface vm-hover border vm-border rounded-lg text-sm font-bold transition-colors"
        >
          <i className="fas fa-sync-alt" aria-hidden /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {stats.map(([label, value, icon, cls]) => (
          <div key={label} className="vm-bg-surface rounded-xl border vm-border p-4 text-center">
            <i className={`fas ${icon} ${cls} text-lg mb-2`} aria-hidden />
            <p className={`text-2xl font-bold ${cls}`}>{value}</p>
            <p className="text-[11px] vm-text-muted mt-1">{label}</p>
          </div>
        ))}
      </div>

      <div className="vm-bg-surface rounded-2xl border vm-border p-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="sm:col-span-2 lg:col-span-2">
            <label className="block text-xs font-bold vm-text-muted mb-2" htmlFor="order-search">
              Search
            </label>
            <div className="relative">
              <i
                className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 vm-text-muted text-sm"
                aria-hidden
              />
              <input
                id="order-search"
                type="text"
                placeholder="Order ID, vehicle, customer..."
                className="w-full pl-9 pr-4 py-2.5 vm-input text-sm vm-text"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-bold vm-text-muted mb-2" htmlFor="order-date">
              Date
            </label>
            <input
              id="order-date"
              type="date"
              className="w-full px-3 py-2.5 vm-input text-sm vm-text"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                apply({ date: e.target.value });
              }}
            />
          </div>
          <div>
            <label className="block text-xs font-bold vm-text-muted mb-2" htmlFor="order-status">
              Status
            </label>
            <select
              id="order-status"
              className="w-full px-3 py-2.5 vm-input text-sm vm-text"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                apply({ status: e.target.value });
              }}
            >
              <option value="">All Statuses</option>
              {FILTER_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex gap-2 mt-3">
          <button
            onClick={() => apply()}
            className="px-4 py-2 vm-accent vm-accent-hover vm-text text-sm font-bold rounded-lg transition-colors flex items-center gap-2"
          >
            <i className="fas fa-filter" aria-hidden /> Apply Filters
          </button>
          <button onClick={clearFilters} className="vm-btn vm-btn-ghost vm-btn-sm">
            Clear
          </button>
        </div>
      </div>

      {stations.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 vm-text-muted">
          <i className="fas fa-box-open text-5xl mb-4 opacity-40" aria-hidden />
          <p className="vm-panel-title">No orders found</p>
          <p className="text-sm mt-1">Try adjusting filters, or book a slot to see orders here.</p>
        </div>
      ) : (
        stations.map((st) => (
          <div key={st.stationId} className="vm-bg-surface rounded-2xl border vm-border overflow-hidden">
            <div className="flex items-center justify-between p-5 border-b vm-border vm-bg-surface">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg vm-accent/20 flex items-center justify-center">
                  <i className="fas fa-gas-pump vm-accent-text" aria-hidden />
                </div>
                <div>
                  <h3 className="font-bold text-base">{st.stationName}</h3>
                  <p className="vm-subtitle" style={{ fontSize: "11.5px" }}>
                    {st.address || ""}
                  </p>
                </div>
              </div>
              <span className="text-xs font-bold vm-text-muted vm-bg-ground px-3 py-1 rounded-full border vm-border">
                {st.bookings.length} booking{st.bookings.length !== 1 ? "s" : ""}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="vm-table">
                <thead className="text-[10px] vm-text-muted uppercase tracking-widest vm-bg-ground">
                  <tr>
                    <th className="px-5 py-3 font-bold">Order ID</th>
                    <th className="px-5 py-3 font-bold">Customer</th>
                    <th className="px-5 py-3 font-bold">Vehicle</th>
                    <th className="px-5 py-3 font-bold">Date &amp; Slot</th>
                    <th className="px-5 py-3 font-bold">Fuel</th>
                    <th className="px-5 py-3 font-bold">Amount</th>
                    <th className="px-5 py-3 font-bold">Payment</th>
                    <th className="px-5 py-3 font-bold">Status</th>
                    <th className="px-5 py-3 font-bold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {st.bookings.map((b) => {
                    const pc =
                      b.paymentStatus === "paid"
                        ? "text-emerald-400"
                        : b.paymentStatus === "pending"
                          ? "text-yellow-400"
                          : "vm-text-muted";
                    return (
                      <tr key={b.bookingId}>
                        <td className="px-5 py-4 font-mono text-xs font-bold vm-accent-text">
                          {b.orderId}
                        </td>
                        <td className="px-5 py-4">
                          <p className="font-medium vm-text text-sm">{b.userName}</p>
                          <p className="text-[10px] vm-text-muted">{b.userContact}</p>
                        </td>
                        <td className="px-5 py-4 font-bold text-sm">{b.vehiclePlate}</td>
                        <td className="px-5 py-4">
                          <p className="text-sm">{b.bookingDate}</p>
                          <p className="text-[10px] vm-text-muted">
                            {b.startTime} – {b.endTime}
                          </p>
                        </td>
                        <td className="px-5 py-4">
                          <p className="text-sm">{b.fuelType}</p>
                          <p className="text-[10px] vm-text-muted">{b.quantity} L/kg</p>
                        </td>
                        <td className="px-5 py-4 font-mono font-bold text-sm">
                          ₹{Number(b.amount).toLocaleString("en-IN")}
                        </td>
                        <td className={`px-5 py-4 text-xs font-bold ${pc}`}>
                          {(b.paymentStatus || "").replace(/_/g, " ").toUpperCase()}
                        </td>
                        <td className="px-5 py-4">
                          <span
                            className={`px-2 py-1 rounded border text-[10px] font-bold ${
                              STATUS_STYLE[b.status] ?? "vm-text-muted border-gray-700 bg-gray-800/30"
                            }`}
                          >
                            {STATUS_LABEL[b.status] ?? b.status}
                          </span>
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setDetail(b)}
                              className="vm-icon-btn"
                              title="View Details"
                              aria-label="View details"
                            >
                              <i className="fas fa-eye text-xs" aria-hidden />
                            </button>
                            <select
                              className="text-xs vm-bg-ground border vm-border rounded px-2 py-1 vm-text cursor-pointer"
                              value=""
                              onChange={(e) => void setOrderStatus(b.bookingId, e.target.value)}
                              aria-label={`Update status for ${b.orderId}`}
                            >
                              <option value="">Update Status</option>
                              {STATUS_OPTIONS.map(([v, l]) => (
                                <option key={v} value={v}>
                                  {l}
                                </option>
                              ))}
                            </select>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {detail && <OrderDetailModal order={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

/** showOrderDetail(). Reads the row already held rather than refetching. */
function OrderDetailModal({ order: b, onClose }: { order: AdminOrder; onClose: () => void }) {
  const statusColor: Record<string, string> = {
    upcoming: "vm-accent-text",
    serving: "vm-accent-text",
    waitlisted: "text-yellow-400",
    completed: "text-emerald-400",
    cancelled: "text-red-400",
    no_show: "vm-text-muted",
    expired: "vm-text-muted",
  };

  const rows: Array<[string, string]> = [
    ["Customer", b.userName],
    ["Contact", b.userContact],
    ["Station", b.stationName],
    ["Vehicle", b.vehiclePlate],
    ["Booking Date", b.bookingDate],
    ["Time Slot", `${b.startTime} – ${b.endTime}`],
    ["Fuel Type", b.fuelType],
    ["Quantity", `${b.quantity} L/kg`],
    ["Amount", `₹${Number(b.amount).toLocaleString("en-IN")}`],
    ["Payment", (b.paymentStatus || "").replace(/_/g, " ")],
    ["Pay Method", b.payMethod || "-"],
  ];

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Order details"
    >
      <div className="vm vm-bg-surface rounded-2xl border vm-border p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <i className="fas fa-receipt vm-accent-text" aria-hidden /> {b.orderId}
          </h3>
          <button onClick={onClose} className="vm-text-muted" aria-label="Close">
            <i className="fas fa-times text-xl" aria-hidden />
          </button>
        </div>
        <div className="space-y-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between items-start gap-4 text-sm">
              <span className="vm-text-muted">{label}</span>
              <span className="vm-text font-medium text-right">{value}</span>
            </div>
          ))}
          <div className="flex justify-between items-start gap-4 text-sm">
            <span className="vm-text-muted">Status</span>
            <span className={`${statusColor[b.status] ?? "vm-text-muted"} font-bold`}>{b.status}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
