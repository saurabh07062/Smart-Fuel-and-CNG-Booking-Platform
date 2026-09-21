import { useState } from "react";
import type { VendorStation } from "@/services/api/vendorApi";
import { updateVendorStation } from "@/services/api/vendorApi";
import { toApiError } from "@/services/api/apiClient";
import { pushToast } from "@/store/toastStore";
import { useAuthStore } from "@/store/authStore";
import StationPinPicker from "@/components/maps/StationPinPicker";
import { geoJsonToLatLng, getLastKnownUserCoords, isValidCoordinate } from "@/utils/geo";
import {
  LARGE_MOVE_METERS,
  NEAR_DEVICE_METERS,
  coordinateError,
  distanceMeters,
  formatDistance,
  parseCoordinatePair,
} from "@/utils/coordinates";
import { VENDOR_FUELS, soldFuels, toVendorFuels, type VendorFuel } from "@/utils/vendorFuels";

/** The station's saved position as editable text: legacy {lat,lng} first, else GeoJSON. */
function savedPosition(s: VendorStation): { lat: string; lng: string } {
  const legacy = s.coordinates;
  if (legacy && isValidCoordinate(legacy.lat, legacy.lng)) return { lat: String(legacy.lat), lng: String(legacy.lng) };
  const geo = geoJsonToLatLng(s.location?.coordinates);
  return geo ? { lat: String(geo.lat), lng: String(geo.lng) } : { lat: "", lng: "" };
}

/**
 * Edit Station: name, address, opening hours, the fuels it sells and its exact
 * location (typed, pasted from Google Maps, or pinned on the map). Prices keep
 * their own dialog (price history) and photos their own section.
 */
