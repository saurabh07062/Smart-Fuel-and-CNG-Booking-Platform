import { useState } from "react";
import * as api from "@/services/api/vendorApi";
import type { FuelInventoryStatus, InventoryMovement } from "@/services/api/vendorApi";
import { useVendorStore } from "@/store/vendorStore";
import { pushToast } from "@/store/toastStore";
import { toApiError } from "@/services/api/apiClient";
import { INVENTORY_TIER_CLASS } from "@/utils/vendorFormat";
import { VendorEmpty, VendorHeading } from "../VendorBits";
import { istDateKey } from "@/utils/businessTime";

const BAR_COLORS: Record<string, string> = {
  petrol: "bg-orange-500",
  diesel: "bg-indigo-500",
  cng: "bg-emerald-500",
};

const FUEL_NAMES: Record<string, string> = { petrol: "Petrol", diesel: "Diesel", cng: "CNG" };

const MOVEMENT_LABEL: Record<InventoryMovement["type"], string> = {
  delivery: "Delivery",
  stock_count: "Stock count",
  sale: "Sale",
  capacity_change: "Tank size",
};

/**
 * Stock per station and fuel. Tiers, percentages, committed and available
 * stock come from the backend (inventoryStatus); this tab only displays them,
 * records deliveries and tank sizes, and shows the stock history.
 */
