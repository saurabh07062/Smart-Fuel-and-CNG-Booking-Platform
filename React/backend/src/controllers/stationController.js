const Station = require("../models/Station");
const realtime = require("../services/notification/realtime");
// Public endpoints return only these fields -- never owner, upiId or stock (services/station/publicStation.js).
const { publicStation, PUBLIC_STATION_SELECT } = require("../services/station/publicStation");

// Helper to emit station events via Socket.io
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
// CREATE STATION (Admin only)
// ============================================================
exports.createStation = async (req, res) => {
  try {
    const {
      name,
      address,
      fuelTypes,
      prices,
      inventory,
      amenities,
      openingHours,
      coordinates,
      images,
      owner,
    } = req.body;
    // queueLength / waitMinutes / queueStatus are computed from bookings
    // (services/queue/stationQueue.js), never set on creation.

    // Validation
    if (!name || !address) {
      return res
        .status(400)
        .json({ msg: "Station name and address are required" });
    }

    // Build station object
    const stationFields = {
      name,
      address,
      fuelTypes: fuelTypes || ["Petrol", "Diesel", "CNG"],
      // Only what was supplied: an unpriced fuel stays null (it cannot be
      // booked until priced), missing stock is 0, no assumed amenities.
      prices: {
        petrol: prices?.petrol ?? null,
        diesel: prices?.diesel ?? null,
        cng: prices?.cng ?? null,
      },
      inventory: {
        petrol: inventory?.petrol ?? 0,
        diesel: inventory?.diesel ?? 0,
        cng: inventory?.cng ?? 0,
      },
      amenities: amenities || [],
      openingHours: openingHours || "24 Hours",
      status: "Active",
    };

    if (coordinates && coordinates.lat && coordinates.lng) {
      stationFields.coordinates = {
        lat: coordinates.lat,
        lng: coordinates.lng,
      };
    }

    if (images && Array.isArray(images)) stationFields.images = images;
    if (owner) stationFields.owner = owner;

    const station = new Station(stationFields);
    await station.save();

    // The starting stock is the first line of the station's stock history.
    await require("../services/inventory/stockLedger")
      .recordOpeningStock({ station, userId: req.user?.id })
      .catch((err) => console.error("[station] opening stock record failed:", err.message));

    // Real-time: notify customers of new station
    emitStationEvent(req, "station_created", station);

    res.status(201).json(station);
  } catch (err) {
    console.error("Create Station Error:", err);
    if (err.code === 11000) {
      return res
        .status(400)
        .json({ msg: "A station with this name already exists" });
    }
    res.status(500).json({ msg: "Server error while creating station" });
  }
};

// ============================================================
// GET ALL STATIONS (Public)
// ============================================================
exports.getAllStations = async (req, res) => {
  try {
    const { fuelType, sortBy, lat, lng, latitude, longitude } = req.query;
    const userLat = parseFloat(lat || latitude);
    const userLng = parseFloat(lng || longitude);
    const hasUserCoords = Number.isFinite(userLat) && Number.isFinite(userLng);

    let query = { status: "Active" };
    // User text, matched literally (utils/regex.js) -- never a raw RegExp.
    const fuelRegex = fuelType !== "all" ? require("../utils/regex").literalSearchRegex(fuelType) : null;
    if (fuelRegex) query.fuelTypes = { $in: [fuelRegex] };
    
    let sortOptions = {};
    if (sortBy === "rating") sortOptions.rating = -1;
    else if (sortBy === "price") sortOptions["prices.petrol"] = 1;
    
    const stations = await Station.find(query).sort(sortOptions).select(PUBLIC_STATION_SELECT).lean();
    const geo = require("../services/algorithms/geo");
    // Every station's live line from one query (services/queue/stationQueue.js),
    // instead of a count per station and a separate wait formula.
    const { queueSnapshots, fuelQueueSummary } = require("../services/queue/stationQueue");
    const queues = await queueSnapshots(stations.map((s) => s._id));

    const enriched = stations.map((s) => {
      const doc = Station.hydrate(s);
      // A position only if it is a real one; the (0,0) placeholder is none.
      const coords = doc.latLng();

      // Calculate real distance from user's coordinates if available
      let distanceKm = null;
      if (hasUserCoords && coords) {
        distanceKm = geo.haversineKm({ lat: userLat, lng: userLng }, coords);
        distanceKm = distanceKm !== null ? parseFloat(distanceKm.toFixed(2)) : null;
      }

      const q = queues.get(String(s._id));
      const isStationOpen = s.status === "Active" && s.openingHours !== "Closed";

      return {
        ...publicStation(s),
        id: s._id,
        coordinates: coords,
        distance: distanceKm,
        queue: q.queueLength,
        queueLength: q.queueLength,
        waitTime: q.waitMinutes,
        waitMinutes: q.waitMinutes,
        queueStatus: q.queueStatus,
        queueBasis: q.basis,
        // Each fuel's own nozzle line (services/queue/stationQueue.js).
        fuelQueues: fuelQueueSummary(q),
        open: isStationOpen,
        // Open at this moment by its own hours (models/Station.js).
        openNow: doc.isOpenNow().isOpen,
        rating: s.rating ?? null,
      };
    });

    // If coordinates were passed, sort by distance ascending
    if (hasUserCoords) {
      enriched.sort((a, b) => (a.distance ?? 9999) - (b.distance ?? 9999));
    }

    res.json(enriched);
  } catch (err) {
    console.error("getAllStations Error:", err);
    res.status(500).send("Server Error");
  }
};

