const mongoose = require("mongoose");
const { isValidVpa } = require("../services/payment/upi");
const { clockParts, parseClock, atBusinessTime } = require("../config/businessTime");

const ReviewSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  userName: { type: String },
  rating: { type: Number, required: true },
  comment: { type: String },
  date: { type: Date, default: Date.now },
});

const StationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    address: { type: String, required: true },
    city: { type: String, default: "Pune" },
    state: { type: String, default: "Maharashtra" },

    openingHours: { type: String, default: "24 Hours" },

    // ---- structured operating schedule --------------------------------
    // Day-wise open/close times, India time. If a day is missing, falls back
    // to openingHours string. "is24h: true" means open all day.
    operatingSchedule: {
      monday:    { open: { type: String, default: "06:00" }, close: { type: String, default: "22:00" }, is24h: { type: Boolean, default: true }, isClosed: { type: Boolean, default: false } },
      tuesday:   { open: { type: String, default: "06:00" }, close: { type: String, default: "22:00" }, is24h: { type: Boolean, default: true }, isClosed: { type: Boolean, default: false } },
      wednesday: { open: { type: String, default: "06:00" }, close: { type: String, default: "22:00" }, is24h: { type: Boolean, default: true }, isClosed: { type: Boolean, default: false } },
      thursday:  { open: { type: String, default: "06:00" }, close: { type: String, default: "22:00" }, is24h: { type: Boolean, default: true }, isClosed: { type: Boolean, default: false } },
      friday:    { open: { type: String, default: "06:00" }, close: { type: String, default: "22:00" }, is24h: { type: Boolean, default: true }, isClosed: { type: Boolean, default: false } },
      saturday:  { open: { type: String, default: "06:00" }, close: { type: String, default: "22:00" }, is24h: { type: Boolean, default: true }, isClosed: { type: Boolean, default: false } },
      sunday:    { open: { type: String, default: "06:00" }, close: { type: String, default: "22:00" }, is24h: { type: Boolean, default: true }, isClosed: { type: Boolean, default: false } }
    },
    images: [{ type: String }],
    // One photo each of the station's petrol and CNG dispensers, uploaded by
    // its owner (PUT /api/vendor-panel/stations/:id/pump-images). Public
    // /uploads/stations paths from middleware/upload.js; null until uploaded,
    // never a placeholder.
    pumpImages: {
      petrol: { type: String, default: null },
      cng: { type: String, default: null },
    },
    rating: { type: Number, default: 4.5 },
    reviews: [ReviewSchema],

    fuelTypes: { type: [String], default: ["Petrol", "Diesel", "CNG"] },
    // No assumed amenities: a station lists what it actually has.
    amenities: { type: [String], default: [] },

    // Per-unit prices (₹/L, CNG ₹/kg). null = not published; a booking for
    // that fuel is refused rather than priced from a guess.
    prices: {
      petrol: { type: Number, default: null, min: 0 },
      diesel: { type: Number, default: null, min: 0 },
      cng: { type: Number, default: null, min: 0 },
    },
    // Current stock (L, CNG kg). Starts at 0 until the vendor records a delivery.
    inventory: {
      petrol: { type: Number, default: 0, min: 0 },
      diesel: { type: Number, default: 0, min: 0 },
      cng: { type: Number, default: 0, min: 0 },
    },
    // Stock promised to live bookings and not yet dispensed. Changed only by
    // services/inventory/stockLedger.js, in conditional single-document updates: a
    // booking is accepted only if inventory - inventoryCommitted covers it,
    // so stock cannot be over-sold even when two requests race.
    inventoryCommitted: {
      petrol: { type: Number, default: 0, min: 0 },
      diesel: { type: Number, default: 0, min: 0 },
      cng: { type: Number, default: 0, min: 0 },
    },
    // The real tank size per fuel, set by the vendor. Inventory tiers
    // (services/inventory/inventoryThreshold.js) are a percentage of this; null means
    // "not recorded", never an assumed 10,000 L.
    tankCapacity: {
      petrol: { type: Number, default: null, min: 0 },
      diesel: { type: Number, default: null, min: 0 },
      cng: { type: Number, default: null, min: 0 },
    },

    // ---- queueing model parameters (M/M/c) ----------------------------
    // Number of available pumps per fuel type
    pumpCounts: {
      cng: { type: Number, default: 1, min: 0 },
      petrol: { type: Number, default: 2, min: 0 },
      diesel: { type: Number, default: 2, min: 0 }
    },
    // Each fuel's nozzles split between app bookings and walk-ins, set by the
    // vendor (config/nozzleModes.js): { total, online }, online 0..total.
    // Unset = one nozzle shared by bookings and walk-ins.
    nozzleConfig: {
      petrol: { total: { type: Number, min: 1, max: 20 }, online: { type: Number, min: 0, max: 20 } },
      diesel: { total: { type: Number, min: 1, max: 20 }, online: { type: Number, min: 0, max: 20 } },
      cng: { total: { type: Number, min: 1, max: 20 }, online: { type: Number, min: 0, max: 20 } },
    },
    // The legacy nozzles field (kept for backward compatibility, mapped to total)
    nozzles: { type: Number, default: 4, min: 1 },

    // Live count of vehicles waiting, separated by fuel type (Layer 1 state)
    waitingCounts: {
      cng: { type: Number, default: 0, min: 0 },
      petrol: { type: Number, default: 0, min: 0 },
      diesel: { type: Number, default: 0, min: 0 }
    },
    // Live count of vehicles actively fueling (Layer 1 state)
    activeFuelingCounts: {
      cng: { type: Number, default: 0, min: 0 },
      petrol: { type: Number, default: 0, min: 0 },
      diesel: { type: Number, default: 0, min: 0 }
    },

    // Legacy fallback fields for simple access
    queueLength: { type: Number, default: 0, min: 0 },
    arrivalRatePerHour: { type: Number, default: null },
    observedAvgQueueLength: { type: Number, default: null },

    // Denormalised outputs of queue calculations for UI performance
    waitMinutes: { type: Number, default: null },
    queueStatus: {
      type: String,
      enum: ["Low", "Moderate", "High", "Very High", "Unknown"],
      default: "Unknown",
    },

    // ---- payment ------------------------------------------------------
    upiId: {
      type: String,
      trim: true,
      default: null,
      validate: {
        validator: (v) => !v || isValidVpa(v),
        message: (p) => `"${p.value}" is not a valid UPI ID (expected name@bank)`,
      },
    },
    upiName: { type: String, trim: true, default: null },
    acceptsUpi: { type: Boolean, default: true },

    // ---- live availability ---------------------------------------------
    // Per-fuel availability, separate from `inventory`. Stock can be high
    // while a pump is out of service.
    fuelAvailability: {
      petrol: { type: Boolean, default: true },
      diesel: { type: Boolean, default: true },
      cng: { type: Boolean, default: true },
    },
    isBusy: { type: Boolean, default: false },
    unavailableReason: { type: String, trim: true, default: null },

    pricesUpdatedAt: { type: Date, default: null },
    availabilityUpdatedAt: { type: Date, default: null },

    // Slots are not stored per station: bookable labels and nozzle
    // availability come from config/booking.js and services/queue/nozzleScheduler.js,
    // limited by operatingSchedule above. (The former slotCapacity /
    // availableTimeSlots fields described a capacity-count model that booking
    // never enforced.)

    // ---- location -----------------------------------------------------
    // GeoJSON Point in [lng, lat] order. This is what the 2dsphere index and
    // $geoNear operate on; `coordinates` below is the legacy {lat,lng} shape
    // kept in sync for older clients.
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number],
        validate: {
          validator: (v) =>
            !v ||
            v.length === 0 ||
            (v.length === 2 &&
              Math.abs(v[0]) <= 180 &&
              Math.abs(v[1]) <= 90),
          message: "location.coordinates must be [lng, lat] within valid ranges",
        },
      },
    },
    coordinates: {
      lat: { type: Number },
      lng: { type: Number },
    },

    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
      index: true,
    },

    // ---- provenance ---------------------------------------------------
    source: {
      type: String,
      enum: ["manual", "osm", "vendor"],
      default: "manual",
      index: true,
    },
    osmId: { type: String, unique: true, sparse: true },
    sourceUpdatedAt: { type: Date, default: null },
    brand: { type: String, trim: true, default: null, index: true },
  },
  { timestamps: true },
);

