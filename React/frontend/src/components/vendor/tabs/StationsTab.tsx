import { useEffect, useState } from "react";
import type { VendorStation } from "@/services/api/vendorApi";
import * as api from "@/services/api/vendorApi";
import { useVendorStore } from "@/store/vendorStore";
import { pushToast } from "@/store/toastStore";
import { toApiError, uploadUrl } from "@/services/api/apiClient";
import { getFreshUserCoords, isValidCoordinate } from "@/utils/geo";
import StationPinPicker from "@/components/maps/StationPinPicker";
import { VendorEmpty, VendorHeading } from "../VendorBits";
import PriceHistoryModal from "../PriceHistoryModal";

const EMPTY_FORM = {
  name: "",
  address: "",
  petrol: "96.72",
  diesel: "89.62",
  cng: "75.5",
  hours: "24 Hours",
  lat: "",
  lng: "",
};

/** Port of renderVendorStationsTab() + its actions. */
export default function StationsTab() {
  const stations = useVendorStore((s) => s.stations);
  const loadStations = useVendorStore((s) => s.loadStations);
  const viewStationBookings = useVendorStore((s) => s.viewStationBookings);
  const setTab = useVendorStore((s) => s.setTab);
  const openPriceHistory = useVendorStore((s) => s.openPriceHistory);

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);

  const set = (k: keyof typeof EMPTY_FORM, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const setPin = (lat: number, lng: number) =>
    setForm((f) => ({ ...f, lat: lat.toFixed(6), lng: lng.toFixed(6) }));
  const pinned = isValidCoordinate(parseFloat(form.lat), parseFloat(form.lng));

  // A vendor's first station starts from the pin they dropped when they
  // registered (stored on their profile). Never overrides a pin already set,
  // and not used for later stations, which are elsewhere.
  const firstStation = stations.length === 0;
  useEffect(() => {
    if (!showAdd || !firstStation) return;
    let cancelled = false;
    api
      .fetchVendorProfile()
      .then((profile) => {
        const pin = (profile as { registrationLocation?: { lat?: number; lng?: number } } | null)
          ?.registrationLocation;
        if (cancelled || !pin || !isValidCoordinate(pin.lat, pin.lng)) return;
        setForm((f) => (f.lat || f.lng ? f : { ...f, lat: String(pin.lat), lng: String(pin.lng) }));
      })
      .catch(() => {
        /* no pre-filled pin: the vendor places it on the map */
      });
    return () => {
      cancelled = true;
    };
  }, [showAdd, firstStation]);

  const useMyLocation = async () => {
    setLocating(true);
    const fix = await getFreshUserCoords();
    setLocating(false);
    if (!fix) {
      pushToast("Could not get your location. Click the map where the pump is instead.", "error");
      return;
    }
    setPin(fix.lat, fix.lng);
  };

  const create = async () => {
    if (!form.name || !form.address) {
      pushToast("Station name and address are required", "error");
      return;
    }
    // Without a position the station never appears in nearest-station search.
    if (!pinned) {
      pushToast("Pin the station's exact location on the map", "error");
      return;
    }
    setBusy(true);
    try {
      await api.createVendorStation({
        name: form.name,
        address: form.address,
        prices: {
          petrol: parseFloat(form.petrol),
          diesel: parseFloat(form.diesel),
          cng: parseFloat(form.cng),
        },
        openingHours: form.hours || "24 Hours",
        coordinates: { lat: parseFloat(form.lat), lng: parseFloat(form.lng) },
      });
      pushToast("Station created successfully!", "success");
      setShowAdd(false);
      setForm(EMPTY_FORM);
      await loadStations();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (id: string) => {
    try {
      const r = await api.toggleVendorStationStatus(id);
      pushToast(r.msg || "Station status updated", "success");
      await loadStations();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("WARNING: This will permanently delete the station and all related data. Continue?")) {
      return;
    }
    try {
      const r = await api.deleteVendorStation(id);
      pushToast(r.msg || "Station deleted successfully", "success");
      await loadStations();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    }
  };

  const openBookings = async (id: string) => {
    await setTab("bookings");
    await viewStationBookings(id);
  };

  return (
    <>
      <VendorHeading
        title="My Petrol Pumps"
        action={
          <button
            onClick={() => setShowAdd((v) => !v)}
            className="vm-accent vm-accent-hover vm-text font-bold py-2.5 px-4 rounded-lg transition-colors text-sm flex items-center gap-2"
          >
            <i className="fas fa-plus" aria-hidden /> Add Station
          </button>
        }
      />

      {showAdd && (
        <div className="vm-bg-surface rounded-2xl border vm-border p-6 mb-6">
          <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
            <i className="fas fa-plus-circle vm-accent-text" aria-hidden /> Add New Station
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Station Name *">
              <input
                type="text"
                className="w-full vm-input px-4 py-2.5 text-sm vm-text"
                placeholder="e.g. FuelMart Highway Station"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </Field>
            <Field label="Address *">
              <input
                type="text"
                className="w-full vm-input px-4 py-2.5 text-sm vm-text"
                placeholder="e.g. Highway Road, City"
                value={form.address}
                onChange={(e) => set("address", e.target.value)}
              />
            </Field>
            <Field label="Petrol Price (₹/L)">
              <input
                type="number"
                step="0.01"
                className="w-full vm-input px-4 py-2.5 text-sm vm-text"
                value={form.petrol}
                onChange={(e) => set("petrol", e.target.value)}
              />
            </Field>
            <Field label="Diesel Price (₹/L)">
              <input
                type="number"
                step="0.01"
                className="w-full vm-input px-4 py-2.5 text-sm vm-text"
                value={form.diesel}
                onChange={(e) => set("diesel", e.target.value)}
              />
            </Field>
            <Field label="CNG Price (₹/Kg)">
              <input
                type="number"
                step="0.01"
                className="w-full vm-input px-4 py-2.5 text-sm vm-text"
                value={form.cng}
                onChange={(e) => set("cng", e.target.value)}
              />
            </Field>
            <Field label="Opening Hours">
              <input
                type="text"
                className="w-full vm-input px-4 py-2.5 text-sm vm-text"
                value={form.hours}
                onChange={(e) => set("hours", e.target.value)}
              />
            </Field>
          </div>
          <div className="mt-4">
            <label className="block text-xs font-bold vm-text-muted mb-2">Station Location *</label>
            <StationPinPicker lat={form.lat} lng={form.lng} onChange={setPin} followPin />
            <div className="flex flex-wrap items-center justify-between gap-2 mt-2 text-xs vm-text-muted">
              <span data-testid="pin-status">
                {pinned
                  ? `Pinned at ${form.lat}, ${form.lng}. Drag the pin to adjust.`
                  : "Click the map, or drag the pin, onto the pump's exact location."}
              </span>
              <button
                type="button"
                onClick={() => void useMyLocation()}
                disabled={locating}
                className="vm-bg-ground vm-hover border vm-border rounded-lg px-3 py-1.5 font-bold transition-colors"
              >
                <i className={`fas ${locating ? "fa-spinner fa-spin" : "fa-crosshairs"} mr-1`} aria-hidden />
                {locating ? "Locating…" : "Use my location"}
              </button>
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button
              onClick={() => setShowAdd(false)}
              className="vm-bg-ground vm-hover border vm-border vm-text font-bold py-2.5 px-4 rounded-lg transition-colors text-sm"
            >
              Cancel
            </button>
            <button
              onClick={create}
              disabled={busy}
              className="vm-accent vm-accent-hover vm-text font-bold py-2.5 px-4 rounded-lg transition-colors text-sm flex items-center gap-2"
            >
              <i className="fas fa-save" aria-hidden /> {busy ? "Creating…" : "Create Station"}
            </button>
          </div>
        </div>
      )}

      {stations.length === 0 ? (
        <VendorEmpty
          icon="fa-gas-pump"
          title="No Stations Yet"
          message="You haven't added any petrol pumps yet."
          action={
            <button onClick={() => setShowAdd(true)} className="vm-btn vm-btn-primary">
              <i className="fas fa-plus mr-2" aria-hidden /> Add Your First Station
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {stations.map((s) => (
            <StationCard
              key={String(s._id)}
              station={s}
              onBookings={() => void openBookings(String(s._id))}
              onPrices={() => void openPriceHistory(String(s._id))}
              onToggle={() => void toggleStatus(String(s._id))}
              onDelete={() => void remove(String(s._id))}
            />
          ))}
        </div>
      )}

      <PriceHistoryModal />
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-bold vm-text-muted mb-2">{label}</label>
      {children}
    </div>
  );
}

function StationCard({
  station: s,
  onBookings,
  onPrices,
  onToggle,
  onDelete,
}: {
  station: VendorStation;
  onBookings: () => void;
  onPrices: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const photo = s.images?.length ? uploadUrl(s.images[0]) : null;
  const statusCls =
    s.status === "Active"
      ? "bg-emerald-900/30 text-emerald-400 border-emerald-700"
      : "bg-gray-900/30 vm-text-muted border-gray-700";

  const prices = (s.prices ?? {}) as Record<string, number | undefined>;

  return (
    <div className="vm-bg-surface rounded-2xl border vm-border p-6 vm-hover-border transition-colors">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          {photo && !imgFailed ? (
            <img
              src={photo}
              alt=""
              className="w-12 h-12 rounded-xl object-cover flex-shrink-0"
              style={{ border: "1px solid var(--z-line)" }}
              onError={() => setImgFailed(true)}
            />
          ) : (
            <div className="w-12 h-12 rounded-xl bg-indigo-500/20 flex items-center justify-center">
              <i className="fas fa-gas-pump text-indigo-400 text-xl" aria-hidden />
            </div>
          )}
          <div>
            <h3 className="font-bold text-lg">{s.name || "Unknown Station"}</h3>
            <p className="vm-subtitle" style={{ fontSize: "11.5px" }}>
              {s.address || "No address"}
            </p>
          </div>
        </div>
        <span
          className={`px-2.5 py-1 rounded-full border ${statusCls} text-[10px] font-bold uppercase tracking-wider`}
        >
          {s.status || "Unknown"}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        {(["petrol", "diesel", "cng"] as const).map((f) => (
          <div key={f} className="vm-bg-ground p-3 rounded-lg border vm-border">
            <p className="text-[10px] vm-text-muted uppercase">{f}</p>
            <p className="font-bold text-sm">₹{prices[f] ?? "N/A"}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 text-xs vm-text-muted mb-4">
        <span>{s.fuelTypes?.join(", ") || "No fuels listed"}</span>
        <span>•</span>
        <span>{s.openingHours || "24 Hours"}</span>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={onBookings}
          className="flex-1 vm-bg-ground vm-hover border vm-border rounded-lg py-2 text-xs font-bold transition-colors"
        >
          <i className="fas fa-calendar-check mr-1" aria-hidden /> Bookings
        </button>
        <button
          onClick={onPrices}
          className="flex-1 vm-bg-ground vm-hover border vm-border rounded-lg py-2 text-xs font-bold transition-colors"
        >
          <i className="fas fa-history mr-1" aria-hidden /> Prices
        </button>
        <button
          onClick={onToggle}
          title="Toggle Status"
          aria-label="Toggle status"
          className="w-9 h-9 rounded-lg vm-bg-ground hover:bg-yellow-600 text-yellow-400 border vm-border transition-colors flex items-center justify-center"
        >
          <i className="fas fa-power-off text-xs" aria-hidden />
        </button>
        <button
          onClick={onDelete}
          title="Delete"
          aria-label="Delete station"
          className="w-9 h-9 rounded-lg vm-bg-ground hover:bg-red-600 text-red-400 border vm-border transition-colors flex items-center justify-center"
        >
          <i className="fas fa-trash text-xs" aria-hidden />
        </button>
      </div>
    </div>
  );
}
