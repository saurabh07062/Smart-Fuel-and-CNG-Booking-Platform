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
import StationImagesEditor from "../StationImagesEditor";
import StationDetailsEditor from "../StationDetailsEditor";
import NozzleModes from "../NozzleModes";
import SlotTimings from "../SlotTimings";
import { coordinateError, parseCoordinatePair } from "@/utils/coordinates";
import { useAuthStore } from "@/store/authStore";
import { VENDOR_FUELS, soldFuels } from "@/utils/vendorFuels";

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

  // Only the fuels this vendor registered for (all three for older vendors).
  const vendorFuelTypes = useAuthStore((s) => s.user?.vendorFuelTypes);
  const fuels = VENDOR_FUELS.filter((f) => soldFuels(vendorFuelTypes).includes(f.key));

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = editingId ? stations.find((s) => String(s._id) === editingId) : undefined;

  const set = (k: keyof typeof EMPTY_FORM, v: string) => setForm((f) => ({ ...f, [k]: v }));
  /** A pasted Google Maps pair ("18.580563, 73.975342") fills both boxes from the same spot. */
  const setCoordinate = (k: "lat" | "lng", value: string) => {
    const pair = parseCoordinatePair(value);
    if (pair) setForm((f) => ({ ...f, lat: pair.lat, lng: pair.lng }));
    else set(k, value.trim());
  };
  const setPin = (lat: number, lng: number) =>
    setForm((f) => ({ ...f, lat: lat.toFixed(6), lng: lng.toFixed(6) }));
  const latError = coordinateError(form.lat, "Latitude", 90);
  const lngError = coordinateError(form.lng, "Longitude", 180);
  // Number() rather than parseFloat: "18.5abc" is a typo, not 18.5.
  const pinned = !latError && !lngError && isValidCoordinate(Number(form.lat), Number(form.lng));

  // A vendor with no stations yet (just approved and signed in) lands on this
  // form already open, once their station list has actually loaded.
  const loading = useVendorStore((s) => s.loading);
  const noStations = stations.length === 0;
  useEffect(() => {
    if (loading === false && noStations) setShowAdd(true);
  }, [loading, noStations]);

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

  const fillMyLocation = async () => {
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
    if (latError || lngError) {
      pushToast(latError || lngError || "", "error");
      return;
    }
    if (!pinned) {
      pushToast("Enter the latitude and longitude, or pin the station's exact location on the map", "error");
      return;
    }
    setBusy(true);
    try {
      await api.createVendorStation({
        name: form.name,
        address: form.address,
        // Only the fuels this vendor sells.
        fuelTypes: fuels.map((f) => f.label),
        prices: Object.fromEntries(fuels.map((f) => [f.key, parseFloat(form[f.key])])),
        openingHours: form.hours || "24 Hours",
        // Exactly what was typed or pinned.
        coordinates: { lat: Number(form.lat), lng: Number(form.lng) },
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
            {fuels.map((f) => (
              <Field key={f.key} label={`${f.label} Price (₹/${f.unit})`}>
                <input
                  type="number"
                  step="0.01"
                  aria-label={`${f.label} Price`}
                  className="w-full vm-input px-4 py-2.5 text-sm vm-text"
                  value={form[f.key]}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              </Field>
            ))}
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-3">
              <Field label="Latitude *">
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label="Latitude"
                  aria-invalid={Boolean(latError)}
                  className="w-full vm-input px-4 py-2.5 text-sm vm-text"
                  placeholder="-90 to 90"
                  value={form.lat}
                  onChange={(e) => setCoordinate("lat", e.target.value)}
                />
                {latError && (
                  <p role="alert" className="text-xs mt-1" style={{ color: "var(--status-bad)" }}>
                    {latError}
                  </p>
                )}
              </Field>
              <Field label="Longitude *">
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label="Longitude"
                  aria-invalid={Boolean(lngError)}
                  className="w-full vm-input px-4 py-2.5 text-sm vm-text"
                  placeholder="-180 to 180"
                  value={form.lng}
                  onChange={(e) => setCoordinate("lng", e.target.value)}
                />
                {lngError && (
                  <p role="alert" className="text-xs mt-1" style={{ color: "var(--status-bad)" }}>
                    {lngError}
                  </p>
                )}
              </Field>
            </div>
            <StationPinPicker lat={form.lat} lng={form.lng} onChange={setPin} followPin />
            <div className="flex flex-wrap items-center justify-between gap-2 mt-3 text-xs vm-text-muted">
              <span data-testid="pin-status" className="flex items-center gap-2">
                <i
                  className={`fas ${pinned ? "fa-circle-check" : "fa-location-dot"}`}
                  style={{ color: pinned ? "var(--z-green)" : "var(--z-light)" }}
                  aria-hidden
                />
                {pinned
                  ? `Pinned at ${form.lat}, ${form.lng}. Drag the pin to adjust.`
                  : "Type the latitude and longitude, or click the map onto the pump's exact location."}
              </span>
              <button
                type="button"
                onClick={() => void fillMyLocation()}
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

      {editing && (
        <>
          <StationDetailsEditor
            key={`details-${editingId}`}
            station={editing}
            onSaved={loadStations}
            onClose={() => setEditingId(null)}
          />
          <StationImagesEditor
            key={`photos-${editingId}`}
            station={editing}
            onClose={() => setEditingId(null)}
            onSaved={loadStations}
          />
        </>
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
              onEdit={() => setEditingId(String(s._id))}
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
  onEdit,
}: {
  station: VendorStation;
  onBookings: () => void;
  onPrices: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const pumpPhotos = (
    [
      ["Petrol pump", uploadUrl(s.pumpImages?.petrol ?? null)],
      ["CNG pump", uploadUrl(s.pumpImages?.cng ?? null)],
    ] as const
  ).filter(([, url]) => url);
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
        {/* Only the fuels this station sells. */}
        {soldFuels(s.fuelTypes).map((f) => (
          <div key={f} className="vm-bg-ground p-3 rounded-lg border vm-border">
            <p className="text-[10px] vm-text-muted uppercase">{f}</p>
            <p className="font-bold text-sm">₹{prices[f] ?? "N/A"}</p>
          </div>
        ))}
      </div>

      <NozzleModes station={s} />
      <SlotTimings station={s} />

      <div className="flex items-center gap-2 text-xs vm-text-muted mb-4">
        <span>{s.fuelTypes?.join(", ") || "No fuels listed"}</span>
        <span>•</span>
        <span>{s.openingHours || "24 Hours"}</span>
      </div>

      {pumpPhotos.length > 0 && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          {pumpPhotos.map(([label, url]) => (
            <figure key={label} className="m-0">
              <img
                src={url as string}
                alt={`${label} image`}
                className="w-full h-24 object-cover rounded-lg"
                style={{ border: "1px solid var(--z-line)" }}
              />
              <figcaption className="text-[10px] vm-text-muted uppercase mt-1">{label}</figcaption>
            </figure>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={onEdit}
          className="flex-1 vm-bg-ground vm-hover border vm-border rounded-lg py-2 text-xs font-bold transition-colors"
        >
          <i className="fas fa-pen-to-square mr-1" aria-hidden /> Edit Station
        </button>
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