export default function InventoryTab() {
  const stations = useVendorStore((s) => s.stations);
  const alerts = useVendorStore((s) => s.inventoryAlerts);
  const loadAlerts = useVendorStore((s) => s.loadInventoryAlerts);
  const loadStations = useVendorStore((s) => s.loadStations);

  const refresh = async () => {
    await Promise.all([loadStations(), loadAlerts()]);
  };

  return (
    <>
      <VendorHeading
        title="Inventory Management"
        action={
          <button
            onClick={() => void loadAlerts()}
            className="vm-bg-surface vm-hover border vm-border vm-text font-bold py-2.5 px-4 rounded-lg transition-colors text-sm flex items-center gap-2"
          >
            <i className="fas fa-bell" aria-hidden /> Check Alerts
          </button>
        }
      />

      {alerts.length > 0 && (
        <div className="bg-red-900/20 border border-red-700/50 rounded-2xl p-6 mb-6">
          <h3 className="text-lg font-bold text-red-400 mb-4 flex items-center gap-2">
            <i className="fas fa-exclamation-triangle" aria-hidden /> Low Stock Alerts ({alerts.length})
          </h3>
          <div className="space-y-2">
            {alerts.map((a, i) => (
              <div
                key={`${a.stationId ?? a.station}-${a.fuelType}-${i}`}
                className="flex items-center justify-between vm-bg-ground p-3 rounded-lg border border-red-700/30"
              >
                <div>
                  <p className="font-bold text-sm">{a.station}</p>
                  <p className="vm-subtitle" style={{ fontSize: "11.5px" }}>
                    {a.fuelType}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-red-400">
                    {a.current} {a.unit}
                    {a.percent != null && <span className="vm-text-muted font-normal"> ({a.percent}%)</span>}
                  </p>
                  <p className="text-xs vm-text-muted">
                    {a.label}
                    {a.capacity != null && ` · tank ${a.capacity} ${a.unit}`}
                    {a.committed ? ` · ${a.committed} ${a.unit} booked` : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {stations.length === 0 ? (
        <VendorEmpty icon="fa-boxes" message="Add a station first to manage inventory." />
      ) : (
        <div className="space-y-6">
          {stations.map((s) => {
            const fuels = Object.entries(s.inventoryStatus ?? {}) as Array<[string, FuelInventoryStatus]>;
            return (
              <div key={String(s._id)} className="vm-panel" style={{ padding: 22 }}>
                <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                  <i className="fas fa-gas-pump text-indigo-400" aria-hidden /> {s.name}
                </h3>
                {fuels.length === 0 ? (
                  <p className="text-sm vm-text-muted">This station lists no fuels.</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {fuels.map(([fuel, status]) => (
                      <InventoryItem
                        key={fuel}
                        stationId={String(s._id)}
                        fuel={fuel}
                        status={status}
                        onDone={refresh}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function InventoryItem({
  stationId,
  fuel,
  status,
  onDone,
}: {
  stationId: string;
  fuel: string;
  status: FuelInventoryStatus;
  onDone: () => Promise<void>;
}) {
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  // The India date the delivery was ordered; lets the lead time be measured.
  const [orderedOn, setOrderedOn] = useState("");
  const [capacity, setCapacity] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<InventoryMovement[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const name = FUEL_NAMES[fuel] ?? fuel;
  const { current, capacity: tank, unit, percent, label, tier, committed, available } = status;

  const loadHistory = async () => {
    try {
      setHistory(await api.fetchInventoryMovements(stationId, fuel, 10));
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
      setHistory([]);
    }
  };

  const send = async (
    change: { quantity?: number; capacity?: number; note?: string; orderedOn?: string },
    reset: () => void,
  ) => {
    setBusy(true);
    try {
      const r = await api.updateInventory(stationId, fuel, change);
      pushToast(r.msg || "Inventory updated", "success");
      if (r.warning) pushToast(r.warning, "warning");
      reset();
      await onDone();
      if (showHistory) await loadHistory();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setBusy(false);
    }
  };

  const addStock = () => {
    const quantity = parseFloat(qty);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      pushToast("Enter the quantity delivered", "error");
      return;
    }
    void send(
      { quantity, ...(note.trim() ? { note: note.trim() } : {}), ...(orderedOn ? { orderedOn } : {}) },
      () => {
        setQty("");
        setNote("");
        setOrderedOn("");
      },
    );
  };

  const saveCapacity = () => {
    const value = parseFloat(capacity);
    if (!Number.isFinite(value) || value <= 0) {
      pushToast("Enter the tank capacity", "error");
      return;
    }
    void send({ capacity: value }, () => setCapacity(""));
  };

  const toggleHistory = () => {
    const next = !showHistory;
    setShowHistory(next);
    if (next && history === null) void loadHistory();
  };

  return (
    <div className="vm-panel" style={{ padding: 16, marginBottom: 0 }}>
      <div className="flex justify-between items-center mb-2">
        <span className="text-sm font-bold">{name}</span>
        <span
          className={`px-2 py-0.5 rounded-full border ${INVENTORY_TIER_CLASS[tier] ?? ""} text-[9px] font-bold uppercase tracking-wider`}
        >
          {label}
        </span>
      </div>
      <div className="flex justify-between items-end mb-2">
        <span className="text-[11px] font-bold vm-text-muted">
          <span className="vm-text">
            {current} {unit}
          </span>
          {tank != null ? ` / ${tank} ${unit}` : " · tank capacity not set"}
        </span>
        {percent != null && <span className="text-[11px] vm-text-muted">{percent}%</span>}
      </div>
      <div className="h-2 w-full vm-bg-surface rounded-full overflow-hidden mb-2">
        {percent != null && (
          <div
            className={`h-full ${BAR_COLORS[fuel] ?? "bg-blue-500"} rounded-full transition-all`}
            style={{ width: `${percent}%` }}
          />
        )}
      </div>
      <p className="text-[11px] vm-text-muted mb-3">
        {committed > 0 ? (
          <>
            {committed} {unit} held for bookings · <span className="vm-text">{available} {unit}</span> left to book
          </>
        ) : (
          <>Nothing held for bookings</>
        )}
      </p>
      <div className="flex gap-2 mb-2">
        <input
          type="number"
          min="0"
          placeholder={`Delivered (${unit})`}
          className="flex-1 min-w-0 vm-input px-3 py-1.5 text-xs vm-text"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          aria-label={`${name} quantity delivered`}
        />
        <button
          onClick={addStock}
          disabled={busy}
          className="vm-accent vm-accent-hover vm-text font-bold px-3 py-1.5 rounded-lg text-xs transition-colors"
        >
          Add
        </button>
      </div>
      <input
        type="text"
        maxLength={200}
        placeholder="Supplier / invoice (optional)"
        className="w-full vm-input px-3 py-1.5 text-xs vm-text mb-2"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        aria-label={`${name} delivery note`}
      />
      <label className="flex items-center gap-2 text-[11px] vm-text-muted mb-2">
        Ordered on
        <input
          type="date"
          max={istDateKey()}
          min={istDateKey(-60)}
          className="flex-1 min-w-0 vm-input px-3 py-1 text-xs vm-text"
          value={orderedOn}
          onChange={(e) => setOrderedOn(e.target.value)}
          aria-label={`${name} delivery order date`}
        />
      </label>
      <div className="flex gap-2">
        <input
          type="number"
          min="0"
          placeholder={tank != null ? `Tank: ${tank} ${unit}` : `Tank capacity (${unit})`}
          className="flex-1 min-w-0 vm-input px-3 py-1.5 text-xs vm-text"
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          aria-label={`${name} tank capacity`}
        />
        <button
          onClick={saveCapacity}
          disabled={busy}
          className="vm-bg-surface vm-hover border vm-border vm-text font-bold px-3 py-1.5 rounded-lg text-xs transition-colors"
        >
          {tank != null ? "Update" : "Set"}
        </button>
      </div>

      <button type="button" className="vm-link text-xs mt-3" onClick={toggleHistory} aria-expanded={showHistory}>
        <i className={`fas ${showHistory ? "fa-chevron-up" : "fa-clock-rotate-left"}`} aria-hidden />{" "}
        {showHistory ? "Hide history" : "Stock history"}
      </button>
      {showHistory && (
        <div className="mt-2 space-y-1.5">
          {history === null ? (
            <p className="text-[11px] vm-text-muted">Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-[11px] vm-text-muted">No deliveries, counts or sales recorded yet.</p>
          ) : (
            history.map((m) => (
              <div key={m.id} className="flex justify-between gap-2 text-[11px] border-t vm-border pt-1.5">
                <div className="min-w-0">
                  <p className="font-bold">
                    {MOVEMENT_LABEL[m.type]}
                    {m.orderId && <span className="vm-text-muted font-normal"> · {m.orderId}</span>}
                  </p>
                  <p className="vm-text-muted truncate">
                    {new Date(m.createdAt).toLocaleString("en-IN", {
                      timeZone: "Asia/Kolkata",
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {m.recordedBy && ` · ${m.recordedBy}`}
                    {m.note && ` · ${m.note}`}
                    {m.leadTimeDays != null &&
                      ` · arrived ${m.leadTimeDays} day${m.leadTimeDays === 1 ? "" : "s"} after ordering`}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  {m.type === "capacity_change" ? (
                    <p className="font-bold">
                      {m.capacityAfter} {m.unit}
                    </p>
                  ) : (
                    <p className={`font-bold ${(m.quantity ?? 0) < 0 ? "text-red-400" : "text-emerald-400"}`}>
                      {(m.quantity ?? 0) > 0 ? "+" : ""}
                      {m.quantity} {m.unit}
                    </p>
                  )}
                  {m.stockAfter != null && (
                    <p className="vm-text-muted">
                      → {m.stockAfter} {m.unit}
                    </p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
