import { useState } from "react";
import { soldFuels } from "@/utils/vendorFuels";
import type { Station } from "@/types";
// The draggable pin under the coordinate inputs: typing moves the pin and
// dragging writes the inputs, since typed coordinates are never trusted
// without seeing them on the map.
import StationPinPicker from "@/components/maps/StationPinPicker";

export interface StationFormValues {
  name: string;
  address: string;
  /** The label customers read ("24 Hours", "6 AM - 10 PM"). */
  openingHours: string;
  /** Real per-day timings: these two write operatingSchedule for every day. */
  opensAt: string;
  closesAt: string;
  /** "" = open all day; the times above are ignored. */
  allDay: boolean;
  contactPhone: string;
  lat: string;
  lng: string;
  petrol: string;
  diesel: string;
  cng: string;
  fuelTypes: string;
  amenities: string;
  status: string;
  /** Per-fuel availability: stock can be full while a pump is out of service. */
  petrolAvailable: boolean;
  dieselAvailable: boolean;
  cngAvailable: boolean;
}

/**
 * What a brand-new station starts as.
 *
 * The price boxes are EMPTY. They used to open pre-filled with 96.72 /
 * 89.62 / 75.5 -- numbers that came from nowhere, were saved if nobody
 * noticed, and then showed to customers as this station's rate. A price is
 * the vendor's to state; until they do, the station simply has none.
 */
export const STATION_DEFAULTS: StationFormValues = {
  name: "",
  address: "",
  openingHours: "24 Hours",
  opensAt: "",
  closesAt: "",
  allDay: true,
  contactPhone: "",
  lat: "",
  lng: "",
  petrol: "",
  diesel: "",
  cng: "",
  fuelTypes: "Petrol, Diesel, CNG",
  amenities: "",
  status: "Active",
  petrolAvailable: true,
  dieselAvailable: true,
  cngAvailable: true,
};

/** Every day of the week, as operatingSchedule stores them. */
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

export function valuesFromStation(s: Station & Record<string, unknown>): StationFormValues {
  const prices = (s.prices ?? {}) as Record<string, number | undefined>;
  // A price of 0 means "not published", and an empty box says that
  // honestly. Filling it with a default would invent a rate for a station
  // whose owner has not set one.
  const price = (v: number | undefined) => (typeof v === "number" && v > 0 ? String(v) : "");

  const schedule = (s.operatingSchedule ?? {}) as Record<string, { open?: string; close?: string; is24h?: boolean; closed?: boolean } | undefined>;
  const firstDay = DAYS.map((d) => schedule[d]).find(Boolean);
  const availability = (s.fuelAvailability ?? {}) as Record<string, boolean | undefined>;

  return {
    name: s.name ?? "",
    address: s.address ?? "",
    openingHours: (s.openingHours as string) ?? "24 Hours",
    opensAt: firstDay?.open ?? "",
    closesAt: firstDay?.close ?? "",
    allDay: firstDay ? Boolean(firstDay.is24h) : (s.openingHours as string) === "24 Hours",
    contactPhone: (s.contactPhone as string) ?? "",
    lat: s.coordinates?.lat != null ? String(s.coordinates.lat) : "",
    lng: s.coordinates?.lng != null ? String(s.coordinates.lng) : "",
    petrol: price(prices.petrol),
    diesel: price(prices.diesel),
    cng: price(prices.cng),
    fuelTypes: (s.fuelTypes ?? []).join(", "),
    amenities: (s.amenities ?? []).join(", "),
    status: s.status ?? "Active",
    petrolAvailable: availability.petrol !== false,
    dieselAvailable: availability.diesel !== false,
    cngAvailable: availability.cng !== false,
  };
}

/**
 * Build the request body from the form.
 *
 * What is sent is what was typed. An empty price box sends 0 -- the
 * server's own way of saying "not published" -- instead of the invented
 * default this form used to fall back to, which quietly gave a station a
 * rate nobody had set. Coordinates are omitted unless BOTH parse, and an
 * empty photo URL sends `images: []` so clearing the field really removes
 * the photo.
 */