export default function StationDetailsEditor({
  station,
  onSaved,
  onClose,
}: {
  station: VendorStation;
  onSaved: () => void | Promise<void>;
  /** Called after a successful save: the editor closes itself. */
  onClose?: () => void;
}) {
  const vendorFuelTypes = useAuthStore((s) => s.user?.vendorFuelTypes);
  const allowed = soldFuels(vendorFuelTypes);

  const [form, setForm] = useState(() => ({
    name: station.name ?? "",
    address: station.address ?? "",
    hours: station.openingHours ?? "24 Hours",
    ...savedPosition(station),
  }));
  const [fuels, setFuels] = useState<VendorFuel[]>(() => {
    const current = toVendorFuels(station.fuelTypes);
    return current.length ? current.filter((f) => allowed.includes(f)) : allowed;
  });
  const [saving, setSaving] = useState(false);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  /** A pasted "lat, lng" pair fills both boxes at once. */
  const onCoordinateInput = (k: "lat" | "lng", value: string) => {
    const pair = parseCoordinatePair(value);
    if (pair) {
      setForm((f) => ({ ...f, lat: pair.lat, lng: pair.lng }));
      return;
    }
    set(k, value.trim());
  };

  const latError = coordinateError(form.lat, "Latitude", 90);
  const lngError = coordinateError(form.lng, "Longitude", 180);
  const pinned = !latError && !lngError && isValidCoordinate(Number(form.lat), Number(form.lng));
  const saved = savedPosition(station);
  const moved = pinned && (Number(form.lat) !== Number(saved.lat) || Number(form.lng) !== Number(saved.lng));
  const next = { lat: Number(form.lat), lng: Number(form.lng) };
  const hadSaved = isValidCoordinate(Number(saved.lat), Number(saved.lng));
  const moveMeters = moved && hadSaved ? distanceMeters({ lat: Number(saved.lat), lng: Number(saved.lng) }, next) : 0;
  const largeMove = moveMeters > LARGE_MOVE_METERS;
  // The device's own last known position: a pin right there is usually
  // "your location" copied by mistake, not the pump.
  const device = getLastKnownUserCoords();
  const nearDevice = moved && pinned && device !== null && distanceMeters(device, next) < NEAR_DEVICE_METERS;

  const save = async () => {
    if (!form.name.trim() || !form.address.trim()) {
      pushToast("Station name and address are required", "error");
      return;
    }
    if (latError || lngError) {
      pushToast(latError || lngError || "", "error");
      return;
    }
    if (!pinned) {
      pushToast("Enter the latitude and longitude, or pin the station's exact location on the map", "error");
      return;
    }
    if (fuels.length === 0) {
      pushToast("Select at least one fuel this station sells", "error");
      return;
    }
    if (
      largeMove &&
      !window.confirm(
        `This moves the station ${formatDistance(moveMeters)} from its saved location.\n\n` +
          `New: ${next.lat}, ${next.lng}\n\n` +
          "Customers will be navigated to the new point. Save it?",
      )
    ) {
      return;
    }
    setSaving(true);
    try {
      await updateVendorStation(String(station._id), {
        name: form.name.trim(),
        address: form.address.trim(),
        openingHours: form.hours.trim() || "24 Hours",
        fuelTypes: VENDOR_FUELS.filter((f) => fuels.includes(f.key)).map((f) => f.label),
        coordinates: { lat: Number(form.lat), lng: Number(form.lng) },
        // Refused (409) if the station was changed since this form opened, so
        // a stale form cannot overwrite a newer, correct location.
        expectedUpdatedAt: station.updatedAt,
      });
      pushToast("Station details saved", "success");
      await onSaved();
      onClose?.();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setSaving(false);
    }
  };

  const input = "w-full vm-input px-4 py-2.5 text-sm vm-text";

  return (
    <div className="vm-bg-surface rounded-2xl border vm-border p-6 mb-4" role="region" aria-label="Station details">
      <h3 className="text-lg font-bold mb-1 flex items-center gap-2">
        <i className="fas fa-pen-to-square vm-accent-text" aria-hidden /> Edit Station
      </h3>
      <p className="vm-subtitle mb-4" style={{ fontSize: "12px" }}>
        Details and exact location. Prices are changed with the Prices button (price history is kept).
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Station Name *">
          <input className={input} aria-label="Station Name" value={form.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Opening Hours">
          <input className={input} aria-label="Opening Hours" value={form.hours} onChange={(e) => set("hours", e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Address *">
            <input className={input} aria-label="Address" value={form.address} onChange={(e) => set("address", e.target.value)} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <p className="block text-xs font-bold vm-text-muted mb-2">Fuels Sold *</p>
          <div className="flex flex-wrap gap-4" role="group" aria-label="Fuels Sold">
            {VENDOR_FUELS.filter((f) => allowed.includes(f.key)).map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-sm vm-text">
                <input
                  type="checkbox"
                  checked={fuels.includes(f.key)}
                  onChange={(e) =>
                    setFuels((cur) => (e.target.checked ? [...cur, f.key] : cur.filter((k) => k !== f.key)))
                  }
                />
                {f.label}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-5">
        <p className="block text-xs font-bold vm-text-muted mb-2">Station Location *</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-3">
          {(
            [
              ["lat", "Latitude", latError],
              ["lng", "Longitude", lngError],
            ] as const
          ).map(([k, label, error]) => (
            <Field key={k} label={`${label} *`}>
              <input
                type="text"
                inputMode="decimal"
                aria-label={label}
                aria-invalid={Boolean(error)}
                className={input}
                placeholder={k === "lat" ? "e.g. 18.580563" : "e.g. 73.975342"}
                value={form[k]}
                onChange={(e) => onCoordinateInput(k, e.target.value)}
              />
              {error && (
                <p role="alert" className="text-xs mt-1" style={{ color: "var(--status-bad)" }}>
                  {error}
                </p>
              )}
            </Field>
          ))}
        </div>
        <p className="text-xs vm-text-muted mb-3">
          <i className="fas fa-lightbulb mr-1" aria-hidden />
          Tip: in Google Maps right-click exactly on the pump, click the numbers, and paste them into either box — both
          fill in from the same spot.
        </p>
        <StationPinPicker lat={form.lat} lng={form.lng} onChange={(la, ln) => setForm((f) => ({ ...f, lat: la.toFixed(6), lng: ln.toFixed(6) }))} followPin />
        {moved && (
          <p className="text-xs mt-2" style={{ color: "var(--z-amber)" }} data-testid="location-moved">
            <i className="fas fa-location-arrow mr-1" aria-hidden />
            Location will move{hadSaved ? ` ${formatDistance(moveMeters)}` : ""} from {Number(saved.lat).toFixed(6)},{" "}
            {Number(saved.lng).toFixed(6)} to {Number(form.lat).toFixed(6)}, {Number(form.lng).toFixed(6)} when you save.
          </p>
        )}
        {largeMove && (
          <p role="alert" className="text-xs mt-2 font-bold" style={{ color: "var(--status-bad)" }} data-testid="large-move">
            <i className="fas fa-triangle-exclamation mr-1" aria-hidden />
            That is {formatDistance(moveMeters)} from the saved location. Zoom in and check the pin is on the pump
            before saving.
          </p>
        )}
        {nearDevice && (
          <p role="alert" className="text-xs mt-2 font-bold" style={{ color: "var(--status-bad)" }} data-testid="near-device">
            <i className="fas fa-person mr-1" aria-hidden />
            This point is where you are right now. If you copied "Your location" from Google Maps, use the pump&apos;s own
            coordinates instead.
          </p>
        )}
      </div>

      <div className="flex justify-end gap-3 mt-6">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="vm-bg-ground vm-hover border vm-border vm-text font-bold py-2.5 px-4 rounded-lg transition-colors text-sm"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="vm-accent vm-accent-hover vm-text font-bold py-2.5 px-4 rounded-lg transition-colors text-sm flex items-center gap-2 disabled:opacity-50"
        >
          <i className="fas fa-save" aria-hidden /> {saving ? "Saving…" : "Save Details"}
        </button>
      </div>
    </div>
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
