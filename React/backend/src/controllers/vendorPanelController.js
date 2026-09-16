const User = require("../models/User");

const { storedPath, removeUploadedFile } = require("../middleware/upload");

/**
 * Files uploaded under the "stationImages" field, as public /uploads paths.
 * Returns [] when the request carried no files, so callers can tell "no
 * images sent" (leave the record alone) from "images sent".
 */
function uploadedStationImages(req) {
  if (!Array.isArray(req.files) || req.files.length === 0) return [];
  return req.files.map((f) => storedPath(f, "stations")).filter(Boolean);
}

/**
 * Multipart turns every field into a string, so `prices` and `inventory`
 * arrive as JSON text rather than objects and `fuelTypes` as either one
 * string or several. Requests that still send JSON are untouched.
 */
function parseMaybeJson(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function asArray(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const parsed = parseMaybeJson(value, null);
    if (Array.isArray(parsed)) return parsed;
    return value.split(",").map((v) => v.trim()).filter(Boolean);
  }
  return undefined;
}
const Station = require("../models/Station");
const Booking = require("../models/Booking");
const PriceHistory = require("../models/PriceHistory");
const Employee = require("../models/Employee");
const { classifyStationInventory, ALERT_TIERS } = require("../services/inventory/inventoryThreshold");
const { getServiceDurationSeconds } = require("../config/fuelDurations");
const { FUEL_KEYS, FUEL_UNITS, normaliseFuel } = require("../config/fuels");
const {
  dateKey,
  startOfBusinessDay,
  endOfBusinessDay,
  startOfBusinessMonth,
} = require("../config/businessTime");
const { completeBooking } = require("../services/booking/bookingCompletion");
const { transitionBooking, currentStatus } = require("../services/booking/bookingTransitions");
const realtime = require("../services/notification/realtime");
const nozzleService = require("../services/queue/nozzleService");
const revenueService = require("../services/payment/revenue");
const { recordStationCollection } = require("../services/payment/paymentRecording");

// Helper to emit station events via Socket.io for real-time customer updates
/**
 * Publish a station change to the people it concerns.
 *
 * This was `io.emit(event, payload)` -- a broadcast to every connected
 * socket, carrying the full station document. That put `upiId` (the account a
 * station's payments settle into) and `owner` into every open browser, and
 * woke every client for a station none of them were looking at.
 *
 * realtime.stationChanged sends a trimmed public view to the customers
 * watching that station, and the full record only to its owner and to admins.
 */
function emitStationEvent(req, event, payload) {
  try {
    realtime.stationChanged(event, payload);
  } catch (e) {
    console.error("Socket emit error:", e);
  }
}

// ============================================================
// OWNERSHIP GUARD
// ============================================================
/**
 * Look up a station by id, but only hand it back if `req.user` is actually
 * allowed to manage it: its owner, or an admin. Every vendor-panel endpoint
 * below that touches a specific station goes through this instead of a bare
 * `Station.findById(req.params.id)` -- without it, any vendor could read or
 * modify ANY other vendor's station just by putting a different id in the
 * URL, since the JWT alone proves who you are, not which station you own.
 *
 * Returns null both when the station doesn't exist and when it exists but
 * isn't owned by this caller -- callers should respond 404 either way so a
 * vendor probing ids can't tell "not found" apart from "not yours".
 */
async function findOwnedStation(id, req) {
  if (!id) return null;
  const station = await Station.findById(id);
  if (!station) return null;
  if (req.user?.role === "admin") return station;
  if (String(station.owner) !== String(req.user?.id)) return null;
  return station;
}

/** Same idea, scoped to the vendor's own stations for list queries. Admins see everything. */
function ownedStationFilter(req) {
  return req.user?.role === "admin" ? {} : { owner: req.user?.id };
}

// Canonical display label per fuel key -- PriceHistory.fuelType's schema enum
// only accepts these exact strings, so any caller sending a different casing
// ("petrol", "PETROL") must be normalised to this before it hits the model,
// or the save throws a ValidationError instead of recording the change.
const FUEL_LABEL = { petrol: "Petrol", diesel: "Diesel", cng: "CNG" };

// ============================================================
// VENDOR PANEL - DASHBOARD
// ============================================================
exports.getDashboard = async (req, res) => {
  try {
    const stations = await Station.find(ownedStationFilter(req));
    const stationIds = stations.map((s) => s._id);

    // Bookings scheduled for today (India date) at these stations.
    const todaysBookings = await Booking.find({
      station: { $in: stationIds },
      bookingDate: require("../config/businessTime").dateKey(),
    });

    // Money from the one revenue definition (services/payment/revenue.js):
    // completed bookings whose payment was actually received.
    const money = await revenueService.revenueSummary({ stationIds });
    const todaysRevenue = money.today.revenue;
    const monthlySales = money.month.revenue;

    // Total bookings
    const totalBookings = await Booking.countDocuments({
      station: { $in: stationIds },
    });

    // Queue status (sum of active/upcoming bookings today)
    const queueCount = todaysBookings.filter(
      (b) => b.status === "upcoming",
    ).length;

    // Fuel stock totals
    const fuelStock = stations.reduce(
      (acc, s) => {
        acc.petrol += s.inventory?.petrol || 0;
        acc.diesel += s.inventory?.diesel || 0;
        acc.cng += s.inventory?.cng || 0;
        return acc;
      },
      { petrol: 0, diesel: 0, cng: 0 },
    );

    // Tank capacity totals, from what vendors actually recorded. null when no
    // station has recorded a capacity for that fuel -- the UI then shows the
    // stock figure without a fill bar instead of a percentage of a guess.
    const fuelCapacity = Object.fromEntries(
      FUEL_KEYS.map((fuel) => {
        const set = stations
          .map((s) => s.tankCapacity?.[fuel])
          .filter((c) => Number.isFinite(c) && c > 0);
        return [fuel, set.length ? set.reduce((a, b) => a + b, 0) : null];
      }),
    );

    // Top selling fuel this month, by quantity of revenue bookings.
    // null when nothing sold this month, rather than a default "Petrol".
    const topFuel =
      Object.entries(money.monthByFuel).sort((a, b) => b[1].quantity - a[1].quantity)[0]?.[0] || null;

    // Customers today (unique users)
    const customersToday = new Set(
      todaysBookings.map((b) => b.user?.toString()),
    ).size;

    // Active pumps
    const activePumps = stations.filter((s) => s.status === "Active").length;

    res.json({
      todaysRevenue,
      todaysTransactions: money.today.transactions,
      awaitingCollection: money.awaitingCollection,
      revenueBasis: money.basis,
      todaysBookings: todaysBookings.length,
      queueStatus: queueCount,
      fuelStock,
      fuelCapacity,
      monthlySales,
      topSellingFuel: topFuel,
      activePumps,
      customersToday,
      totalStations: stations.length,
      totalBookings,
    });
  } catch (err) {
    console.error("Vendor Dashboard Error:", err);
    res.status(500).json({ msg: "Server error fetching dashboard" });
  }
};

