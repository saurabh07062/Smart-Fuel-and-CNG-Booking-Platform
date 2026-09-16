import { useEffect, useMemo, useState } from "react";
import { addWalkIn, fetchWalkIns, updateWalkIn, type VendorWalkIn } from "@/services/api/walkInApi";
import { toApiError } from "@/services/api/apiClient";
import { useResync, useSocketEvent } from "@/hooks/useSocket";
import { SOCKET_EVENTS } from "@/services/socket/socketEvents";
import { coalesce } from "@/utils/coalesce";
import { pushToast } from "@/store/toastStore";
import { formatDuration } from "@/components/booking/FuelQueuePreview";

interface Props {
  stationId: string;
  fuelTypes: string[];
}

const unitOf = (fuel: string) => (fuel.toLowerCase() === "cng" ? "kg" : "L");

/**
 * Walk-in vehicles at this station's fuel nozzles.
 *
 * A vehicle that pulls up without a booking is recorded here so it counts in
 * that fuel's live queue: every customer's pre-booking estimate and every
 * booked customer's ETA include it. It starts automatically when the fuel's
 * nozzle is free (first come, first served with checked-in bookings), and
 * completes by itself when its fill time -- from its quantity -- has run.
 * "Done" finishes a fill early; "Remove" takes a vehicle that left out of line.
 */
export default function WalkInPanel({ stationId, fuelTypes }: Props) {
  const fuels = fuelTypes.length ? fuelTypes : ["Petrol"];
  const [rows, setRows] = useState<VendorWalkIn[]>([]);
  const [fuelType, setFuelType] = useState(fuels[0]);
  const [quantity, setQuantity] = useState(10);
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useMemo(
    () =>
      coalesce(async () => {
        try {
          setRows(await fetchWalkIns(stationId));
        } catch (err) {
          pushToast(toApiError(err).msg, "error");
        }
      }),
    [stationId],
  );

  useEffect(() => {
    load();
  }, [load]);
  // The queue changes with bookings as well as walk-ins: every change is pushed.
  useSocketEvent(SOCKET_EVENTS.QUEUE_UPDATED, load, [load]);
  useSocketEvent(SOCKET_EVENTS.SLOT_UPDATED, load, [load]);
  useResync(load, [load]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await addWalkIn(stationId, { fuelType, quantity, vehicleNumber: vehicleNumber.trim() || null });
      pushToast(r.msg || "Walk-in added", "success");
      setVehicleNumber("");
      await load();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setBusy(false);
    }
  };

  const act = async (walkIn: VendorWalkIn, action: "complete" | "cancel") => {
    try {
      const r = await updateWalkIn(stationId, walkIn._id, action);
      pushToast(r.msg || "Updated", "success");
      await load();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    }
  };

  const remaining = (w: VendorWalkIn) =>
    w.fuelingStartTime
      ? Math.max(0, Math.ceil((new Date(w.fuelingStartTime).getTime() + w.serviceDurationSeconds * 1000 - now) / 1000))
      : null;

  return (
    <div className="vm-bg-surface rounded-2xl border vm-border p-5 mb-6">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div>
          <h4 className="font-bold vm-text">Walk-in vehicles</h4>
          <p className="text-xs vm-text-muted">
            Vehicles without a booking. They join that fuel&apos;s live queue, which customers see before booking.
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4 items-end">
        <label className="text-xs vm-text-muted">
          Fuel
          <select
            className="input-field w-full mt-1"
            value={fuelType}
            onChange={(e) => setFuelType(e.target.value)}
          >
            {fuels.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs vm-text-muted">
          Quantity ({unitOf(fuelType)})
          <input
            type="number"
            className="input-field w-full mt-1"
            min={1}
            max={60}
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
          />
        </label>
        <label className="text-xs vm-text-muted">
          Vehicle number (optional)
          <input
            type="text"
            className="input-field w-full mt-1"
            maxLength={20}
            value={vehicleNumber}
            onChange={(e) => setVehicleNumber(e.target.value)}
            placeholder="MH12AB1234"
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          <i className="fas fa-plus" aria-hidden /> Add to queue
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="text-xs vm-text-muted">No walk-in vehicles in line.</p>
      ) : (
        <div className="w-full overflow-x-auto">
          <table className="vm-table">
            <thead>
              <tr>
                <th>Fuel</th>
                <th>Vehicle</th>
                <th>Quantity</th>
                <th>Status</th>
                <th>Service time</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => {
                const left = remaining(w);
                return (
                  <tr key={w._id}>
                    <td>{w.fuelType}</td>
                    <td>{w.vehicleNumber || "Walk-in"}</td>
                    <td>
                      {w.quantity} {unitOf(w.fuelType)}
                    </td>
                    <td>
                      {w.status === "serving" ? (
                        <span className="px-2 py-1 rounded-full text-[10px] font-bold uppercase bg-blue-900/30 vm-accent-text">
                          Fueling · {formatDuration(left ?? 0)} left
                        </span>
                      ) : (
                        <span className="px-2 py-1 rounded-full text-[10px] font-bold uppercase bg-yellow-900/30 text-yellow-400">
                          Waiting
                        </span>
                      )}
                    </td>
                    <td className="vm-td-sub">{formatDuration(w.serviceDurationSeconds)}</td>
                    <td>
                      {w.status === "serving" && (
                        <button
                          onClick={() => void act(w, "complete")}
                          title="Done"
                          aria-label="Mark walk-in done"
                          className="w-8 h-8 rounded-lg bg-emerald-600/20 text-emerald-400 border border-emerald-700/50 inline-flex items-center justify-center mr-1"
                        >
                          <i className="fas fa-flag-checkered text-xs" aria-hidden />
                        </button>
                      )}
                      <button
                        onClick={() => void act(w, "cancel")}
                        title="Remove (left the line)"
                        aria-label="Remove walk-in"
                        className="w-8 h-8 rounded-lg bg-red-600/20 text-red-400 border border-red-700/50 inline-flex items-center justify-center"
                      >
                        <i className="fas fa-times text-xs" aria-hidden />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
