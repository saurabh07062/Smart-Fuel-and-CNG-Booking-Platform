import { useState } from "react";
import type { Station } from "@/types";
// The draggable pin under the coordinate inputs: typing moves the pin and
// dragging writes the inputs, since typed coordinates are never trusted
// without seeing them on the map.
import StationPinPicker from "@/components/maps/StationPinPicker";

export interface StationFormValues {
  name: string;
  address: string;
  openingHours: string;
  lat: string;
  lng: string;
  petrol: string;
  diesel: string;
  cng: string;
  photoUrl: string;
  fuelTypes: string;
  amenities: string;
  status: string;
}

/** The defaults the Vanilla form pre-filled, unchanged. */
export const STATION_DEFAULTS: StationFormValues = {
  name: "",
  address: "",
  openingHours: "24 Hours",
  lat: "",
  lng: "",
  petrol: "96.72",
  diesel: "89.62",
  cng: "75.5",
  photoUrl: "",
  fuelTypes: "Petrol, Diesel, CNG",
  amenities: "",
  status: "Active",
};

export function valuesFromStation(s: Station & Record<string, unknown>): StationFormValues {
  const prices = (s.prices ?? {}) as Record<string, number | undefined>;
  return {
    name: s.name ?? "",
    address: s.address ?? "",
    openingHours: (s.openingHours as string) ?? "24 Hours",
    lat: s.coordinates?.lat != null ? String(s.coordinates.lat) : "",
    lng: s.coordinates?.lng != null ? String(s.coordinates.lng) : "",
    petrol: String(prices.petrol ?? 96.72),
    diesel: String(prices.diesel ?? 89.62),
    cng: String(prices.cng ?? 75.5),
    photoUrl: s.images?.[0] ?? "",
    fuelTypes: (s.fuelTypes ?? []).join(", "),
    amenities: (s.amenities ?? []).join(", "),
    status: s.status ?? "Active",
  };
}

/**
 * Build the request body from the form.
 *
 * Ported field-for-field from saveStationDetails()/createNewStation(),
 * including the details that matter: an unparseable price falls back to the
 * same default the input was seeded with (never NaN, which the API would
 * reject), coordinates are omitted entirely unless BOTH parse, and an empty
 * photo URL sends `images: []` so clearing the field actually removes the
 * photo rather than leaving the old one.
 */
export function toPayload(v: StationFormValues): Record<string, unknown> {
  const num = (raw: string, fallback: number) => {
    const n = parseFloat(raw);
    return Number.isNaN(n) ? fallback : n;
  };

  const payload: Record<string, unknown> = {
    name: v.name.trim(),
    address: v.address.trim(),
    openingHours: v.openingHours.trim() || "24 Hours",
    prices: {
      petrol: num(v.petrol, 96.72),
      diesel: num(v.diesel, 89.62),
      cng: num(v.cng, 75.5),
    },
    status: v.status,
    images: v.photoUrl.trim() ? [v.photoUrl.trim()] : [],
  };

  const lat = parseFloat(v.lat);
  const lng = parseFloat(v.lng);
  if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
    payload.coordinates = { lat, lng };
  }

  const list = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  if (v.fuelTypes.trim()) payload.fuelTypes = list(v.fuelTypes);
  if (v.amenities.trim()) payload.amenities = list(v.amenities);

  return payload;
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="block text-xs font-bold vm-text-muted mb-2">{label}</label>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-bold vm-accent-text uppercase tracking-wider mb-4">{title}</h3>
      {children}
    </div>
  );
}

interface Props {
  heading: string;
  subheading: string;
  saveLabel: string;
  initial: StationFormValues;
  saving?: boolean;
  onCancel: () => void;
  onSave: (values: StationFormValues) => void;
}

/**
 * The admin station editor -- one component for both create and edit, since
 * renderStationEditForm() and renderStationCreateForm() render the same
 * fields with different copy and a different submit handler.
 */
