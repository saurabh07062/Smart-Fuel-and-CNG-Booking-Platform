const User = require("../models/User");
const Station = require("../models/Station");
const Booking = require("../models/Booking");
const bcrypt = require("bcryptjs");
const emailService = require("../services/notification/emailService");
const { completenessScore, priorityScore, performanceScore } = require("../services/vendor/vendorScoring");
const { generateVendorCode } = require("../services/vendor/vendorIdentity");
const secretCode = require("../services/vendor/vendorSecretCode");
const { validateEmail } = require("../services/notification/emailValidation");
const { storedPath, removeUploadedFile } = require("../middleware/upload");
const realtime = require("../services/notification/realtime");
const notifications = require("../services/notification/notifications");

/**
 * Publish every station of a vendor after a bulk status change (suspend,
 * reactivate). Station.updateMany sends no event of its own.
 */
async function announceStationsOf(vendorId) {
  try {
    const stations = await Station.find({ owner: vendorId });
    for (const station of stations) realtime.stationChanged(realtime.EVENTS.STATION_UPDATED, station);
  } catch (err) {
    console.error("[vendor] could not publish station status changes:", err.message);
  }
}

// ============================================================
// VENDOR DASHBOARD STATS
// Returns all metrics for the Admin Vendor Management dashboard
// ============================================================
exports.getDashboardStats = async (req, res) => {
  try {
    const [
      totalVendors,
      activeVendors,
      pendingVendors,
      suspendedVendors,
      rejectedVendors,
      totalStations,
      totalBookings,
      revenueAgg,
      monthlyAgg,
      topVendorsAgg,
      recentVendors,
    ] = await Promise.all([
      // Total vendors
      User.countDocuments({ role: "vendor" }),
      // Active vendors
      User.countDocuments({ role: "vendor", vendorStatus: "active" }),
      // Pending approvals -- 'pending' and 'under_review' both still need a decision
      User.countDocuments({ role: "vendor", vendorStatus: { $in: ["pending", "under_review"] } }),
      // Suspended vendors
      User.countDocuments({ role: "vendor", vendorStatus: "suspended" }),
      // Rejected vendors
      User.countDocuments({ role: "vendor", vendorStatus: "rejected" }),
      // Total stations
      Station.countDocuments(),
      // Total bookings
      Booking.countDocuments(),
      // Total vendor revenue: the one revenue rule (services/payment/revenue.js).
      Booking.aggregate([
        { $match: { ...require("../services/payment/revenue").REVENUE_MATCH } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      // Monthly earnings this India year, by the India month the money was earned.
      Booking.aggregate([
        { $match: { ...require("../services/payment/revenue").REVENUE_MATCH } },
        { $addFields: { revenueAt: require("../services/payment/revenue").REVENUE_AT } },
        {
          $match: {
            revenueAt: {
              $gte: require("../config/businessTime").atBusinessTime(
                `${require("../config/businessTime").dateKey().slice(0, 4)}-01-01`,
                0,
                0,
              ),
            },
          },
        },
        {
          $group: {
            _id: { $month: { date: "$revenueAt", timezone: require("../config/businessTime").MONGO_TIMEZONE } },
            revenue: { $sum: "$amount" },
            bookings: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      // Candidate pool for "top performing vendors" -- widened beyond the
      // final 5 so re-ranking by the composite performance score (below)
      // actually has room to reorder rather than just re-sorting a list
      // that was already cut down to revenue order.
      Booking.aggregate([
        { $match: { ...require("../services/payment/revenue").REVENUE_MATCH } },
        {
          $group: {
            _id: "$station",
            revenue: { $sum: "$amount" },
            bookings: { $sum: 1 },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 15 },
        {
          $lookup: {
            from: "stations",
            localField: "_id",
            foreignField: "_id",
            as: "station",
          },
        },
        { $unwind: { path: "$station", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "users",
            localField: "station.owner",
            foreignField: "_id",
            as: "owner",
          },
        },
        { $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } },
      ]),
      // Recent registrations
      User.find({ role: "vendor" })
        .sort({ createdAt: -1 })
        .limit(5)
        .select("-password"),
    ]);

    const totalRevenue = revenueAgg.length > 0 ? revenueAgg[0].total : 0;

    // Format monthly earnings
    const monthNames = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    const monthlyEarnings = monthlyAgg.map((m) => ({
      month: monthNames[m._id - 1],
      revenue: m.revenue,
      bookings: m.bookings,
    }));

    // Outcome counts (completed + cancelled + no_show) per candidate
    // station, so performanceScore() has a real completion rate to work
    // with instead of just revenue.
    const candidateStationIds = topVendorsAgg.map((v) => v._id).filter(Boolean);
    const outcomeAgg = candidateStationIds.length
      ? await Booking.aggregate([
          {
            $match: {
              station: { $in: candidateStationIds },
              status: { $in: ["completed", "cancelled", "no_show"] },
            },
          },
          {
            $group: {
              _id: { station: "$station", status: "$status" },
              count: { $sum: 1 },
            },
          },
        ])
      : [];
    const outcomesByStation = {};
    outcomeAgg.forEach((o) => {
      const sid = String(o._id.station);
      if (!outcomesByStation[sid]) outcomesByStation[sid] = { total: 0, completed: 0 };
      outcomesByStation[sid].total += o.count;
      if (o._id.status === "completed") outcomesByStation[sid].completed += o.count;
    });

    const maxRevenue = Math.max(1, ...topVendorsAgg.map((v) => v.revenue));

    // Format + rank top vendors by the composite performance score, not
    // raw revenue alone -- see services/vendor/vendorScoring.js for why.
    const topVendors = topVendorsAgg
      .map((v) => {
        const outcomes = outcomesByStation[String(v._id)] || { total: 0, completed: 0 };
        const perf = performanceScore({
          revenue: v.revenue,
          completedBookings: outcomes.completed,
          totalBookings: outcomes.total,
          maxRevenue,
        });
        return {
          vendorId: v.owner ? v.owner._id : null,
          vendorName: v.owner ? v.owner.name : "Unknown",
          businessName: v.owner ? v.owner.businessName : null,
          stationName: v.station ? v.station.name : "Unknown Station",
          stationId: v.station ? v.station._id : null,
          revenue: v.revenue,
          bookings: v.bookings,
          performanceScore: perf.score,
          completionRate: perf.completionRate,
        };
      })
      .sort((a, b) => b.performanceScore - a.performanceScore)
      .slice(0, 5);

    res.json({
      totalVendors,
      activeVendors,
      pendingApprovals: pendingVendors,
      suspendedVendors,
      rejectedVendors,
      totalVendorRevenue: totalRevenue,
      totalStations,
      totalBookings,
      monthlyEarnings,
      topPerformingVendors: topVendors,
      recentRegistrations: recentVendors,
    });
  } catch (err) {
    console.error("[Vendor Dashboard] Error:", err.message);
    res.status(500).json({ msg: "Server error. Please try again." });
  }
};

// ============================================================
// GET ALL VENDORS
// Supports filtering by status and search
// ============================================================
exports.getAllVendors = async (req, res) => {
  try {
    const { status, search } = req.query;
    let query = { role: "vendor" };

    if (status && status !== "all") {
      query.vendorStatus = status;
    }

    // Literal, length-capped match (utils/regex.js).
    const regex = require("../utils/regex").literalSearchRegex(search);
    if (regex) {
      query.$or = [
        { name: regex },
        { email: regex },
        { businessName: regex },
        { gstNumber: regex },
      ];
    }

    const vendors = await User.find(query)
      .select("-password")
      .sort({ createdAt: -1 });

    // Attach station count and revenue per vendor
    const vendorIds = vendors.map((v) => v._id);
    const stations = await Station.find({ owner: { $in: vendorIds } });
    const stationIds = stations.map((s) => s._id);

    // Map vendor -> stations
    const vendorStations = {};
    stations.forEach((s) => {
      const key = s.owner ? s.owner.toString() : null;
      if (key) {
        if (!vendorStations[key]) vendorStations[key] = [];
        vendorStations[key].push(s);
      }
    });

    // Revenue per station
    const revenueByStation = await Booking.aggregate([
      {
        $match: {
          station: { $in: stationIds },
          ...require("../services/payment/revenue").REVENUE_MATCH,
        },
      },
      { $group: { _id: "$station", revenue: { $sum: "$amount" } } },
    ]);
    const revenueMap = {};
    revenueByStation.forEach((r) => {
      revenueMap[r._id.toString()] = r.revenue;
    });

    // Build enriched vendor list
    const enrichedVendors = vendors.map((v) => {
      const vStations = vendorStations[v._id.toString()] || [];
      const vStationIds = vStations.map((s) => s._id.toString());
      const vRevenue = vStationIds.reduce(
        (sum, sid) => sum + (revenueMap[sid] || 0),
        0,
      );
      const priority = priorityScore(v, vStations);
      return {
        ...v.toObject(),
        stationCount: vStations.length,
        stations: vStations,
        totalRevenue: vRevenue,
        completenessScore: priority.completeness,
        priorityScore: priority.score,
        daysWaiting: priority.daysWaiting,
      };
    });

    // Pending applications are shown to the admin in priority order --
    // most-ready-and-longest-waiting first -- everything else stays in the
    // recency order the query already sorted by.
    if (status === "pending") {
      enrichedVendors.sort((a, b) => b.priorityScore - a.priorityScore);
    }

    res.json(enrichedVendors);
  } catch (err) {
    console.error("[Get Vendors] Error:", err.message);
    res.status(500).json({ msg: "Server error. Please try again." });
  }
};

// ============================================================
// GET VENDOR BY ID
// ============================================================
exports.getVendorById = async (req, res) => {
  try {
    const vendor = await User.findOne({
      _id: req.params.id,
      role: "vendor",
    }).select("-password");

    if (!vendor) {
      return res.status(404).json({ msg: "Vendor not found" });
    }

    const stations = await Station.find({ owner: vendor._id });
    const stationIds = stations.map((s) => s._id);

    const bookings = await Booking.find({ station: { $in: stationIds } })
      .populate("user", "name email")
      .sort({ createdAt: -1 })
      .limit(20);

    const revenueAgg = await Booking.aggregate([
      {
        $match: {
          station: { $in: stationIds },
          ...require("../services/payment/revenue").REVENUE_MATCH,
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    const totalRevenue = revenueAgg.length > 0 ? revenueAgg[0].total : 0;
    const priority = priorityScore(vendor, stations);

    res.json({
      vendor,
      stations,
      bookings,
      totalRevenue,
      totalStations: stations.length,
      totalBookings: bookings.length,
      completenessScore: priority.completeness,
      priorityScore: priority.score,
      daysWaiting: priority.daysWaiting,
    });
  } catch (err) {
    console.error("[Get Vendor] Error:", err.message);
    res.status(500).json({ msg: "Server error. Please try again." });
  }
};

// ============================================================
// APPROVE VENDOR
// ============================================================
exports.approveVendor = async (req, res) => {
  try {
    const vendor = await User.findOne({
      _id: req.params.id,
      role: "vendor",
    });

    if (!vendor) {
      return res.status(404).json({ msg: "Vendor not found" });
    }

    if (vendor.vendorStatus === "active") {
      return res.status(400).json({ msg: "Vendor is already active" });
    }

    vendor.vendorStatus = "active";
    vendor.approvedAt = new Date();
    vendor.suspendedAt = undefined;
    vendor.rejectedAt = undefined;
    vendor.rejectionReason = undefined;

    // Approval issues the key; it is not itself access. The vendor enters this
    // code (POST /api/vendor-access/verify) before middleware/vendor.js lets
    // them into the panel, and can use the same code again on later visits
    // until an admin reissues it.
    //
    // `code` is the only plaintext copy that will ever exist. It goes into
    // the approval email and nowhere else -- not the response below, not the
    // database (only a bcrypt hash is stored), not the log.
    const { code, expiresAt } = await secretCode.issueSecretCode(vendor);

    // A vendor approved before they ever had a code still needs a reference
    // to quote, so backfill it here rather than leaving it blank forever.
    if (!vendor.vendorCode) {
      vendor.vendorCode = await generateVendorCode(User);
    }

    await vendor.save();

    // Awaited, unlike the other status emails: if the mail cannot be sent the
    // vendor has no way to get the code, because by design nobody else has a
    // copy. Better to tell the admin now than to leave them believing a
    // vendor was let in.
    let emailed = false;
    try {
      emailed = await emailService.sendVendorSecretCodeEmail(vendor, code, expiresAt);
    } catch (mailErr) {
      console.error("[Approve Vendor] secret code email failed:", mailErr.message);
    }

    // The vendor object is echoed back for the admin UI. Strip the code
    // fields: `secretCodeHash` is select:false so it is already absent, but
    // being explicit here means a future change to that flag cannot silently
    // start leaking a verifier into an admin response.
    const safeVendor = vendor.toObject();
    delete safeVendor.secretCodeHash;
    delete safeVendor.password;

    // Real-time, after the save and the email attempt have both resolved.
    //
    // The vendor's own tracking page listens for this and flips from
    // "waiting for approval" to "check your email for a code" with no
    // refresh. `secretCodeEmailed` is included so the page can tell them to
    // ask for a reissue when the mail bounced -- but the code itself is
    // never in this payload, on any channel.
    realtime.toUser(vendor._id, realtime.EVENTS.VENDOR_APPROVED, {
      vendorId: vendor._id,
      vendorCode: vendor.vendorCode,
      vendorStatus: vendor.vendorStatus,
      activated: false,
      secretCodeEmailed: emailed,
      secretCodeExpiresAt: expiresAt,
      approvedAt: vendor.approvedAt,
    });
    realtime.toAdmins(realtime.EVENTS.VENDOR_STATUS_CHANGED, {
      vendorId: vendor._id,
      name: vendor.name,
      businessName: vendor.businessName,
      vendorStatus: vendor.vendorStatus,
    });

    // Durable, so they still learn about it if the tab was closed.
    await notifications.notify({
      user: vendor._id,
      type: "vendor_approved",
      title: "Your vendor application was approved",
      body: emailed
        ? "Your secret access code has been emailed to you. Use it on the Vendor Secret Code page to open your dashboard."
        : "Your account is approved, but the code email could not be sent. Ask an administrator to reissue it.",
      link: "vendor-secret-code",
      dedupeKey: `vendor:${vendor._id}:approved:${vendor.approvedAt.getTime()}`,
    });

    res.json({
      msg: emailed
        ? "Vendor approved. The secret code has been emailed to them."
        : "Vendor approved, but the secret code email could not be sent. Reissue it once mail is working.",
      vendor: safeVendor,
      secretCodeEmailed: emailed,
      secretCodeExpiresAt: expiresAt,
    });
  } catch (err) {
    console.error("[Approve Vendor] Error:", err.message);
    res.status(500).json({ msg: "Server error. Please try again." });
  }
};

// ============================================================
// REISSUE SECRET CODE
// ============================================================
/**
 * Issue a fresh secret code to an already-approved vendor and email it.
 *
 * This exists because the code is deliberately invisible to everyone except
 * the vendor's inbox. That is the right security property, but it means a
 * bounced email, a typo in the address, an expired code or five wrong guesses
 * would otherwise lock a legitimate vendor out permanently with no recovery
 * path. Reissuing is the recovery path.
 *
 * Issuing a new code revokes the old one (the hash is overwritten) and clears
 * `activated`, so this doubles as "revoke this vendor's access and make them
 * re-verify".
 */
exports.reissueSecretCode = async (req, res) => {
  try {
    const vendor = await User.findOne({ _id: req.params.id, role: "vendor" });
    if (!vendor) return res.status(404).json({ msg: "Vendor not found" });

    if (vendor.vendorStatus !== "active") {
      return res.status(400).json({
        msg: `Cannot issue a secret code to a vendor whose application is ${vendor.vendorStatus}. Approve them first.`,
      });
    }

    const { code, expiresAt } = await secretCode.issueSecretCode(vendor);
    await vendor.save();

    let emailed = false;
    try {
      emailed = await emailService.sendVendorSecretCodeEmail(vendor, code, expiresAt);
    } catch (mailErr) {
      console.error("[Reissue Secret Code] email failed:", mailErr.message);
    }

    // A reissued code deactivates the vendor until they enter it.
    realtime.vendorChanged(realtime.EVENTS.VENDOR_STATUS_CHANGED, vendor);

    res.json({
      msg: emailed
        ? `A new secret code has been emailed to ${vendor.email}. Any previous code no longer works.`
        : "A new code was generated but the email could not be sent. Check the mail configuration and try again.",
      secretCodeEmailed: emailed,
      secretCodeExpiresAt: expiresAt,
    });
  } catch (err) {
    console.error("[Reissue Secret Code] Error:", err.message);
    res.status(500).json({ msg: "Server error. Please try again." });
  }
};

// ============================================================
// REJECT VENDOR
// ============================================================
exports.rejectVendor = async (req, res) => {
  try {
    const { reason } = req.body;
    const vendor = await User.findOne({
      _id: req.params.id,
      role: "vendor",
    });

    if (!vendor) {
      return res.status(404).json({ msg: "Vendor not found" });
    }

    vendor.vendorStatus = "rejected";
    vendor.rejectedAt = new Date();
    vendor.rejectionReason = reason || "Application rejected by admin";
    await vendor.save();

    emailService.sendVendorStatusEmail(vendor, "rejected", vendor.rejectionReason).catch(() => {});
    realtime.vendorChanged(realtime.EVENTS.VENDOR_STATUS_CHANGED, vendor, { rejectionReason: vendor.rejectionReason });

    res.json({ msg: "Vendor rejected successfully", vendor });
  } catch (err) {
    console.error("[Reject Vendor] Error:", err.message);
    res.status(500).json({ msg: "Server error. Please try again." });
  }
};

// ============================================================
// SUSPEND VENDOR
// ============================================================
exports.suspendVendor = async (req, res) => {
  try {
    const { reason } = req.body;
    const vendor = await User.findOne({
      _id: req.params.id,
      role: "vendor",
    });

    if (!vendor) {
      return res.status(404).json({ msg: "Vendor not found" });
    }

    vendor.vendorStatus = "suspended";
    vendor.suspendedAt = new Date();
    vendor.rejectionReason = reason || "Suspended by admin";
    await vendor.save();

    // Optionally suspend all stations owned by this vendor
    await Station.updateMany(
      { owner: vendor._id },
      { status: "Inactive" },
    );
    // The bulk update sends no events by itself: customers would keep seeing
    // these stations open until they refreshed.
    await announceStationsOf(vendor._id);

    emailService.sendVendorStatusEmail(vendor, "suspended", vendor.rejectionReason).catch(() => {});
    realtime.vendorChanged(realtime.EVENTS.VENDOR_STATUS_CHANGED, vendor);

    res.json({ msg: "Vendor suspended successfully", vendor });
  } catch (err) {
    console.error("[Suspend Vendor] Error:", err.message);
    res.status(500).json({ msg: "Server error. Please try again." });
  }
};

// ============================================================
// MARK VENDOR UNDER REVIEW
// A purely informational transition from 'pending' -- lets an admin flag
// "I'm actively looking at this one" without granting any access. Only
// valid from 'pending' since a vendor that's already been decided on
// (active/rejected/suspended) has nothing left to "review".
// ============================================================
exports.markUnderReview = async (req, res) => {
  try {
    const vendor = await User.findOne({
      _id: req.params.id,
      role: "vendor",
    });

    if (!vendor) {
      return res.status(404).json({ msg: "Vendor not found" });
    }

    if (vendor.vendorStatus !== "pending") {
      return res.status(400).json({
        msg: `Only a pending application can be marked under review (this one is ${vendor.vendorStatus})`,
      });
    }

    vendor.vendorStatus = "under_review";
    await vendor.save();

    emailService.sendVendorStatusEmail(vendor, "under_review").catch(() => {});
    realtime.vendorChanged(realtime.EVENTS.VENDOR_STATUS_CHANGED, vendor);

    res.json({ msg: "Vendor marked as under review", vendor });
  } catch (err) {
    console.error("[Mark Under Review] Error:", err.message);
    res.status(500).json({ msg: "Server error. Please try again." });
  }
};

// ============================================================
// REACTIVATE VENDOR (from suspended)
// ============================================================
exports.reactivateVendor = async (req, res) => {
  try {
    const vendor = await User.findOne({
      _id: req.params.id,
      role: "vendor",
    });

    if (!vendor) {
      return res.status(404).json({ msg: "Vendor not found" });
    }

    vendor.vendorStatus = "active";
    vendor.suspendedAt = undefined;
    vendor.rejectionReason = undefined;
    await vendor.save();

    // Reactivate stations
    await Station.updateMany(
      { owner: vendor._id },
      { status: "Active" },
    );
    await announceStationsOf(vendor._id);

    emailService.sendVendorStatusEmail(vendor, "reactivated").catch(() => {});
    realtime.vendorChanged(realtime.EVENTS.VENDOR_STATUS_CHANGED, vendor);

    res.json({ msg: "Vendor reactivated successfully", vendor });
  } catch (err) {
    console.error("[Reactivate Vendor] Error:", err.message);
    res.status(500).json({ msg: "Server error. Please try again." });
  }
};

// ============================================================
// UPDATE VENDOR
// ============================================================
exports.updateVendor = async (req, res) => {
  try {
    const allowedFields = [
      "name",
      "email",
      "businessName",
      "gstNumber",
      "phone",
      "vendorAddress",
      "vendorDescription",
      "vendorStatus",
    ];

    const updates = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    // An admin correcting a typo'd address must not be able to introduce a
    // new one. findOneAndUpdate skips schema validators unless asked, so this
    // path bypassed the email check entirely.
    if (updates.email !== undefined) {
      const emailCheck = validateEmail(updates.email);
      if (!emailCheck.ok) {
        return res.status(400).json({
          msg: emailCheck.msg,
          field: "email",
          suggestion: emailCheck.suggestion || null,
        });
      }
      updates.email = emailCheck.email;
    }

    const vendor = await User.findOneAndUpdate(
      { _id: req.params.id, role: "vendor" },
      { $set: updates },
      { new: true, runValidators: true },
    ).select("-password");

    if (!vendor) {
      return res.status(404).json({ msg: "Vendor not found" });
    }

    realtime.vendorChanged(realtime.EVENTS.VENDOR_STATUS_CHANGED, vendor);
    res.json({ msg: "Vendor updated successfully", vendor });
  } catch (err) {
    console.error("[Update Vendor] Error:", err.message);
    res.status(500).json({ msg: "Server error. Please try again." });
  }
};

// ============================================================
// DELETE VENDOR
// ============================================================
exports.deleteVendor = async (req, res) => {
  try {
    const vendor = await User.findOne({
      _id: req.params.id,
      role: "vendor",
    });

    if (!vendor) {
      return res.status(404).json({ msg: "Vendor not found" });
    }

    // Their stations, with everything that belongs to each (bookings, stock and
    // price history, staff, walk-ins, notifications, photos).
    const owned = await Station.find({ owner: vendor._id }).select("_id").lean();
    await require("../services/station/stationRemoval").removeStations(owned.map((s) => s._id));
    await User.findByIdAndDelete(vendor._id);
    realtime.vendorChanged(realtime.EVENTS.VENDOR_STATUS_CHANGED, vendor, { vendorStatus: "deleted" });

    res.json({ msg: "Vendor deleted successfully" });
  } catch (err) {
    console.error("[Delete Vendor] Error:", err.message);
    res.status(500).json({ msg: "Server error. Please try again." });
  }
};

// ============================================================
// VENDOR REGISTRATION
// Allows a user to register as a vendor (fuel station owner)
// ============================================================
exports.registerVendor = async (req, res) => {
  try {
    // If multer parsed multipart/form-data, fields live on req.body and files on req.files.
    // If a client sends JSON, express.json() already populated req.body. Defensive guard
    // in server.js ensures req.body is at least an object. Still, validate required fields
    // and coerce from FormData when necessary.
    const body = req.body || {};

    const name = body.name || (body.ownerName || body.owner || "");
    // Stored trimmed and lowercase (utils/email.js); the vendor-access route already matches it without case.
    const email = require("../utils/email").normaliseEmail(body.email);
    const password = body.password || "";
    const businessName = body.businessName || body.vendorBusinessName || "";
    const gstNumber = body.gstNumber || "";
    const phone = body.phone || body.mobile || "";
    const vendorAddress = body.vendorAddress || body.address || "";
    const vendorDescription = body.vendorDescription || "";

    // The pin dropped on the registration map. It was sent but never read, so
    // every applicant's location was lost. Multipart sends strings; only a real
    // position is kept -- never (0, 0) or junk.
    const rawLat = body.latitude ?? body.lat;
    const rawLng = body.longitude ?? body.lng;
    const pinLat = Number(rawLat);
    const pinLng = Number(rawLng);
    const registrationLocation =
      rawLat !== undefined && rawLat !== "" && rawLng !== undefined && rawLng !== "" &&
      Station.isRealPosition(pinLat, pinLng)
        ? { lat: pinLat, lng: pinLng }
        : undefined;

    if (!name || !email || !password || !businessName) {
      return res.status(400).json({ msg: "Please provide name, email, password and business name" });
    }

    // "Provided Products": which fuels the station sells. It used to be sent
    // and ignored; the vendor panel now shows only these fuels.
    const fuelChoice = require("../services/vendor/vendorFuels").parseVendorFuels(
      body.products ?? body.vendorFuelTypes ?? body.fuelTypes,
    );
    if (fuelChoice.error) {
      return res.status(400).json({ msg: fuelChoice.error, field: "products" });
    }

    // The approval email -- and therefore the vendor's only copy of their
    // secret code -- goes to this address. A typo here is not cosmetic: it
    // silently strands the vendor with no way to reach their own account.
    const emailCheck = validateEmail(email);
    if (!emailCheck.ok) {
      return res.status(400).json({
        msg: emailCheck.msg,
        field: "email",
        reason: emailCheck.reason,
        suggestion: emailCheck.suggestion || null,
      });
    }

    let user = await require("../utils/email").findUserByEmail(email);
    if (user) {
      return res
        .status(400)
        .json({ msg: `User already exists with email: ${email}` });
    }

    user = new User({
      name,
      email,
      password,
      role: "vendor",
      vendorStatus: "pending",
      businessName,
      gstNumber,
      phone,
      vendorAddress,
      vendorDescription,
      vendorFuelTypes: fuelChoice.fuels,
      ...(registrationLocation ? { registrationLocation } : {}),
      isVerified: true,
    });

    // If files were uploaded via multer, save filenames/paths on the user document
    // (optional) - keep minimal references so admins can review attachments.
    if (req.files) {
      // Store the public /uploads path, not the bare filename these used to
      // hold: a filename alone is unusable by any client, and nothing served
      // the folder either, so every document uploaded before this was
      // effectively write-only.
      const take = (field) => storedPath((req.files[field] || [])[0], "documents");
      const logo = take("logoFile");
      const license = take("licenseFile");
      const gst = take("gstFile");
      if (logo) user.logoFile = logo;
      if (license) user.licenseFile = license;
      if (gst) user.gstFile = gst;
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);

    // Issued now, not at approval: an applicant who has to chase their
    // application needs a reference number today, while it's still pending.
    user.vendorCode = await generateVendorCode(User);

    await user.save();

    // Admins' Vendor Management shows the new application without a refresh.
    realtime.toAdmins(realtime.EVENTS.VENDOR_REQUEST_CREATED, {
      vendorId: String(user._id),
      name: user.name,
      businessName: user.businessName,
      vendorStatus: user.vendorStatus,
    });

    // No session: a pending vendor cannot use the panel, and signing them in
    // would replace whatever session this browser already has. They sign in
    // once approved, with their emailed secret code.
    res.json({
      msg: "Vendor registration submitted! Pending admin approval.",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        vendorStatus: user.vendorStatus,
        vendorCode: user.vendorCode,
        businessName: user.businessName,
        vendorFuelTypes: user.vendorFuelTypes,
      },
    });
  } catch (err) {
    console.error("[Vendor Register] Error:", err.message);
    if (err.code === 11000) {
      return res
        .status(400)
        .json({ msg: "An account with this email already exists." });
    }
    res.status(500).json({ msg: "Server error. Please try again." });
  }
};

// ============================================================
// GET VENDOR STATS BY STATUS (for quick counts)
// ============================================================
exports.getVendorStatusCounts = async (req, res) => {
  try {
    const counts = await User.aggregate([
      { $match: { role: "vendor" } },
      { $group: { _id: "$vendorStatus", count: { $sum: 1 } } },
    ]);

    const result = {
      total: 0,
      pending: 0,
      under_review: 0,
      active: 0,
      suspended: 0,
      rejected: 0,
    };

    counts.forEach((c) => {
      result[c._id] = c.count;
      result.total += c.count;
    });

    res.json(result);
  } catch (err) {
    console.error("[Vendor Status Counts] Error:", err.message);
    res.status(500).json({ msg: "Server error. Please try again." });
  }
};