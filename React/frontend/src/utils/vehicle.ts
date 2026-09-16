import type { BookingDraft, Vehicle } from "@/types";

/**
 * Vehicle helpers, ported verbatim from frontend/js/utils.js.
 *
 * The keyword lists are copied unchanged: they are a convenience nudge while
 * typing, never a hard classifier, and shortening or "improving" them would
 * change which vehicles get auto-detected -- a behaviour change.
 */

export const VEHICLE_TYPE_ICONS: Record<string, string> = {
  Car: "fa-car-side",
  Bike: "fa-motorcycle",
  Scooter: "fa-motorcycle",
  Other: "fa-truck-pickup",
};

export function getVehicleIcon(type?: string): string {
  return VEHICLE_TYPE_ICONS[type ?? ""] || VEHICLE_TYPE_ICONS.Other;
}

const VEHICLE_BIKE_KEYWORDS = [
  "royal enfield", "splendor", "splendour", "pulsar", "activa", "access", " fz",
  "apache", "duke", "classic 350", "ntorq", "jupiter", "scooty", "harley",
  "ktm", "bajaj", "tvs", "hero", "yamaha", "vespa", "scooter", "moped",
  "gixxer", "avenger", "dominar", "himalayan", "meteor", "shine", "unicorn",
];

const VEHICLE_CAR_KEYWORDS = [
  "swift", "alto", "baleno", "city", "creta", "innova", "fortuner", "nexon",
  "verna", "seltos", "tiago", "punch", "xuv", "scorpio", "thar", "venue",
  "i20", "i10", "wagon r", "ertiga", "brezza", "civic", "corolla", "camry",
  "tesla", "bmw", "audi", "mercedes", "toyota", "honda", "hyundai", "maruti",
  "tata", "mahindra", "kia", "ford", "volkswagen", "skoda", "nissan", "renault",
];

/**
 * Guess Car vs Bike from free-text brand/model. Returns null (not "Other")
 * when nothing matches, so the caller leaves the user's current selection
 * alone instead of forcing a wrong guess.
 */
export function detectVehicleType(brand?: string, model?: string): "Bike" | "Car" | null {
  const text = `${brand || ""} ${model || ""}`.toLowerCase();
  if (!text.trim()) return null;
  if (VEHICLE_BIKE_KEYWORDS.some((k) => text.includes(k))) return "Bike";
  if (VEHICLE_CAR_KEYWORDS.some((k) => text.includes(k))) return "Car";
  return null;
}

export const VEHICLE_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
export const VEHICLE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** js/utils.js validateImageFile(). Same limits, same messages. */
export function validateImageFile(
  file: File,
  maxBytes = VEHICLE_IMAGE_MAX_BYTES,
): { ok: true } | { ok: false; msg: string } {
  if (!VEHICLE_IMAGE_TYPES.includes(file.type)) {
    return { ok: false, msg: "Please choose a JPG, PNG or WEBP image." };
  }
  if (file.size > maxBytes) {
    return { ok: false, msg: `Image is too large. Maximum ${Math.round(maxBytes / (1024 * 1024))}MB.` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------
   Booking-flow vehicle helpers
   ------------------------------------------------------------------ */

/** The three choices the booking wizard offers when adding a vehicle. */
export const BOOKING_VEHICLE_TYPES = [
  { id: "Car", hint: "Hatchback, sedan, SUV" },
  { id: "Bike", hint: "Motorcycle or scooter" },
  { id: "Other", hint: "Auto, van, truck" },
] as const;

export type VehicleArtKind = "car" | "bike" | "other";

/**
 * Which illustration a vehicle type gets. A missing type reads as a car,
 * matching the `v.vehicleType || "Car"` default used everywhere else.
 */
export function vehicleArtKind(type?: string | null): VehicleArtKind {
  const t = (type || "Car").toLowerCase();
  if (t === "car") return "car";
  if (t === "bike" || t === "scooter") return "bike";
  return "other";
}

/** Uppercase, letters and digits only: "mh 12-ab 1234" -> "MH12AB1234". */
export function normalisePlate(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Deliberately loose. The backend accepts any [A-Z0-9 ] string, and plates
 * outside the standard state format (BH series, temporary, older formats)
 * are real -- this only rules out obvious typos.
 */
export function isValidPlate(plate: string): boolean {
  return /^[A-Z0-9]{4,12}$/.test(plate);
}

export function vehicleDisplayName(v: Vehicle): string {
  return v.nickname || `${v.brand || ""} ${v.model || ""}`.trim() || "Vehicle";
}

export interface DraftVehicle {
  plate: string;
  type: string;
  name: string;
  image?: string | null;
  /** True for a vehicle saved on the account, false for a one-time entry. */
  saved: boolean;
}

/**
 * The vehicle the booking will be made for, whichever way it was chosen:
 * a saved vehicle (looked up by id so edits elsewhere show up), or a
 * one-time vehicle held directly on the draft.
 */
export function resolveDraftVehicle(
  draft: Pick<BookingDraft, "vehicleId" | "vehiclePlate" | "vehicleType" | "vehicleName">,
  vehicles: Vehicle[],
): DraftVehicle | null {
  const saved = draft.vehicleId
    ? vehicles.find((v) => String(v._id) === String(draft.vehicleId))
    : undefined;

  if (saved) {
    return {
      plate: saved.registrationNumber || draft.vehiclePlate || "",
      type: saved.vehicleType || "Car",
      name: vehicleDisplayName(saved),
      image: saved.image,
      saved: true,
    };
  }

  if (!draft.vehiclePlate) return null;
  const type = draft.vehicleType || "Car";
  return {
    plate: draft.vehiclePlate,
    type,
    name: draft.vehicleName || `My ${type}`,
    image: null,
    // A vehicleId that is not in the list yet (profile still loading) is
    // still a saved vehicle.
    saved: !!draft.vehicleId,
  };
}