export default function StationForm({
  heading,
  subheading,
  saveLabel,
  initial,
  saving,
  onCancel,
  onSave,
}: Props) {
  const [v, setV] = useState<StationFormValues>(initial);
  const set = (k: keyof StationFormValues, value: string) => setV((f) => ({ ...f, [k]: value }));

  const inputCls = "w-full vm-input px-4 py-3 text-sm vm-text";

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="vm-stat-value" style={{ fontSize: 22 }}>
            {heading}
          </h2>
          <p className="vm-text-muted text-sm mt-1">{subheading}</p>
        </div>
        <button
          onClick={onCancel}
          className="vm-text-muted text-sm font-bold flex items-center gap-2 bg-transparent border-0"
        >
          <i className="fas fa-arrow-left" aria-hidden /> Back to List
        </button>
      </div>

      <div className="vm-bg-surface rounded-2xl border vm-border p-6 space-y-6">
        <Section title="Basic Information">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Station Name *">
              <input className={inputCls} value={v.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field label="Opening Hours">
              <input
                className={inputCls}
                value={v.openingHours}
                onChange={(e) => set("openingHours", e.target.value)}
              />
            </Field>
          </div>
          <div className="mt-4">
            <Field label="Address *">
              <input
                className={inputCls}
                value={v.address}
                onChange={(e) => set("address", e.target.value)}
              />
            </Field>
          </div>
        </Section>

        <Section title="Location Coordinates">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Latitude">
              <input
                type="number"
                step="any"
                className={inputCls}
                value={v.lat}
                onChange={(e) => set("lat", e.target.value)}
              />
            </Field>
            <Field label="Longitude">
              <input
                type="number"
                step="any"
                className={inputCls}
                value={v.lng}
                onChange={(e) => set("lng", e.target.value)}
              />
            </Field>
          </div>
          <p className="text-xs vm-text-muted mt-3 mb-2">
            Drag the pin (or click the map) onto the station&apos;s real location. Typed coordinates
            are never trusted without visual confirmation — this is what actually gets used for
            customer navigation.
          </p>
          <StationPinPicker id="station-location-picker"
            lat={v.lat}
            lng={v.lng}
            onChange={(la, ln) => setV((f) => ({ ...f, lat: String(la), lng: String(ln) }))}
          />
        </Section>

        <Section title="Fuel Prices (₹)">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Field label="Petrol (₹/L)">
              <input type="number" step="0.01" className={inputCls} value={v.petrol} onChange={(e) => set("petrol", e.target.value)} />
            </Field>
            <Field label="Diesel (₹/L)">
              <input type="number" step="0.01" className={inputCls} value={v.diesel} onChange={(e) => set("diesel", e.target.value)} />
            </Field>
            <Field label="CNG (₹/Kg)">
              <input type="number" step="0.01" className={inputCls} value={v.cng} onChange={(e) => set("cng", e.target.value)} />
            </Field>
          </div>
        </Section>

        <Section title="Station Photo">
          <div className="flex items-center gap-6">
            <div className="w-32 h-32 rounded-xl vm-bg-ground border vm-border overflow-hidden flex items-center justify-center">
              {v.photoUrl ? (
                <img src={v.photoUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <i className="fas fa-gas-pump text-3xl vm-text-muted" aria-hidden />
              )}
            </div>
            <div className="flex-1">
              <input
                type="text"
                placeholder="Paste image URL here"
                className={`${inputCls} mb-3`}
                value={v.photoUrl}
                onChange={(e) => set("photoUrl", e.target.value)}
              />
              <p className="text-xs vm-text-muted mb-2">Or upload an image file:</p>
              <input
                type="file"
                accept="image/*"
                aria-label="Upload station photo"
                className="text-xs vm-text-muted file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:vm-accent file:vm-text file:font-bold file:cursor-pointer"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  // Same as handleStationPhotoUpload(): the file is inlined as
                  // a data URL into the same `images[0]` string the URL box
                  // feeds. This endpoint takes a string, not multipart -- only
                  // the vendor panel's station route has a multer field.
                  const reader = new FileReader();
                  reader.onload = () => set("photoUrl", String(reader.result ?? ""));
                  reader.readAsDataURL(file);
                }}
              />
            </div>
          </div>
        </Section>

        <Section title="Additional Details">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Fuel Types (comma separated)">
              <input
                className={inputCls}
                placeholder="Petrol, Diesel, CNG"
                value={v.fuelTypes}
                onChange={(e) => set("fuelTypes", e.target.value)}
              />
            </Field>
            <Field label="Amenities (comma separated)">
              <input
                className={inputCls}
                placeholder="ATM, Air, Water, Restroom"
                value={v.amenities}
                onChange={(e) => set("amenities", e.target.value)}
              />
            </Field>
          </div>
        </Section>

        <Section title="Station Status">
          <select
            className="w-full md:w-1/2 vm-input px-4 py-3 text-sm vm-text"
            value={v.status}
            onChange={(e) => set("status", e.target.value)}
            aria-label="Station status"
          >
            <option value="Active">Active (Visible to customers)</option>
            <option value="Inactive">Inactive (Hidden from customers)</option>
          </select>
        </Section>

        <div className="flex justify-end gap-3 pt-4 border-t vm-border">
          <button onClick={onCancel} className="vm-btn vm-btn-ghost">
            Cancel
          </button>
          <button
            onClick={() => onSave(v)}
            disabled={saving}
            className="px-6 py-2.5 vm-accent vm-accent-hover vm-text font-bold rounded-lg transition-colors flex items-center gap-2"
          >
            <i className="fas fa-save" aria-hidden /> {saving ? "Saving…" : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