// Radius search ("stations within 5km") and $geoNear both require this.
StationSchema.index({ location: "2dsphere" }, { sparse: true });

// The customer list query is always "active stations, nearest first".
StationSchema.index({ status: 1, updatedAt: -1 });

/**
 * A usable position: finite, in range, and not the (0, 0) placeholder that
 * older code wrote when no location was known (a point in the Atlantic).
 */
function isRealPosition(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

/**
 * Keep the GeoJSON `location` and the legacy `coordinates` in lockstep.
 */
StationSchema.pre("save", function syncLocation() {
  const lat = this.coordinates?.lat;
  const lng = this.coordinates?.lng;

  const hasLegacy = isRealPosition(lat, lng);
  const hasGeo =
    Array.isArray(this.location?.coordinates) &&
    this.location.coordinates.length === 2 &&
    isRealPosition(this.location.coordinates[1], this.location.coordinates[0]);

  if (hasLegacy) {
    this.location = { type: "Point", coordinates: [lng, lat] };
  } else if (hasGeo) {
    const [gLng, gLat] = this.location.coordinates;
    this.coordinates = { lat: gLat, lng: gLng };
  } else {
    // No usable position: drop both rather than storing a placeholder.
    this.location = undefined;
    this.coordinates = undefined;
  }
});

/** Convenience for callers that just want {lat,lng} regardless of shape. */
StationSchema.methods.latLng = function latLng() {
  if (Array.isArray(this.location?.coordinates) && this.location.coordinates.length === 2) {
    const [lng, lat] = this.location.coordinates;
    if (isRealPosition(lat, lng)) return { lat, lng };
  }
  const lat = this.coordinates?.lat;
  const lng = this.coordinates?.lng;
  if (isRealPosition(lat, lng)) return { lat, lng };
  return null; // no known position -- never a placeholder
};

// ---- opening hours ---------------------------------------------------
// One rule, used for "open now" (isOpenNow), for which slots can be booked
// (services/queue/nozzleScheduler.js) and by booking creation.

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const pad2 = (n) => String(n).padStart(2, "0");

/**
 * Is the station open at wall-clock `hhmm` ("HH:MM", India time) on weekday
 * `dayOfWeek` (0 = Sunday)? Uses operatingSchedule for that day; without one,
 * the legacy openingHours string ("Closed" means closed, anything else open).
 * Works on a document or a lean object.
 */
function scheduleAllows(station, dayOfWeek, hhmm) {
  const day = station?.operatingSchedule?.[DAY_NAMES[dayOfWeek]];
  if (day) {
    if (day.isClosed) return false;
    if (day.is24h) return true;
    return hhmm >= (day.open || "06:00") && hhmm < (day.close || "22:00");
  }
  return station?.openingHours !== "Closed";
}

/** Is the station open at the start of slot `label` on India date `bookingDate`? */
function scheduleAllowsSlot(station, bookingDate, label) {
  const clock = parseClock(String(label || "").split("-")[0].trim());
  const start = clock ? atBusinessTime(bookingDate, clock.hours, clock.minutes) : null;
  if (!start) return false;
  const at = clockParts(start);
  return scheduleAllows(station, at.dayOfWeek, `${pad2(at.hours)}:${pad2(at.minutes)}`);
}

/**
 * Is the station open at `now` (default: this moment), India time?
 *
 * @returns {{ isOpen: boolean, todaySchedule: object|null, nextOpenTime: string|null }}
 */
StationSchema.methods.isOpenNow = function isOpenNow(now = new Date()) {
  if (this.status !== "Active") {
    return { isOpen: false, todaySchedule: null, nextOpenTime: null };
  }

  const at = clockParts(now);
  const hhmm = `${pad2(at.hours)}:${pad2(at.minutes)}`;
  const schedule = this.operatingSchedule;
  const today = schedule?.[DAY_NAMES[at.dayOfWeek]] || null;
  const isOpen = scheduleAllows(this, at.dayOfWeek, hhmm);

  let nextOpenTime = null;
  if (!isOpen && today) {
    if (today.isClosed) {
      for (let i = 1; i <= 7; i++) {
        const name = DAY_NAMES[(at.dayOfWeek + i) % 7];
        if (schedule[name] && !schedule[name].isClosed) {
          nextOpenTime = `${name.charAt(0).toUpperCase()}${name.slice(1)} ${schedule[name].open || "06:00"}`;
          break;
        }
      }
    } else if (!today.is24h && hhmm < (today.open || "06:00")) {
      nextOpenTime = `Today ${today.open || "06:00"}`;
    }
  }
  return { isOpen, todaySchedule: today, nextOpenTime };
};

StationSchema.statics.isRealPosition = isRealPosition;
StationSchema.statics.scheduleAllows = scheduleAllows;
StationSchema.statics.scheduleAllowsSlot = scheduleAllowsSlot;

module.exports = mongoose.model("Station", StationSchema);