export function toPayload(v: StationFormValues): Record<string, unknown> {
  // "" and anything unparseable mean "no price published", which is 0 in
  // the API and reads as "Not set" everywhere it is shown.
  const price = (raw: string) => {
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  const payload: Record<string, unknown> = {
    name: v.name.trim(),
    address: v.address.trim(),
    openingHours: v.openingHours.trim() || "24 Hours",
    contactPhone: v.contactPhone.trim(),
    prices: {
      petrol: price(v.petrol),
      diesel: price(v.diesel),
      cng: price(v.cng),
    },
    fuelAvailability: {
      petrol: v.petrolAvailable,
      diesel: v.dieselAvailable,
      cng: v.cngAvailable,
    },
    status: v.status,
    // No `images` key: the station's photo is the vendor's to set (their
    // panel uploads a real file, this form only ever pasted a URL or a
    // base64 blob), and sending it from here would overwrite theirs -- or
    // erase it, which is what an empty box used to do.
  };

  // Opening and closing time, written to every day of the week. This is the
  // schedule the booking slots are generated from -- the "Opening Hours"
  // line above it is only the label customers read.
  if (v.allDay) {
    payload.operatingSchedule = Object.fromEntries(
      DAYS.map((d) => [d, { is24h: true, closed: false, open: "", close: "" }]),
    );
  } else if (v.opensAt && v.closesAt) {
    payload.operatingSchedule = Object.fromEntries(
      DAYS.map((d) => [d, { is24h: false, closed: false, open: v.opensAt, close: v.closesAt }]),
    );
  }

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
  // Most fields are text; the day/availability switches are booleans.
  const set = (k: keyof StationFormValues, value: string | boolean) =>
    setV((f) => ({ ...f, [k]: value }));

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
          {/*
            Real opening and closing times, written to every day of the week
            (operatingSchedule). The line above is only the label customers
            read; THESE are what the bookable slots are generated from, so a
            station that closes at 10 PM stops offering 11 PM slots.
          */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
            <Field label="Open all day">
              <label className="flex items-center gap-2 h-[42px]">
                <input
                  type="checkbox"
                  checked={v.allDay}
                  onChange={(e) => set("allDay", e.target.checked)}
                  style={{ width: 18, height: 18, accentColor: "var(--z-accent)" }}
                />
                <span className="text-[12.5px] vm-text-muted">24 hours, every day</span>
              </label>
            </Field>
            <Field label="Opens at">
              <input
                type="time"
                className={inputCls}
                value={v.opensAt}
                disabled={v.allDay}
                onChange={(e) => set("opensAt", e.target.value)}
                style={v.allDay ? { opacity: 0.45 } : undefined}
              />
            </Field>
            <Field label="Closes at">
              <input
                type="time"
                className={inputCls}
                value={v.closesAt}
                disabled={v.allDay}
                onChange={(e) => set("closesAt", e.target.value)}
                style={v.allDay ? { opacity: 0.45 } : undefined}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            <Field label="Address *">
              <input
                className={inputCls}
                value={v.address}
                onChange={(e) => set("address", e.target.value)}
              />
            </Field>
            <Field label="Station phone number">
              <input
                className={inputCls}
                inputMode="numeric"
                maxLength={10}
                placeholder="10-digit number at the pump"
                value={v.contactPhone}
                onChange={(e) => set("contactPhone", e.target.value.replace(/\D/g, "").slice(0, 10))}
              />
            </Field>
          </div>
        </Section>

        {/*
          Availability is not stock: a pump can be out of service with a full
          tank, and a customer must not be offered a fuel nobody can serve.
          Only the fuels this station sells are listed.
        */}
        <Section title="Fuel Availability">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {soldFuels(v.fuelTypes.split(",").map((x) => x.trim()).filter(Boolean)).map((fuel) => {
              const key = `${fuel}Available` as "petrolAvailable" | "dieselAvailable" | "cngAvailable";
              const on = v[key];
              return (
                <label
                  key={fuel}
                  className="flex items-center justify-between gap-3 rounded-xl px-3.5 py-3 cursor-pointer"
                  style={{ background: "var(--z-ground)", border: `1px solid ${on ? "var(--z-accent)" : "var(--z-line)"}` }}
                >
                  <span className="text-[13px] font-bold vm-text capitalize">{fuel}</span>
                  <span className="flex items-center gap-2">
                    <span className={`vm-pill ${on ? "t-good" : "t-bad"}`}>{on ? "Available" : "Out of service"}</span>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => set(key, e.target.checked)}
                      aria-label={`${fuel} available`}
                      style={{ width: 18, height: 18, accentColor: "var(--z-accent)" }}
                    />
                  </span>
                </label>
              );
            })}
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

        {/* Only the fuels named above get a price box: a CNG-only station is
            not asked for a petrol price it will never use. */}
        <Section title="Fuel Prices (₹)">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {soldFuels(v.fuelTypes.split(",").map((x) => x.trim()).filter(Boolean)).map((fuel) => (
              <Field key={fuel} label={fuel === "cng" ? "CNG (₹/Kg)" : `${fuel[0].toUpperCase()}${fuel.slice(1)} (₹/L)`}>
                <input
                  type="number"
                  step="0.01"
                  className={inputCls}
                  value={v[fuel]}
                  onChange={(e) => set(fuel, e.target.value)}
                />
              </Field>
            ))}
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
