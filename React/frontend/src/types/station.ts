import type { FuelKey } from "./api";

export interface Coordinates {
  lat: number;
  lng: number;
}

/** GeoJSON Point, [lng, lat] -- the order the 2dsphere index uses. */
export interface GeoPoint {
  type: "Point";
  coordinates: [number, number];
}

export interface Station {
  _id: string;
  name: string;
  address: string;
  city?: string;
  owner?: string | null;
  status: "Active" | "Inactive";
  fuelTypes: string[];
  prices: Record<FuelKey, number>;
  inventory?: Record<FuelKey, number>;
  /** Per-fuel availability, separate from stock. */
  fuelAvailability?: Record<FuelKey, boolean>;
  isBusy?: boolean;
  unavailableReason?: string | null;
  coordinates?: Coordinates | null;
  location?: GeoPoint;
  queueLength?: number;
  waitMinutes?: number | null;
  queueStatus?: "Low" | "Moderate" | "High" | "Very High" | "Unknown";
  images?: string[];
  rating?: number;
  amenities?: string[];
  openingHours?: string;
  pricesUpdatedAt?: string | null;
  availabilityUpdatedAt?: string | null;
  updatedAt?: string;
}

/**
 * A station AFTER mapBackendStation() has normalised it -- the shape every
 * customer-facing component reads.
 *
 * It exists because the server sends two coordinate representations, two
 * price casings and two names for the queue, and the Vanilla app resolved
 * all of that in one function (app.js mapBackendStation). Keeping that one
 * function, and giving its output a name, is what stops each component
 * re-deriving `s.prices?.Petrol ?? s.prices?.petrol` for itself.
 */
export interface UiStation extends Station {
  id: string;
  /** Title-case, resolved from either casing the API may send; null = not published. */
  uiPrices: { Petrol: number | null; Diesel: number | null; CNG: number | null };
  lat: number | null;
  lng: number | null;
  coordinates: Coordinates | null;
  hours: string;
  open: boolean;
  image: string | null;
  queue: number;
  waitTime: number;
  distance: number | null;
  reviews: number;
}

/**
 * One bookable 30-minute slot label at a station, as services/station/stationFinder.js
 * reports it from the single-nozzle scheduler. `slot` is the label POST
 * /api/bookings accepts ("10:30 AM").
 */
export interface SlotInfo {
  slot: string;
  /** "HH:MM", 24-hour. */
  start: string;
  end: string;
  capacity: number;
  booked: number;
  available: number;
  status: "AVAILABLE" | "FULL" | string;
}

/**
 * One row from GET /api/stations/nearby -- the ranked discovery result.
 *
 * These fields are produced by services/station/discovery.js (geo search),
 * stationFinder.js, nozzleScheduler.js and queue.js. NOTHING here is computed in the browser:
 * distance, estimatedWaitingTime, matchScore, the slot list and the
 * recommendedAlternative all arrive already decided by the server, and the
 * React page only renders them. That is the whole point of the "consume the
 * existing algorithm" rule.
 */
export interface NearbyStation {
  stationId: string;
  stationName: string;
  address: string;
  distance: number;
  latitude: number;
  longitude: number;
  /** The fuel that was searched for, upper-case. */
  fuelType?: string;
  fuelTypes: string[];
  /** null when the station doesn't sell the fuel or hasn't published a price. */
  petrolPrice?: number | null;
  dieselPrice?: number | null;
  cngPrice?: number | null;
  /** Price of the SEARCHED fuel, chosen server-side; null if unpublished. */
  _fuelPriceForDisplay?: number | null;
  currentQueue?: number;
  estimatedWaitingTime?: number;
  currentSlot?: SlotInfo | null;
  nextAvailableSlot?: SlotInfo | null;
  recommendedSlots?: SlotInfo[];
  preferredSlot?: SlotInfo | null;
  isOpen?: boolean;
  nextOpenTime?: string | null;
  canBook?: boolean;
  /** Why canBook is false: NO_PRICE, OUT_OF_STOCK, INSUFFICIENT_STOCK, NO_SLOT_TODAY, INACTIVE. */
  unavailableCode?: string | null;
  unavailableReason?: string | null;
  /** 0 bookable & open, 1 bookable later today, 2 cannot be booked. */
  rankTier?: number;
  waitBasis?: string;
  recommendedAlternative?: {
    stationId?: string;
    name: string;
    distanceKm: number;
    waitMinutes?: number;
    totalTripTimeMinutes?: number;
    timeSavedMinutes?: number | null;
    reason: string;
  } | null;
  matchScore?: number;
  matchBreakdown?: Record<string, number>;
}

/** What the dashboard search hands to the results page, and persists. */
export interface NearestPumpResult {
  stations: NearbyStation[];
  fuelType: string;
  origin: Coordinates;
  searchedAt: number;
}