exports.searchStations = async (req, res) => {
  try {
    // Literal, length-capped match (utils/regex.js): "(" is a character to
    // find, not a broken pattern, and nothing typed can run a slow regex.
    const regex = require("../utils/regex").literalSearchRegex(req.query.q);
    if (!regex) return res.json([]);
    const stations = await Station.find({
      $or: [{ name: regex }, { address: regex }]
    })
      .select(PUBLIC_STATION_SELECT)
      .lean();
    res.json(stations.map(publicStation));
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
};

exports.getNearbyStations = async (req, res) => {
  try {
    const { latitude, longitude, fuelType, radius, limit } = req.query;
    const discovery = require("../services/station/discovery");
    const { normaliseFuel } = require("../config/fuels");

    // Strict parsing: Number("") is 0 and parseFloat("18abc") is 18, and
    // either would silently search from the wrong place.
    const parseCoord = (v) => (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN);
    const lat = parseCoord(latitude);
    const lng = parseCoord(longitude);
    const fuelLower = normaliseFuel(fuelType);

    let search;
    try {
      search = await discovery.findStationsForFuel(
        { lat, lng },
        { fuelType: fuelLower, radiusKm: radius, limit },
      );
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ success: false, msg: err.message });
      throw err;
    }
    const requestedFuelType = fuelLower.toUpperCase();

    // Optional: how much the customer intends to buy, so stock is judged
    // against it. Without it, a station only needs some stock.
    let quantity = null;
    if (req.query.quantity !== undefined && req.query.quantity !== "") {
      const { QUANTITY_MIN, QUANTITY_MAX } = require("../config/booking");
      quantity = Number(req.query.quantity);
      if (!Number.isFinite(quantity) || quantity < QUANTITY_MIN || quantity > QUANTITY_MAX) {
        return res.status(400).json({
          success: false,
          msg: `quantity must be between ${QUANTITY_MIN} and ${QUANTITY_MAX}`,
        });
      }
    }

    // Slots, live wait, bookability, ranking and alternatives:
    // services/station/stationFinder.js.
    const stationFinder = require("../services/station/stationFinder");
    const result = await stationFinder.buildFinderResults({
      stations: search.stations,
      fuel: fuelLower,
      quantity,
    });

    res.json({
      success: true,
      fuelType: requestedFuelType,
      userLocation: { latitude: lat, longitude: lng },
      // The radius the results come from, and whether it had to widen past
      // the first ring to find anything.
      radiusKm: search.radiusKm,
      expandedSearch: search.expanded,
      totalInRadius: search.total,
      quantity,
      serviceMinutes: result.serviceMinutes,
      rankingWeights: result.weights,
      stations: result.stations,
    });
  } catch (err) {
    console.error("Nearby Stations Error:", err);
    res.status(500).json({ success: false, msg: "Server Error" });
  }
};

exports.getNearestStations = async (req, res) => {
  try {
    const { latitude, longitude, k = 3 } = req.query;
    if (!latitude || !longitude) {
      return res.status(400).json({ msg: "Latitude and Longitude are required" });
    }

    const lat = Number(latitude);
    const lng = Number(longitude);
    const discovery = require("../services/station/discovery");

    // Same geo search as the finder, within its widest radius.
    const nearestFor = async (fuelType) => {
      const { stations } = await discovery.findStationsForFuel(
        { lat, lng },
        { fuelType, radiusKm: discovery.MAX_SEARCH_RADIUS_KM, limit: 1 },
      );
      const best = stations[0];
      return best
        ? {
            stationId: String(best._id),
            stationName: best.name,
            address: best.address,
            distanceKm: Math.round(best.distanceKm * 100) / 100,
          }
        : null;
    };

    let cng;
    let petrol;
    try {
      [cng, petrol] = await Promise.all([nearestFor("cng"), nearestFor("petrol")]);
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ msg: err.message });
      throw err;
    }

    res.json({
      userLocation: { latitude: lat, longitude: lng },
      searchRadiusKm: discovery.MAX_SEARCH_RADIUS_KM,
      cng,
      petrol,
    });
  } catch (err) {
    console.error("KNN Nearest Error:", err);
    res.status(500).json({ msg: "Server error calculating nearest stations" });
  }
};

