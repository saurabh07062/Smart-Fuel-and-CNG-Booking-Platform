import { useState } from "react";
import { createPortal } from "react-dom";
import * as api from "@/services/api/vendorApi";
import { useVendorStore } from "@/store/vendorStore";
import { pushToast } from "@/store/toastStore";
import { toApiError } from "@/services/api/apiClient";
import { formatDateTime } from "@/utils/vendorFormat";

/**
 * Port of renderPriceHistoryModal() + updateStationPrice().
 *
 * The Vanilla version built this with document.createElement and removed
 * itself with getElementById(...).remove(), which is exactly the pattern that
 * fights React for ownership of the tree. Same markup and same classes, now
 * rendered through a portal and closed by state.
 *
 * This is also the vendor half of the real-time price feature: a successful
 * update here emits fuelPrice:updated server-side, which customers watching
 * the station receive.
 */
export default function PriceHistoryModal() {
  const stationId = useVendorStore((s) => s.priceHistoryFor);
  const history = useVendorStore((s) => s.priceHistory);
  const close = useVendorStore((s) => s.closePriceHistory);
  const openPriceHistory = useVendorStore((s) => s.openPriceHistory);
  const loadStations = useVendorStore((s) => s.loadStations);

  const [fuelType, setFuelType] = useState("Petrol");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);

  if (!stationId) return null;

  const update = async () => {
    const newPrice = parseFloat(price);
    if (!fuelType || !newPrice || newPrice <= 0) {
      pushToast("Please choose a fuel and enter a valid price", "error");
      return;
    }
    setBusy(true);
    try {
      const r = await api.updateFuelPrice(stationId, fuelType, newPrice);
      pushToast(r.msg || "Price updated", "success");
      setPrice("");
      // Refresh both the card behind the modal and the history inside it.
      await Promise.all([loadStations(), openPriceHistory(stationId)]);
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Price history"
    >
      <div className="vm vm-bg-surface rounded-2xl border vm-border p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <i className="fas fa-history vm-accent-text" aria-hidden /> Price History
          </h3>
          <button onClick={close} className="vm-text-muted" aria-label="Close">
            <i className="fas fa-times text-xl" aria-hidden />
          </button>
        </div>

        <div className="vm-bg-ground border vm-border rounded-xl p-4 mb-5 flex items-end gap-2">
          <div className="flex-1">
            <label className="text-[10px] vm-text-muted uppercase block mb-1">Fuel</label>
            <select
              className="w-full vm-input px-3 py-2 text-sm vm-text"
              value={fuelType}
              onChange={(e) => setFuelType(e.target.value)}
            >
              <option value="Petrol">Petrol</option>
              <option value="Diesel">Diesel</option>
              <option value="CNG">CNG</option>
            </select>
          </div>
          <div className="flex-1">
            <label className="text-[10px] vm-text-muted uppercase block mb-1">New Price (₹)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="e.g. 102.50"
              className="w-full vm-input px-3 py-2 text-sm vm-text"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
          <button
            onClick={update}
            disabled={busy}
            className="vm-accent vm-accent-hover vm-text font-bold px-4 py-2 rounded-lg text-sm transition-colors"
          >
            {busy ? "…" : "Update"}
          </button>
        </div>

        {history.length === 0 ? (
          <p className="vm-text-muted text-center py-8">No price changes recorded</p>
        ) : (
          <div className="space-y-3">
            {history.map((h) => (
              <div key={h._id} className="vm-panel" style={{ padding: 16, marginBottom: 0 }}>
                <div className="flex items-center justify-between mb-2">
                  <span className="font-bold text-sm">{h.fuelType}</span>
                  <span className="text-xs vm-text-muted">{formatDateTime(h.effectiveDate)}</span>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <span className="vm-text-muted">₹{h.oldPrice}</span>
                  <i className="fas fa-arrow-right vm-text-muted text-xs" aria-hidden />
                  <span className="text-emerald-400 font-bold">₹{h.newPrice}</span>
                  {h.note && <span className="text-xs vm-text-muted ml-auto">{h.note}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