// ============================================================
// MY PETROL PUMPS - CRUD
// ============================================================
exports.getMyStations = async (req, res) => {
  try {
    const stations = await Station.find(ownedStationFilter(req)).sort({
      createdAt: -1,
    });
    // Stock tiers are computed here, once, so the panel never re-derives
    // them against its own idea of a tank size.
    res.json(
      stations.map((s) => ({ ...s.toJSON(), inventoryStatus: classifyStationInventory(s) })),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error fetching stations" });
  }
};

exports.createStation = async (req, res) => {
  try {
    let {
      name,
      address,
      fuelTypes,
      prices,
      inventory,
      amenities,
      openingHours,
      coordinates,
      images,
      tankCapacity,
    } = req.body;

    // Coerce the multipart shapes back to what the schema expects. A JSON
    // request passes through these unchanged.
    prices = parseMaybeJson(prices, prices);
    inventory = parseMaybeJson(inventory, inventory);
    coordinates = parseMaybeJson(coordinates, coordinates);
    fuelTypes = asArray(fuelTypes) || fuelTypes;
    amenities = asArray(amenities) || amenities;
    images = asArray(images) || images;

    const uploaded = uploadedStationImages(req);
    if (uploaded.length) images = uploaded;

    if (!name || !address) {
      uploaded.forEach(removeUploadedFile);
      return res
        .status(400)
        .json({ msg: "Station name and address are required" });
    }

    tankCapacity = parseMaybeJson(tankCapacity, tankCapacity);

    // Only what the vendor supplied. A missing price stays null (that fuel
    // cannot be booked until priced), missing stock is 0 and a missing
    // position is left unset -- never a sample price, a full tank or (0, 0).
    const perFuel = (source, fallback) =>
      Object.fromEntries(
        FUEL_KEYS.map((fuel) => {
          const n = Number(source?.[fuel]);
          return [fuel, source?.[fuel] !== undefined && source?.[fuel] !== "" && Number.isFinite(n) && n >= 0 ? n : fallback];
        }),
      );
    const lat = Number(coordinates?.lat);
    const lng = Number(coordinates?.lng);

    const station = new Station({
      name,
      address,
      owner: req.user.id,
      fuelTypes: (fuelTypes || ["Petrol", "Diesel", "CNG"]).map((f) => FUEL_LABEL[normaliseFuel(f)] || f),
      prices: perFuel(prices, null),
      inventory: perFuel(inventory, 0),
      tankCapacity: perFuel(tankCapacity, null),
      amenities: amenities || [],
      openingHours: openingHours || "24 Hours",
      images: images || [],
      status: "Active",
      ...(Station.isRealPosition(lat, lng) ? { coordinates: { lat, lng } } : {}),
    });

    await station.save();

    // The starting stock is the first line of the station's stock history.
    await require("../services/inventory/stockLedger")
      .recordOpeningStock({ station, userId: req.user.id })
      .catch((err) => console.error("[vendorPanel] opening stock record failed:", err.message));

    // Real-time: notify customers of new station
    emitStationEvent(req, "station_created", station);

    res.status(201).json(station);
  } catch (err) {
    console.error("Create Station Error:", err);
    res.status(500).json({ msg: "Server error creating station" });
  }
};

exports.updateStation = async (req, res) => {
  try {
    const uploaded = uploadedStationImages(req);

    const station = await findOwnedStation(req.params.id, req);
    if (!station) {
      // Ownership is checked here, so a vendor aiming at someone else's
      // station has already had multer write their files. Remove them.
      uploaded.forEach(removeUploadedFile);
      return res.status(404).json({ msg: "Station not found" });
    }

    // Allowlist rather than copying req.body wholesale. Unrestricted
    // assignment let a vendor set `owner` — and now that the station carries
    // `upiId`, that would mean reassigning a station and redirecting its
    // payments to another account.
    const EDITABLE = [
      "name",
      "address",
      "openingHours",
      "images",
      "fuelTypes",
      "amenities",
      "prices",
      // Not "inventory": a raw overwrite here would skip the stock record,
      // could undo a sale landing at the same moment (read-modify-save) and
      // could drop stock below what bookings hold. Stock changes go through
      // PUT /stations/:id/inventory, one conditional update with a movement.
      "nozzles",
      "avgServiceMinutes",
      "coordinates",
      "upiId",
      "upiName",
      "acceptsUpi",
    ];

    const updates = req.body || {};
    const rejected = Object.keys(updates).filter((k) => !EDITABLE.includes(k));

    // Multipart sends these as strings; JSON callers are unaffected.
    if (updates.prices !== undefined) updates.prices = parseMaybeJson(updates.prices, updates.prices);
    if (updates.coordinates !== undefined) updates.coordinates = parseMaybeJson(updates.coordinates, updates.coordinates);
    if (updates.fuelTypes !== undefined) updates.fuelTypes = asArray(updates.fuelTypes) ?? updates.fuelTypes;
    if (updates.amenities !== undefined) updates.amenities = asArray(updates.amenities) ?? updates.amenities;
    if (updates.images !== undefined) updates.images = asArray(updates.images) ?? updates.images;

    // New uploads replace the set. Held until after the save so a failure
    // leaves the station pointing at pictures that still exist.
    const previousImages = Array.isArray(station.images) ? station.images.slice() : [];
    if (uploaded.length) updates.images = uploaded;

    EDITABLE.forEach((key) => {
      if (updates[key] !== undefined) station[key] = updates[key];
    });

    if (rejected.length) {
      console.warn(
        `[vendorPanel] ignored non-editable field(s) on station ${station._id}: ${rejected.join(", ")}`,
      );
    }

    await station.save();

    // Superseded files, removed only now that the record no longer refers to
    // them. Anything still referenced (a caller who sent some images and kept
    // others) is left alone.
    if (uploaded.length) {
      previousImages
        .filter((img) => !station.images.includes(img))
        .forEach(removeUploadedFile);
    }

    // Real-time: notify customers of station update
    emitStationEvent(req, "station_updated", station);

    res.json(station);
  } catch (err) {
    uploadedStationImages(req).forEach(removeUploadedFile);
    console.error(err);
    res.status(500).json({ msg: "Server error updating station" });
  }
};

exports.deleteStation = async (req, res) => {
  try {
    const owned = await findOwnedStation(req.params.id, req);
    if (!owned)
      return res.status(404).json({ msg: "Station not found" });

    const station = await Station.findByIdAndDelete(req.params.id);
    const stationId = req.params.id;

    // The row is gone; its pictures would otherwise stay on disk forever.
    if (owned && Array.isArray(owned.images)) owned.images.forEach(removeUploadedFile);

    // Also delete related data
    await Booking.deleteMany({ station: req.params.id });
    await PriceHistory.deleteMany({ station: req.params.id });
    await Employee.deleteMany({ station: req.params.id });

    // Real-time: notify customers of station removal
    emitStationEvent(req, "station_deleted", { id: stationId });

    res.json({ msg: "Station removed successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error deleting station" });
  }
};

exports.toggleStationStatus = async (req, res) => {
  try {
    const station = await findOwnedStation(req.params.id, req);
    if (!station)
      return res.status(404).json({ msg: "Station not found" });

    station.status = station.status === "Active" ? "Inactive" : "Active";
    await station.save();

    // Real-time: notify customers of station status change
    emitStationEvent(req, "station_updated", station);

    res.json({
      msg: `Station is now ${station.status}`,
      status: station.status,
      station,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error toggling station status" });
  }
};

// ============================================================
// FUEL PRICE MANAGEMENT
// ============================================================
exports.updateFuelPrice = async (req, res) => {
  try {
    const { fuelType, newPrice, note } = req.body;
    if (!fuelType || newPrice == null) {
      return res
        .status(400)
        .json({ msg: "Fuel type and new price are required" });
    }

    const fuelKey = String(fuelType).toLowerCase();
    if (!["petrol", "diesel", "cng"].includes(fuelKey)) {
      return res
        .status(400)
        .json({ msg: "Fuel type must be Petrol, Diesel, or CNG" });
    }

    const priceNum = Number(newPrice);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      return res
        .status(400)
        .json({ msg: "New price must be a positive number" });
    }

    const station = await findOwnedStation(req.params.id, req);
    if (!station)
      return res.status(404).json({ msg: "Station not found" });

    const oldPrice = station.prices[fuelKey] || 0;
    const fuelLabel = FUEL_LABEL[fuelKey];

    // Record price history
    const priceHistory = new PriceHistory({
      station: station._id,
      fuelType: fuelLabel,
      oldPrice,
      newPrice: priceNum,
      changedBy: req.user.id,
      note,
    });
    await priceHistory.save();

    // Update station price
    station.prices[fuelKey] = priceNum;
    // Stamped so a client can show "updated 2 minutes ago" and discard an
    // event older than the data it already holds. `updatedAt` moves on every
    // save and cannot distinguish a price change from an inventory tweak.
    station.pricesUpdatedAt = new Date();
    await station.save();

    // Only now that the write has resolved. A dedicated event carries just
    // what changed, so a customer page can patch one number instead of
    // re-rendering the whole station from a generic station:updated.
    realtime.stationChanged(realtime.EVENTS.FUEL_PRICE_UPDATED, station, {
      fuelType: fuelKey,
      oldPrice,
      newPrice: priceNum,
      pricesUpdatedAt: station.pricesUpdatedAt,
    });
    emitStationEvent(req, realtime.EVENTS.STATION_UPDATED, station);

    res.json({
      msg: `${fuelLabel} price updated to ₹${priceNum}`,
      station,
      priceHistory,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error updating fuel price" });
  }
};

exports.getPriceHistory = async (req, res) => {
  try {
    const station = await findOwnedStation(req.params.id, req);
    if (!station)
      return res.status(404).json({ msg: "Station not found" });

    const history = await PriceHistory.find({ station: req.params.id })
      .sort({ effectiveDate: -1 })
      .limit(50);

    res.json(history);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error fetching price history" });
  }
};

// ============================================================
// QUEUE MANAGEMENT
// ============================================================
exports.getQueueStatus = async (req, res) => {
  try {
    const station = await findOwnedStation(req.params.id, req);
    if (!station)
      return res.status(404).json({ msg: "Station not found" });

    // The station's app-nozzle lines today (one per fuel), with each booking's
    // position and ETA from the one queue model (services/queue/stationQueue.js).
    const stationQueue = require("../services/queue/stationQueue");
    const snapshot = (await stationQueue.queueSnapshots([station._id])).get(String(station._id));
    const todays = await Booking.find({
      station: station._id,
      status: { $in: ["upcoming", "serving"] },
      bookingDate: dateKey(),
    })
      .populate("user", "name phone")
      .sort({ bookingStartTime: 1 });
    const etaById = new Map(snapshot.etas.map((e) => [e.bookingId, e]));

    res.json({
      queueLength: snapshot.queueLength,
      waitMinutes: snapshot.waitMinutes,
      queueStatus: snapshot.queueStatus,
      basis: snapshot.basis,
      fuelQueues: stationQueue.fuelQueueSummary(snapshot),
      walkIns: await require("../services/queue/walkIns").listActive(station._id),
      liveQueue: todays.map((b) => ({
        ...b.toObject(),
        position: etaById.get(String(b._id))?.position ?? null,
        etaMinutes: etaById.get(String(b._id))?.etaMinutes ?? null,
      })),
      currentCount: todays.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error fetching queue status" });
  }
};

/**
 * PUT /stations/:id/queue and PATCH /stations/:id/queue/close -- RETIRED.
 *
 * They let a vendor type a queue status by hand, which the next booking event
 * silently overwrote, and wrote a `queueTime` field the schema does not have.
 * The queue is now computed from real bookings (services/queue/stationQueue.js).
 * To stop taking bookings, set the station Inactive or its opening hours.
 */
exports.updateQueueStatus = (req, res) => {
  res.status(410).json({
    reason: "ENDPOINT_RETIRED",
    msg: "The queue is computed from bookings and cannot be set by hand. To pause bookings, set the station inactive or change its opening hours.",
  });
};

exports.closeQueue = exports.updateQueueStatus;

// ============================================================
// WALK-IN VEHICLES (services/queue/walkIns.js)
// ============================================================
// A vehicle that arrived at a fuel's app nozzle without a booking. Recording
// it puts it in that fuel's line, so every customer's pre-booking estimate
// and every booked customer's ETA include it; the change is pushed live.

function walkInError(res, err, fallback) {
  const { WalkInError } = require("../services/queue/walkIns");
  if (err instanceof WalkInError) return res.status(err.status).json({ msg: err.message });
  if (err.code === "LOCK_TIMEOUT" || err.code === "LOCK_EXPIRED") {
    return res.status(409).json({ msg: "The nozzle is being updated for another vehicle. Try again in a moment." });
  }
  if (err.code === "LOCK_UNAVAILABLE") {
    return res.status(503).json({ msg: "Walk-ins are temporarily unavailable. Please try again shortly." });
  }
  console.error(err);
  return res.status(500).json({ msg: fallback });
}

/** GET /stations/:id/walk-ins -- today's walk-ins still waiting or at the nozzle. */
exports.getWalkIns = async (req, res) => {
  try {
    const station = await findOwnedStation(req.params.id, req);
    if (!station) return res.status(404).json({ msg: "Station not found" });
    res.json(await require("../services/queue/walkIns").listActive(station._id));
  } catch (err) {
    walkInError(res, err, "Server error fetching walk-ins");
  }
};

/** POST /stations/:id/walk-ins { fuelType, quantity, vehicleNumber? } */
exports.addWalkIn = async (req, res) => {
  try {
    const station = await findOwnedStation(req.params.id, req);
    if (!station) return res.status(404).json({ msg: "Station not found" });
    const { fuelType, quantity, vehicleNumber } = req.body || {};
    const walkIn = await require("../services/queue/walkIns").addWalkIn({
      stationId: station._id,
      fuelType,
      quantity,
      vehicleNumber,
      createdBy: req.user.id,
    });
    res.status(201).json({
      msg: walkIn.status === "serving" ? "Walk-in added. Fueling has started." : "Walk-in added to the queue.",
      walkIn,
    });
  } catch (err) {
    walkInError(res, err, "Server error adding walk-in");
  }
};

/** PATCH /stations/:id/walk-ins/:walkInId { action: "complete" | "cancel" } */
exports.updateWalkIn = async (req, res) => {
  try {
    const station = await findOwnedStation(req.params.id, req);
    if (!station) return res.status(404).json({ msg: "Station not found" });
    const walkIn = await require("../services/queue/walkIns").updateWalkIn({
      stationId: station._id,
      walkInId: req.params.walkInId,
      action: req.body?.action,
    });
    res.json({ msg: walkIn.status === "completed" ? "Walk-in completed." : "Walk-in removed from the queue.", walkIn });
  } catch (err) {
    walkInError(res, err, "Server error updating walk-in");
  }
};

// ============================================================
// BOOKING MANAGEMENT
// ============================================================
exports.getStationBookings = async (req, res) => {
  try {
    const station = await findOwnedStation(req.params.id, req);
    if (!station)
      return res.status(404).json({ msg: "Station not found" });

    const { status } = req.query;
    let query = { station: req.params.id };
    if (status) query.status = status;

    const bookings = await Booking.find(query)
      .populate("user", "name phone email")
      .sort({ createdAt: -1 });

    res.json(bookings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error fetching bookings" });
  }
};

exports.updateBookingStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const station = await findOwnedStation(req.params.stationId, req);
    if (!station)
      return res.status(404).json({ msg: "Station not found" });

    let booking = await Booking.findOne({
      _id: req.params.bookingId,
      station: req.params.stationId,
    });
    if (!booking)
      return res.status(404).json({ msg: "Booking not found" });

    // Must match Booking.status's real enum (models/Booking.js) — this used
    // to list "accepted"/"rejected"/"fueling", none of which the schema
    // accepts, so every one of those transitions failed with a Mongoose
    // validation error instead of doing what the vendor asked.
    const validStatuses = ["serving", "completed", "cancelled", "no_show"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        msg: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      });
    }

    // Terminal states don't go backwards from here -- once a booking is
    // completed/cancelled/no_show, the only correction path is an
    // admin-specific one (there isn't one today), never a vendor re-opening
    // it back into "serving".
    const TERMINAL = ["completed", "cancelled", "no_show", "expired"];
    if (TERMINAL.includes(booking.status)) {
      return res.status(400).json({
        msg: `Booking is already ${booking.status} and cannot be changed to ${status}`,
      });
    }

    // A repeated click on the status the booking already has is a no-op.
    if (booking.status === status) {
      return res.json({ msg: `Booking already ${status}`, booking });
    }

    let waitingForNozzle = false;
    if (status === "completed") {
      // Shared completion path: status change and stock deduction, once.
      // Completing is not collecting: a pay-at-the-pump booking stays owed until
      // its payment is recorded -- collectPayment here, or "Collect payment".
      booking = await completeBooking({ bookingId: booking._id });
      if (!booking) {
        return res.status(409).json({ msg: "Booking was already completed or changed. Refresh and try again." });
      }
      if (req.body?.collectPayment === true && booking.payMethod === "station" && booking.paymentStatus === "due_at_station") {
        const collected = await recordStationCollection({
          bookingId: booking._id,
          stationId: req.params.stationId,
          collectedBy: req.user.id,
        });
        if (collected.booking) booking = collected.booking;
      }
    } else if (status === "serving") {
      // Starting service by hand (no scan) is a check-in at the pump: the same
      // nozzle-locked path as the PIN scan (services/queue/nozzleService.js). A busy
      // nozzle leaves the car waiting; it starts by itself when released.
      let result;
      try {
        result = await nozzleService.checkIn({ bookingId: booking._id, filter: { station: req.params.stationId } });
      } catch (lockErr) {
        if (lockErr.code === "LOCK_TIMEOUT" || lockErr.code === "LOCK_EXPIRED") {
          return res.status(409).json({ msg: "The nozzle is being updated for another car. Try again in a moment." });
        }
        if (lockErr.code === "LOCK_UNAVAILABLE") {
          return res.status(503).json({ msg: "Starting service is temporarily unavailable. Please try again shortly." });
        }
        throw lockErr;
      }
      if (!result.booking) {
        const now = await currentStatus(booking._id);
        return res.status(409).json({
          msg: `Booking is now ${now} and cannot be changed to serving. Refresh and try again.`,
        });
      }
      booking = result.booking;
      waitingForNozzle = result.outcome !== "started";
    } else {
      const set = {};
      if (status === "cancelled") {
        // Recorded so the customer risk engine never counts a station's own
        // cancellation against the customer.
        set.cancelledAt = new Date();
        set.cancelledBy = req.user.role === "admin" ? "admin" : "vendor";
      }
      // Conditional on the status at the moment of the write, so a sweep or
      // another attendant acting first is reported, never overwritten.
      const updated = await transitionBooking({
        bookingId: booking._id,
        to: status,
        filter: { station: req.params.stationId },
        set,
      });
      if (!updated) {
        const now = await currentStatus(booking._id);
        return res.status(409).json({
          msg: `Booking is now ${now} and cannot be changed to ${status}. Refresh and try again.`,
        });
      }
      booking = updated;
    }

    // A cancelled or missed reservation frees its nozzle window for the first
    // customer waiting for it.
    if (status === "cancelled" || status === "no_show") {
      await require("../services/booking/booking").promoteFromWaitlist(station._id);
    }
    // A car completed, cancelled or marked a no-show by hand releases the
    // nozzle: the next car waiting at the pump starts (services/queue/serviceTimer.js).
    if (["completed", "cancelled", "no_show"].includes(status)) {
      await require("../services/queue/serviceTimer").releaseNozzle(station._id, { refresh: false });
    }

    // A status change moves the line: refresh the queue and everyone's ETA.
    try {
      await require("../services/queue/stationQueue").refreshStationQueue(station._id);
    } catch (e) {
      console.error("Failed to refresh station queue after status change:", e.message);
    }
    emitStationEvent(req, "station_updated", station);
    // Real-time: the customer's own booking/confirmation view listens for this
    // (frontend/js/app.js's socket.on("booking_updated", ...)) to refetch and
    // show the new status immediately, without a manual page refresh.
    //
    // Addressed, not broadcast. A booking payload carries the customer's
    // name, their vehicle plate and what they paid; io.emit put all of that
    // into every connected browser. It now reaches the customer it belongs
    // to, the vendor who owns the station, and admins.
    try {
      realtime.bookingChanged(
        status === "cancelled"
          ? realtime.EVENTS.BOOKING_CANCELLED
          : realtime.EVENTS.BOOKING_UPDATED,
        booking,
        { stationOwner: req.user.id },
      );
    } catch (e) {
      console.error("Socket emit error:", e);
    }

    res.json({
      msg: waitingForNozzle
        ? "Checked in. The nozzle is busy -- fueling starts automatically when it is released."
        : `Booking ${status}`,
      booking,
      waitingForNozzle,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error updating booking status" });
  }
};

/**
 * PATCH /api/vendor-panel/stations/:stationId/bookings/:bookingId/collect
 *
 * The attendant received the money for a pay-at-the-pump booking that is being
 * fuelled or has finished. One conditional write
 * (services/payment/paymentRecording.js recordStationCollection): a repeated
 * click, a second attendant or a replayed request records it once and answers
 * alreadyPaid, so revenue can never be counted twice.
 */
exports.collectBookingPayment = async (req, res) => {
  try {
    const station = await findOwnedStation(req.params.stationId, req);
    if (!station) return res.status(404).json({ msg: "Station not found" });
    if (!require("mongoose").isValidObjectId(req.params.bookingId)) {
      return res.status(404).json({ msg: "Booking not found" });
    }

    const result = await recordStationCollection({
      bookingId: req.params.bookingId,
      stationId: station._id,
      collectedBy: req.user.id,
    });

    if (result.outcome === "not_found") return res.status(404).json({ msg: "Booking not found" });
    if (result.outcome === "already_paid") {
      return res.json({ msg: "Payment was already recorded for this booking.", booking: result.booking, alreadyPaid: true });
    }
    if (result.outcome === "not_pay_at_station") {
      return res.status(409).json({ msg: "This booking is not paid at the pump." });
    }
    if (result.outcome === "not_collectable") {
      return res.status(409).json({
        msg: `This booking is ${result.booking.status}. Payment is collected once the car is being fuelled or has finished.`,
      });
    }

    try {
      realtime.bookingChanged(realtime.EVENTS.BOOKING_UPDATED, result.booking, { stationOwner: station.owner });
    } catch (e) {
      console.error("Socket emit error:", e);
    }
    res.json({ msg: `Payment of ₹${result.booking.amount} recorded.`, booking: result.booking, alreadyPaid: false });
  } catch (err) {
    console.error("[vendorPanel] collect payment failed:", err);
    res.status(500).json({ msg: "Server error recording the payment" });
  }
};

// ============================================================
// INVENTORY MANAGEMENT
// ============================================================
exports.updateInventory = async (req, res) => {
  try {
    // quantity: stock to add (action "add", default -- a delivery) or the
    // counted stock (action "set" -- a stock count). capacity: the tank's
    // real size. Either or both. note: e.g. supplier or invoice number.
    const { fuelType, quantity, capacity, action = "add" } = req.body;
    const note = typeof req.body.note === "string" ? req.body.note.trim().slice(0, 200) || null : null;

    const fuelKey = normaliseFuel(fuelType);
    if (!fuelKey) {
      return res
        .status(400)
        .json({ msg: "Fuel type must be Petrol, Diesel, or CNG" });
    }
    if (!["add", "set"].includes(action)) {
      return res.status(400).json({ msg: 'action must be "add" or "set"' });
    }

    const given = (v) => v !== undefined && v !== null && v !== "";
    const hasQty = given(quantity);
    const hasCap = given(capacity);
    if (!hasQty && !hasCap) {
      return res.status(400).json({ msg: "Provide a quantity, a tank capacity, or both" });
    }
    const qtyNum = hasQty ? Number(quantity) : null;
    if (hasQty && (!Number.isFinite(qtyNum) || qtyNum < 0)) {
      return res
        .status(400)
        .json({ msg: "Quantity must be a non-negative number" });
    }
    const capNum = hasCap ? Number(capacity) : null;
    if (hasCap && (!Number.isFinite(capNum) || capNum <= 0)) {
      return res.status(400).json({ msg: "Tank capacity must be a positive number" });
    }

    // orderedOn: the India date a delivery was ordered, so the real lead time
    // is recorded (services/inventory/leadTime.js). Deliveries only.
    let orderedOn = null;
    if (given(req.body.orderedOn)) {
      const { daysBetweenKeys, LEAD_TIME } = require("../services/inventory/leadTime");
      const value = String(req.body.orderedOn).trim();
      if (action !== "add" || !(qtyNum > 0)) {
        return res.status(400).json({ msg: "orderedOn can only be recorded with a delivery" });
      }
      const gap = daysBetweenKeys(value, dateKey());
      if (gap === null) return res.status(400).json({ msg: "orderedOn must be a YYYY-MM-DD date" });
      if (gap < 0) return res.status(400).json({ msg: "orderedOn cannot be after today" });
      if (gap > LEAD_TIME.maxRecordableDays) {
        return res.status(400).json({ msg: `orderedOn must be within ${LEAD_TIME.maxRecordableDays} days of the delivery` });
      }
      orderedOn = value;
    }

    const owned = await findOwnedStation(req.params.id, req);
    if (!owned)
      return res.status(404).json({ msg: "Station not found" });

    // One conditional server-side update, not read-modify-save: a booking
    // completing at the same moment deducts from this same field, and a
    // save() of a stale value would silently undo that deduction.
    const stockPath = `inventory.${fuelKey}`;
    const capPath = `tankCapacity.${fuelKey}`;
    const currentStock = { $ifNull: [`$${stockPath}`, 0] };
    const nextStock = !hasQty ? currentStock : action === "add" ? { $add: [currentStock, qtyNum] } : qtyNum;
    const nextCap = hasCap ? capNum : { $ifNull: [`$${capPath}`, null] };

    const before = await Station.collection.findOneAndUpdate(
      {
        _id: owned._id,
        // Stock can never exceed a recorded tank size.
        $expr: { $or: [{ $eq: [nextCap, null] }, { $lte: [nextStock, nextCap] }] },
      },
      [
        {
          $set: {
            ...(hasQty ? { [stockPath]: nextStock } : {}),
            ...(hasCap ? { [capPath]: capNum } : {}),
            updatedAt: "$$NOW",
          },
        },
      ],
      { returnDocument: "before" },
    );
    if (!before) {
      const cap = hasCap ? capNum : owned.tankCapacity?.[fuelKey];
      return res.status(409).json({
        msg: `Stock would exceed the ${fuelKey.toUpperCase()} tank capacity of ${cap} ${FUEL_UNITS[fuelKey]}`,
        reason: "EXCEEDS_CAPACITY",
      });
    }

    // The delivery / stock count / tank-size record, from the exact previous
    // figure; alerts the vendor if a count lowered stock into a low tier.
    const recorded = await require("../services/inventory/stockLedger").recordVendorChange({
      before,
      fuel: fuelKey,
      action,
      quantity: hasQty ? qtyNum : null,
      capacity: hasCap ? capNum : null,
      userId: req.user.id,
      note,
      orderedOn,
    });
    const station = await Station.findById(owned._id);

    // Real-time: notify customers of inventory change
    emitStationEvent(req, "station_updated", station);

    realtime.stationChanged(realtime.EVENTS.INVENTORY_UPDATED, station, {
      inventory: station.inventory,
    });

    const status = classifyStationInventory(station);
    res.json({
      msg: `${FUEL_LABEL[fuelKey]} inventory updated`,
      inventory: station.inventory,
      tankCapacity: station.tankCapacity,
      stockBefore: recorded.stockBefore,
      stockAfter: recorded.stockAfter,
      deliveryLeadTimeDays: recorded.leadTimeDays ?? null,
      status,
      // A count below what bookings already hold is recorded as counted, but
      // no new bookings are taken until stock covers them again.
      warning:
        status[fuelKey] && status[fuelKey].committed > status[fuelKey].current
          ? `Live bookings hold ${status[fuelKey].committed} ${FUEL_UNITS[fuelKey]}, more than the ${status[fuelKey].current} ${FUEL_UNITS[fuelKey]} now in stock.`
          : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error updating inventory" });
  }
};

exports.getInventoryAlerts = async (req, res) => {
  try {
    const stations = await Station.find(ownedStationFilter(req));
    const alerts = [];

    stations.forEach((station) => {
      const classified = classifyStationInventory(station);
      Object.entries(classified).forEach(([fuel, info]) => {
        // Only surface fuels that actually need attention, not every fuel
        // the station carries -- "normal" stock isn't an alert.
        // "capacity_unset" is not an alert either: nothing is known to be low.
        if (!ALERT_TIERS.includes(info.tier)) return;
        alerts.push({
          station: station.name,
          stationId: station._id,
          fuelType: FUEL_LABEL[fuel] || fuel,
          unit: info.unit,
          current: info.current,
          committed: info.committed,
          available: info.available,
          capacity: info.capacity,
          percent: info.percent,
          tier: info.tier,
          label: info.label,
        });
      });
    });

    res.json(alerts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error fetching inventory alerts" });
  }
};

/**
 * GET /api/vendor-panel/stations/:id/inventory/movements?fuel=petrol&limit=20
 *
 * The station's stock history, newest first: deliveries and stock counts
 * (with who recorded them and their note), sales from completed bookings,
 * and tank-size changes -- each with the stock figure right after it.
 */
exports.getInventoryMovements = async (req, res) => {
  try {
    const station = await findOwnedStation(req.params.id, req);
    if (!station) return res.status(404).json({ msg: "Station not found" });

    const filter = { station: station._id };
    if (req.query.fuel !== undefined) {
      const fuel = normaliseFuel(req.query.fuel);
      if (!fuel) return res.status(400).json({ msg: "fuel must be Petrol, Diesel or CNG" });
      filter.fuel = fuel;
    }
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const InventoryMovement = require("../models/InventoryMovement");
    const rows = await InventoryMovement.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("recordedBy", "name")
      .populate("booking", "orderId")
      .lean();

    res.json(
      rows.map((m) => ({
        id: String(m._id),
        fuel: m.fuel,
        type: m.type,
        quantity: m.quantity,
        stockAfter: m.stockAfter,
        capacityAfter: m.capacityAfter,
        unit: m.unit,
        note: m.note,
        recordedBy: m.recordedBy?.name ?? null,
        orderId: m.booking?.orderId ?? null,
        orderedOn: m.orderedOn ?? null,
        leadTimeDays: m.leadTimeDays ?? null,
        createdAt: m.createdAt,
      })),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error fetching inventory history" });
  }
};

// ============================================================
// REVENUE
// ============================================================
/**
 * GET /api/vendor-panel/revenue -- this vendor's stations, from the one revenue
 * definition (services/payment/revenue.js): completed bookings whose payment was
 * received, dated when earned. Today and "this month" are India dates; the week
 * is the last 7 days including today. No estimate (such as an assumed profit
 * margin) is reported: only what the booking records show.
 */
exports.getRevenue = async (req, res) => {
  try {
    const stations = await Station.find({ owner: req.user.id }).select("_id").lean();
    const money = await revenueService.revenueSummary({ stationIds: stations.map((s) => s._id) });

    res.json({
      todaysRevenue: money.today.revenue,
      weeklyRevenue: money.week.revenue,
      monthlyRevenue: money.month.revenue,
      allTimeRevenue: money.allTime.revenue,
      transactions: {
        today: money.today.transactions,
        week: money.week.transactions,
        month: money.month.transactions,
        allTime: money.allTime.transactions,
      },
      monthBreakdown: { fuelValue: money.month.fuelValue, fees: money.month.fees, quantity: money.month.quantity },
      fuelSales: money.monthByFuel,
      awaitingCollection: money.awaitingCollection,
      totalBookings: money.month.transactions,
      basis: money.basis,
      asOf: money.asOf,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error fetching revenue" });
  }
};

// ============================================================
// DEMAND FORECAST & REORDER PLANNING
// ============================================================
/**
 * GET /api/vendor-panel/stations/:id/forecast?fuel=petrol&leadTimeDays=2
 *
 * Next month's demand for one fuel from this station's real sales
 * (services/inventory/demandHistory.js), gated on how much history exists
 * (services/algorithms/forecast.js forecastFromHistory): no month is invented, the
 * running month is not fitted, and with too little history the answer is
 * "not enough history" rather than a number. A reorder plan is given only
 * when there is a forecast, against stock not already promised to bookings.
 */
exports.getForecast = async (req, res) => {
  try {
    const station = await findOwnedStation(req.params.id, req);
    if (!station) return res.status(404).json({ msg: "Station not found" });

    const fuel = normaliseFuel(req.query.fuel ?? "petrol");
    if (!fuel) return res.status(400).json({ msg: "fuel must be petrol, diesel, or cng" });

    // Lead time: the vendor's figure if given; otherwise measured from
    // recorded order-to-delivery times; otherwise an assumed default, labelled
    // as such (services/inventory/leadTime.js).
    const leadRaw = req.query.leadTimeDays;
    const leadGiven = leadRaw !== undefined && leadRaw !== "";
    const enteredLead = leadGiven ? Number(leadRaw) : null;
    if (leadGiven && (!Number.isFinite(enteredLead) || enteredLead < 0 || enteredLead > 30)) {
      return res.status(400).json({ msg: "leadTimeDays must be between 0 and 30" });
    }

    const { monthlyDemand, dailyDemand, daysInMonth } = require("../services/inventory/demandHistory");
    const { forecastFromHistory, reorderPlan, SERVICE_LEVEL_Z } = require("../services/algorithms/forecast");
    const { availableStock } = require("../services/inventory/stockLedger");

    const slRaw = req.query.serviceLevel;
    const serviceLevel = slRaw === undefined || slRaw === "" ? 95 : Number(slRaw);
    if (!SERVICE_LEVEL_Z[serviceLevel]) {
      return res.status(400).json({ msg: `serviceLevel must be one of ${Object.keys(SERVICE_LEVEL_Z).join(", ")}` });
    }

    const { measuredLeadTime, chooseLeadTime } = require("../services/inventory/leadTime");
    const [history, daily, measuredLead] = await Promise.all([
      monthlyDemand(station._id, fuel, { maxMonths: 24 }),
      dailyDemand(station._id, fuel, { maxDays: 90 }),
      measuredLeadTime(station._id, fuel),
    ]);
    const projection = forecastFromHistory(history);
    const available = availableStock(station, fuel);
    const lead = chooseLeadTime({ enteredDays: enteredLead, measured: measuredLead });

    // Reorder point from measured daily variation (services/algorithms/forecast.js
    // reorderPlan), held back until there are enough complete days.
    const reorder = reorderPlan({
      daily,
      leadTimeDays: lead.usedDays,
      leadTimeSdDays: lead.sdDays,
      leadTimeBasis: lead.basis,
      serviceLevel,
      available,
      monthForecast: projection,
      periodDays: daysInMonth(projection.forMonth || history.current.month),
    });

    res.json({
      fuel,
      unit: FUEL_UNITS[fuel],
      history: {
        months: history.months,
        current: history.current,
        firstSaleAt: history.firstSaleAt,
        lastSaleAt: history.lastSaleAt,
        daysObserved: history.daysObserved,
        saleDays: history.saleDays,
        totalQuantity: history.totalValue,
        totalBookings: history.totalBookings,
        nonCustomerBookings: history.nonCustomerBookings,
        // Demand is customer sales; vendor/admin bookings are counted out.
        basis: history.basis,
        excludedBookings: history.excludedBookings,
      },
      stock: { current: Number(station.inventory?.[fuel]) || 0, available },
      forecast: projection,
      dailyHistory: {
        completeDays: daily.completeDays,
        windowDays: daily.windowDays,
        firstSaleDate: daily.firstSaleDate,
        basis: daily.basis,
        excludedBookings: daily.excludedBookings,
      },
      reorder,
      reorderReason: reorder.ready ? null : reorder.reason,
      leadTime: { ...lead, measured: measuredLead },
    });
  } catch (err) {
    console.error("[vendor-panel] forecast failed:", err);
    res.status(500).json({ msg: "Server error while forecasting demand" });
  }
};

// ============================================================
// EMPLOYEES
// ============================================================
exports.getEmployees = async (req, res) => {
  try {
    const employees = await Employee.find({ vendor: req.user.id })
      .populate("station", "name")
      .sort({ createdAt: -1 });
    res.json(employees);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error fetching employees" });
  }
};

exports.addEmployee = async (req, res) => {
  try {
    const { name, email, phone, role, shift, salary, stationId } = req.body;
    if (!name || !phone) {
      return res
        .status(400)
        .json({ msg: "Name and phone are required" });
    }

    const employee = new Employee({
      vendor: req.user.id,
      station: stationId,
      name,
      email,
      phone,
      role: role || "Attendant",
      shift: shift || "Full-Time",
      salary: salary || 0,
    });
    await employee.save();
    res.status(201).json(employee);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error adding employee" });
  }
};

exports.updateEmployee = async (req, res) => {
  try {
    const employee = await Employee.findOne({
      _id: req.params.id,
      vendor: req.user.id,
    });
    if (!employee)
      return res.status(404).json({ msg: "Employee not found" });

    const updates = req.body;
    Object.keys(updates).forEach((key) => {
      employee[key] = updates[key];
    });
    await employee.save();
    res.json(employee);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error updating employee" });
  }
};

exports.deleteEmployee = async (req, res) => {
  try {
    const employee = await Employee.findOneAndDelete({
      _id: req.params.id,
      vendor: req.user.id,
    });
    if (!employee)
      return res.status(404).json({ msg: "Employee not found" });
    res.json({ msg: "Employee removed successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error deleting employee" });
  }
};

// ============================================================
// REVIEWS
// ============================================================
exports.getReviews = async (req, res) => {
  try {
    const stations = await Station.find(ownedStationFilter(req)).select(
      "name reviews rating",
    );
    const allReviews = [];
    stations.forEach((station) => {
      station.reviews.forEach((review) => {
        allReviews.push({
          ...review.toObject(),
          stationName: station.name,
          stationId: station._id,
        });
      });
    });
    allReviews.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(allReviews);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error fetching reviews" });
  }
};

// ============================================================
// CUSTOMERS
// ============================================================
exports.getCustomers = async (req, res) => {
  try {
    const stations = await Station.find(ownedStationFilter(req));
    const stationIds = stations.map((s) => s._id);

    const bookings = await Booking.find({
      station: { $in: stationIds },
    })
      .populate("user", "name email phone")
      .sort({ createdAt: -1 });

    // Group by user
    const customerMap = {};
    bookings.forEach((b) => {
      if (!b.user) return;
      const uid = b.user._id.toString();
      if (!customerMap[uid]) {
        customerMap[uid] = {
          user: b.user,
          totalBookings: 0,
          totalSpent: 0,
          lastVisit: b.createdAt,
        };
      }
      customerMap[uid].totalBookings++;
      // What they actually paid: the one revenue rule (services/payment/revenue.js).
      if (revenueService.isRevenueBooking(b)) {
        customerMap[uid].totalSpent += b.amount;
      }
    });

    const customers = Object.values(customerMap).sort(
      (a, b) => new Date(b.lastVisit) - new Date(a.lastVisit),
    );

    res.json(customers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error fetching customers" });
  }
};

// ============================================================
// REPORTS
// ============================================================
exports.getReports = async (req, res) => {
  try {
    const vendorId = req.user.id;
    const stations = await Station.find({ owner: vendorId });
    const stationIds = stations.map((s) => s._id);

    const bookings = await Booking.find({
      station: { $in: stationIds },
    }).sort({ createdAt: -1 });

    // Monthly revenue from completed sales, by India month, from the first
    // sale on (services/inventory/demandHistory.js) -- the same history the forecast
    // uses. The last 6 months; the running one is marked incomplete.
    const { salesHistory } = require("../services/inventory/demandHistory");
    const revenueHistory = stationIds.length
      ? await salesHistory({ stationIds, metric: "revenue", maxMonths: 6 })
      : { months: [] };
    const monthlyData = revenueHistory.months.map((m) => ({
      month: m.month,
      bookings: m.bookings,
      revenue: m.value,
      complete: m.complete,
    }));

    // Station performance: revenue from the one definition (services/payment/revenue.js).
    const earned = await revenueService.revenueByStation(stationIds);
    const stationPerformance = stations.map((station) => {
      const stationBookings = bookings.filter((b) => b.station.toString() === station._id.toString());
      const money = earned.get(String(station._id)) || { revenue: 0, transactions: 0 };
      return {
        stationId: station._id,
        stationName: station.name,
        totalBookings: stationBookings.length,
        completedTransactions: money.transactions,
        revenue: money.revenue,
        rating: station.rating,
      };
    });

    res.json({
      monthlyData,
      stationPerformance,
      totalRevenue: stationPerformance.reduce((s, st) => s + st.revenue, 0),
      totalBookings: bookings.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error fetching reports" });
  }
};

// ============================================================
// PROFILE & SETTINGS
// ============================================================
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error fetching profile" });
  }
};

exports.updateProfile = async (req, res) => {
  const uploaded = storedPath(req.file, "vendors");
  try {
    const { name, phone, businessName, gstNumber, vendorAddress, vendorDescription } =
      req.body;
    const user = await User.findById(req.user.id);
    if (!user) {
      removeUploadedFile(uploaded);
      return res.status(404).json({ msg: "User not found" });
    }

    if (name) user.name = name;
    if (phone) user.phone = phone;
    if (businessName) user.businessName = businessName;
    if (gstNumber) user.gstNumber = gstNumber;
    if (vendorAddress) user.vendorAddress = vendorAddress;
    if (vendorDescription) user.vendorDescription = vendorDescription;

    // The vendor's photo shares the `profileImage` field with every other
    // account type -- a vendor is a User, and a second field would mean every
    // avatar in the app needed to know which kind of account it was showing.
    const previousImage = user.profileImage;
    if (uploaded) user.profileImage = uploaded;

    await user.save();

    if (uploaded && previousImage && previousImage !== uploaded) {
      removeUploadedFile(previousImage);
    }

    res.json({ msg: "Profile updated successfully", user });
  } catch (err) {
    removeUploadedFile(uploaded);
    console.error(err);
    res.status(500).json({ msg: "Server error updating profile" });
  }
};