exports.getStationById = async (req, res) => {
  try {
    // Public: the station's public view only (services/station/publicStation.js).
    // A malformed id is a station that does not exist, not a server error.
    if (!require("mongoose").isValidObjectId(req.params.id)) {
      return res.status(404).json({ msg: "Station not found" });
    }
    const station = await Station.findById(req.params.id).select(PUBLIC_STATION_SELECT).lean();
    if (!station) return res.status(404).json({ msg: "Station not found" });
    res.json(publicStation(station));
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
};

/**
 * Fields an admin may set directly. Everything else on a station is either
 * maintained by the system or has its own guarded path:
 *   inventory / inventoryCommitted / tankCapacity  PUT /api/vendor-panel/stations/:id/inventory
 *     (conditional update + stock record; commitments only via bookings)
 *   queueLength / waitMinutes / queueStatus        computed from bookings (services/queue/stationQueue.js)
 *   arrivalRatePerHour / observedAvgQueueLength    the station metrics job
 * `$set: req.body` let any of those be overwritten silently, skipping the
 * stock history, schema setters and the location sync.
 */
const ADMIN_EDITABLE = [
  "name",
  "address",
  "city",
  "state",
  "openingHours",
  "operatingSchedule",
  "images",
  "fuelTypes",
  "amenities",
  "prices",
  "fuelAvailability",
  "pumpCounts",
  "coordinates",
  "status",
  "owner",
  "brand",
  "upiId",
  "upiName",
  "acceptsUpi",
];
const GUARDED_FIELDS = {
  inventory: "PUT /api/vendor-panel/stations/:id/inventory",
  inventoryCommitted: "bookings (it is never set by hand)",
  tankCapacity: "PUT /api/vendor-panel/stations/:id/inventory",
  queueLength: "live bookings (it is computed)",
  waitMinutes: "live bookings (it is computed)",
  queueStatus: "live bookings (it is computed)",
};

exports.updateStation = async (req, res) => {
  try {
    const body = req.body || {};
    const guarded = Object.keys(body).filter((k) => k in GUARDED_FIELDS);
    if (guarded.length) {
      return res.status(400).json({
        msg: `These fields cannot be set here: ${guarded.map((k) => `${k} (use ${GUARDED_FIELDS[k]})`).join("; ")}`,
        fields: guarded,
      });
    }

    const station = await Station.findById(req.params.id);
    if (!station) return res.status(404).json({ msg: "Station not found" });

    const ignored = Object.keys(body).filter((k) => !ADMIN_EDITABLE.includes(k));
    for (const key of ADMIN_EDITABLE) {
      if (body[key] !== undefined) station[key] = body[key];
    }
    // save(), not findByIdAndUpdate: runs validators, setters and the
    // coordinates <-> GeoJSON sync.
    await station.save();
    if (ignored.length) console.warn(`[station] admin update ignored field(s) on ${station._id}: ${ignored.join(", ")}`);

    // Real-time: notify customers of station update
    emitStationEvent(req, "station_updated", station);

    res.json(station);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error while updating station" });
  }
};

// ============================================================
// DELETE STATION (Admin only)
// ============================================================
exports.deleteStation = async (req, res) => {
  try {
    const station = await Station.findById(req.params.id);
    if (!station) return res.status(404).json({ msg: "Station not found" });

    const stationId = station._id.toString();
    await station.deleteOne();

    // Real-time: notify customers of station removal
    emitStationEvent(req, "station_deleted", { id: stationId });

    res.json({ msg: "Station removed successfully" });
  } catch (err) {
    console.error("Delete Station Error:", err);
    res.status(500).json({ msg: "Server error while deleting station" });
  }
};

// ============================================================
// TOGGLE STATION STATUS (Admin only)
// ============================================================
exports.toggleStationStatus = async (req, res) => {
  try {
    const station = await Station.findById(req.params.id);
    if (!station) return res.status(404).json({ msg: "Station not found" });

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
    console.error("Toggle Station Status Error:", err);
    res.status(500).json({ msg: "Server error while toggling station status" });
  }
};

// ============================================================
// GET STATION STATS (Admin only)
// ============================================================
exports.getStationStats = async (req, res) => {
  try {
    const totalStations = await Station.countDocuments();
    const activeStations = await Station.countDocuments({ status: "Active" });
    const inactiveStations = await Station.countDocuments({
      status: "Inactive",
    });

    // Count by fuel type
    const petrolStations = await Station.countDocuments({
      fuelTypes: "Petrol",
    });
    const dieselStations = await Station.countDocuments({
      fuelTypes: "Diesel",
    });
    const cngStations = await Station.countDocuments({ fuelTypes: "CNG" });

    res.json({
      totalStations,
      activeStations,
      inactiveStations,
      petrolStations,
      dieselStations,
      cngStations,
    });
  } catch (err) {
    console.error("Station Stats Error:", err);
    res.status(500).json({ msg: "Server error while fetching station stats" });
  }
};
