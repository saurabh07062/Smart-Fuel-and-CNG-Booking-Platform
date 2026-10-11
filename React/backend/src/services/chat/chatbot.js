/**
 * The assistant: what it knows, and how it answers.
 *
 * TWO HARD RULES
 *
 * 1. It never computes anything of its own. Bookings, queue positions, waits,
 *    ETAs, prices, stock, check-in state and payment state are read through the
 *    services that already own them (services/chat/context.js). The assistant
 *    is a way of ASKING the existing system, not a second copy of it.
 *
 * 2. It never invents. Every answer is built from a field that was actually
 *    read. When a field is null -- a price the vendor has not published, a
 *    queue that could not be read -- the answer says the information is not
 *    available. There is no "about 10 minutes", no "approximately", no filler.
 *    That is why this is rule-based rather than generative: a language model
 *    would produce a plausible queue position, and a plausible queue position
 *    at a fuel pump is worse than none.
 *
 * WHAT IT IS AWARE OF
 *
 *   customer  their own active booking (or that they have none), and the help
 *             topics of the project
 *   vendor    their own stations: today's bookings, who is being served, who is
 *             waiting, prices, stock, station status
 *   admin     the support queue: what is unresolved, and how old
 *
 * Each of those is read for the SIGNED-IN user only. A customer's context query
 * is filtered by their own id, a vendor's by the stations they own; neither can
 * be widened by anything in the request.
 */

const context = require("./context");
const conversations = require("./conversations");

/** The help topics a customer with no booking is offered, and their answers. */
const HELP_TOPICS = [
  {
    id: "find_station",
    label: "Find a nearby station",
    icon: "fa-location-crosshairs",
    answer:
      "Open Find Fuel on your dashboard and allow location access. FuelMart lists the stations nearest to you with their distance, current prices and how busy each one is. You can also search by name or area, or pick a pin on the map.",
  },
  {
    id: "book_slot",
    label: "How do I book a slot?",
    icon: "fa-calendar-check",
    answer:
      "Pick a station, choose the fuel and how much you need, then choose a time slot. Slots are shown only while the station is open and has that fuel available. Confirm and you get a booking with a 4-digit code.",
  },
  {
    id: "cancel_booking",
    label: "How do I cancel?",
    icon: "fa-circle-xmark",
    answer:
      "Open the booking from My Bookings and choose Cancel. You can cancel any time before fuelling starts; once the attendant has started your fill it can no longer be cancelled. Cancelling frees the slot and the fuel reserved for it straight away.",
  },
  {
    id: "check_in",
    label: "How does check-in work?",
    icon: "fa-map-pin",
    answer:
      "When you reach the station, tap \"Check In at Petrol Pump\" in the app. You must actually be at the station -- the app checks your location. Your 4-digit code only works after that check-in, which is what stops someone else using your code while you are elsewhere. The attendant then enters the code and fuelling starts.",
  },
  {
    id: "queue_eta",
    label: "How are the queue and ETA worked out?",
    icon: "fa-hourglass-half",
    answer:
      "Every booking holds a slot on one of the station's nozzles. Your position counts the vehicles that hold that nozzle before you, including walk-in customers the station has recorded, and the wait is the time until your nozzle is free. Both are recalculated as cars arrive and finish, so they change while you wait.",
  },
  {
    id: "fuel_prices",
    label: "Fuel availability and prices",
    icon: "fa-indian-rupee-sign",
    answer:
      "Each station publishes its own prices, and a fuel can be marked out of service even when the station is open. A station shows the price only when its vendor has published one -- when you see \"Not set\", no price has been published and you cannot book that fuel there yet.",
  },
  {
    id: "payment",
    label: "How do I pay?",
    icon: "fa-wallet",
    answer:
      "Payment is made at the petrol pump. The attendant records it as cash or UPI once your fill is done, and your booking then shows as paid. Nothing is charged when you book.",
  },
  {
    id: "fuel_types",
    label: "Petrol, Diesel or CNG",
    icon: "fa-gas-pump",
    answer:
      "Petrol and diesel are booked in litres, CNG in kilograms, and a station only offers the fuels it actually sells. CNG fills take longer than petrol or diesel, which is why a CNG queue of the same length shows a longer wait.",
  },
  {
    id: "contact_vendor",
    label: "Contact the station",
    icon: "fa-store",
    answer:
      "Open your booking and use Contact Vendor to message the station team about that booking. If the station has recorded a phone number it is shown on the booking as well.",
  },
  {
    id: "contact_admin",
    label: "Chat with the admin team",
    icon: "fa-headset",
    answer:
      "Use \"Chat with Admin\" here. Your booking details are attached automatically, so you do not have to type out a reference. The team replies in this chat and you can see the whole history any time.",
  },
];

/** The vendor-operations questions the vendor assistant offers. */
const VENDOR_TOPICS = [
  {
    id: "vendor_checkin",
    label: "How does a customer check in?",
    icon: "fa-map-pin",
    answer:
      "The customer taps \"Check In at Petrol Pump\" in their app, at your station. Only then does their 4-digit code work: enter it in Bookings to start fuelling. If someone reaches the pump before an earlier booking, FuelMart tells you and you can still continue.",
  },
  {
    id: "vendor_queue",
    label: "How is my queue calculated?",
    icon: "fa-hourglass-half",
    answer:
      "Each fuel's nozzles are split between app bookings and walk-ins (Stations -> Nozzles). The queue counts the vehicles holding each nozzle, including the walk-ins you record, and the wait follows from the fill times of the fuel.",
  },
  {
    id: "vendor_prices",
    label: "How do I update prices?",
    icon: "fa-indian-rupee-sign",
    answer:
      "Stations -> your station -> Prices. A price of 0 means \"not published\": customers see \"Not set\" and cannot book that fuel until you publish one. Every change is recorded with the old and the new price.",
  },
  {
    id: "vendor_stock",
    label: "Stock and deliveries",
    icon: "fa-gauge-high",
    answer:
      "Record a delivery or a physical count in Inventory. FuelMart holds back the fuel promised to live bookings, so a booking is only accepted while the free stock covers it -- which is why available stock is lower than the tank figure.",
  },
  {
    id: "vendor_payment",
    label: "Collecting payment",
    icon: "fa-wallet",
    answer:
      "Payment is taken at the pump. After the fill, use Collect payment on the booking and record cash or UPI. Revenue counts a booking once it is completed AND the payment is recorded, which is why a finished fill can still show as awaiting collection.",
  },
  {
    id: "vendor_support",
    label: "Chat with the admin team",
    icon: "fa-headset",
    answer:
      "Use \"Chat with Admin\" here for anything the panel cannot settle -- an account or station problem, a booking that looks wrong, or a payment dispute. Your station details go with the conversation.",
  },
];

// ── context ────────────────────────────────────────────────────────────────

/**
 * Everything the assistant may show this user on opening.
 *
 * The shape is the same for every role -- { role, greeting, quickActions,
 * booking|station|support, support } -- so one component renders it, and each
 * section carries `available` to distinguish "nothing to show" from "could not
 * be read".
 */
async function contextFor(user, { now = new Date() } = {}) {
  if (user.role === "vendor") return vendorContext(user, now);
  if (user.role === "admin") return adminContext(user, now);
  return customerContext(user, now);
}

async function customerContext(user, now) {
  const [booking, unread] = await Promise.all([
    context.activeBookingFor(user.id, { now }).catch(() => undefined),
    conversations.unreadSummary(user).catch(() => null),
  ]);

  // undefined = the read failed; null = they genuinely have no active booking.
  const readFailed = booking === undefined;
  const summary = readFailed ? null : context.bookingSummary(booking);

  return {
    role: "customer",
    generatedAt: now,
    booking: {
      available: !readFailed,
      hasBooking: Boolean(summary),
      summary,
    },
    support: unread,
    quickActions: summary ? bookingActions(summary) : HELP_TOPICS.map(({ id, label, icon }) => ({ id, label, icon })),
    /** For the "Contact Vendor" button: only when there is a booking to discuss. */
    canContactVendor: Boolean(summary?.station?.stationId),
    greeting: readFailed
      ? "I could not read your bookings just now. Try again in a moment, or chat with the admin team."
      : summary
        ? `You have a ${summary.fuelType} booking at ${summary.station?.name || "your station"}.`
        : "You have no active booking. I can help you find a station or explain how FuelMart works.",
  };
}

/** The follow-up questions that make sense for a booking that exists. */
function bookingActions(summary) {
  const actions = [
    { id: "booking_where", label: "Where is my booking?", icon: "fa-location-dot" },
    { id: "booking_queue", label: "Queue and waiting time", icon: "fa-hourglass-half" },
    { id: "booking_checkin", label: "Check-in and my code", icon: "fa-map-pin" },
    { id: "booking_payment", label: "Payment status", icon: "fa-wallet" },
    { id: "cancel_booking", label: "How do I cancel?", icon: "fa-circle-xmark" },
  ];
  if (summary.station?.stationId) actions.push({ id: "contact_vendor", label: "Contact the station", icon: "fa-store" });
  return actions;
}

/**
 * A vendor's own stations: today's figures, the live line, prices and stock.
 *
 * Read through the same services the vendor panel uses, for the stations this
 * vendor owns and no others.
 */
async function vendorContext(user, now) {
  const Station = require("../../models/Station");
  const Booking = require("../../models/Booking");
  const { dateKey } = require("../../config/businessTime");
  const stationQueue = require("../queue/stationQueue");

  const stations = await Station.find({ owner: user.id })
    .select("name address status prices inventory inventoryCommitted tankCapacity fuelTypes fuelAvailability contactPhone")
    .lean();

  if (stations.length === 0) {
    return {
      role: "vendor",
      generatedAt: now,
      stations: { available: true, count: 0, list: [] },
      greeting: "You have no station yet. Add one in Stations and I can then show its bookings, queue and stock.",
      quickActions: VENDOR_TOPICS.map(({ id, label, icon }) => ({ id, label, icon })),
      support: await conversations.unreadSummary(user).catch(() => null),
    };
  }

  const ids = stations.map((s) => s._id);
  const today = dateKey(now);

  const [byStatus, snapshots, unread] = await Promise.all([
    Booking.aggregate([
      { $match: { station: { $in: ids }, bookingDate: today } },
      { $group: { _id: { station: "$station", status: "$status" }, n: { $sum: 1 } } },
    ]).catch(() => null),
    stationQueue.queueSnapshots(ids, now).catch(() => null),
    conversations.unreadSummary(user).catch(() => null),
  ]);

  const counts = new Map();
  for (const row of byStatus || []) {
    const key = String(row._id.station);
    if (!counts.has(key)) counts.set(key, {});
    counts.get(key)[row._id.status] = row.n;
  }

  const list = stations.map((station) => {
    const key = String(station._id);
    const today = counts.get(key) || {};
    const snapshot = snapshots?.get(key) || null;
    return {
      stationId: key,
      name: station.name,
      address: station.address,
      status: station.status,
      phone: station.contactPhone || null,
      fuelTypes: station.fuelTypes || [],
      // A price of 0/absent is "not published", and it stays null here rather
      // than becoming a number the assistant would read out as a real rate.
      prices: ["petrol", "diesel", "cng"].reduce((out, fuel) => {
        const value = station.prices?.[fuel];
        out[fuel] = typeof value === "number" && value > 0 ? value : null;
        return out;
      }, {}),
      fuelAvailability: {
        petrol: station.fuelAvailability?.petrol !== false,
        diesel: station.fuelAvailability?.diesel !== false,
        cng: station.fuelAvailability?.cng !== false,
      },
      stock: ["petrol", "diesel", "cng"].reduce((out, fuel) => {
        const held = Number(station.inventoryCommitted?.[fuel]) || 0;
        const have = Number(station.inventory?.[fuel]);
        out[fuel] = Number.isFinite(have)
          ? { inTank: have, promisedToBookings: held, freeToSell: Math.max(have - held, 0), capacity: station.tankCapacity?.[fuel] ?? null }
          : null;
        return out;
      }, {}),
      bookingsToday: {
        available: byStatus !== null,
        upcoming: today.upcoming || 0,
        serving: today.serving || 0,
        waitlisted: today.waitlisted || 0,
        completed: today.completed || 0,
        cancelled: today.cancelled || 0,
        noShow: today.no_show || 0,
        total: Object.values(today).reduce((a, b) => a + b, 0),
      },
      queue: snapshot
        ? {
            available: true,
            waiting: snapshot.queueLength ?? null,
            waitMinutes: snapshot.waitMinutes ?? null,
            status: snapshot.queueStatus ?? null,
            byFuel: stationQueue.fuelQueueSummary(snapshot),
          }
        : { available: false },
    };
  });

  return {
    role: "vendor",
    generatedAt: now,
    stations: { available: true, count: list.length, list },
    support: unread,
    quickActions: [
      { id: "vendor_today", label: "Today's bookings", icon: "fa-calendar-day" },
      { id: "vendor_waiting", label: "Who is waiting?", icon: "fa-users" },
      { id: "vendor_serving", label: "Who is being served?", icon: "fa-gas-pump" },
      { id: "vendor_stock", label: "Stock levels", icon: "fa-gauge-high" },
      { id: "vendor_prices", label: "My prices", icon: "fa-indian-rupee-sign" },
      { id: "vendor_support", label: "Chat with Admin", icon: "fa-headset" },
    ],
    greeting:
      list.length === 1
        ? `${list[0].name}: ${list[0].bookingsToday.total} booking(s) today, ${list[0].queue.available ? `${list[0].queue.waiting} waiting` : "queue unavailable"}.`
        : `You have ${list.length} stations. Ask me about any of them.`,
  };
}

/** The admin's own view: what support work is outstanding. */
async function adminContext(user, now) {
  const Conversation = require("../../models/Conversation");
  const [byKind, unread] = await Promise.all([
    Conversation.aggregate([
      { $match: { kind: { $in: ["customer_admin", "vendor_admin"] } } },
      { $group: { _id: { kind: "$kind", status: "$status" }, n: { $sum: 1 } } },
    ]).catch(() => null),
    conversations.unreadSummary(user).catch(() => null),
  ]);

  const tally = { customer_admin: {}, vendor_admin: {} };
  for (const row of byKind || []) tally[row._id.kind][row._id.status] = row.n;

  return {
    role: "admin",
    generatedAt: now,
    support: unread,
    conversations: {
      available: byKind !== null,
      customer: tally.customer_admin,
      vendor: tally.vendor_admin,
    },
    quickActions: [
      { id: "admin_pending", label: "Pending vendor issues", icon: "fa-store" },
      { id: "admin_unresolved", label: "Unresolved customer chats", icon: "fa-users" },
      { id: "admin_unread", label: "Waiting for a reply", icon: "fa-envelope" },
    ],
    greeting: unread
      ? `${unread.threads} conversation(s) waiting for the team.`
      : "Support overview.",
  };
}

// ── answering ──────────────────────────────────────────────────────────────

/**
 * Words that point at an intent, PER ROLE, first match wins.
 *
 * The role's own table is consulted before the shared one, because the same
 * words mean different things to different people: "who is waiting?" from a
 * vendor is their station's line, while "how long am I waiting?" from a
 * customer is their own booking. One flat table answered the vendor's question
 * with the customer's intent -- which is exactly the kind of confident wrong
 * answer this assistant is built to avoid.
 */
const ROLE_INTENTS = {
  customer: [
    ["booking_where", ["where is my booking", "where is my order", "my booking", "my order", "status of my booking", "booking status"]],
    ["booking_checkin", ["check in", "check-in", "checkin", "my pin", "my code", "the code", "qr", "otp"]],
    ["booking_payment", ["payment", "pay", "paid", "amount", "bill", "invoice", "refund"]],
    ["booking_queue", ["queue", "how long", "waiting", "wait time", "eta", "position", "ahead of me"]],
    ["cancel_booking", ["cancel", "cancellation"]],
    ["book_slot", ["book fuel", "want to book", "make a booking", "book a slot", "how to book", "new booking", "booking fuel"]],
    ["find_station", ["nearby", "nearest", "find a station", "find station", "where can i", "petrol pump near", "station near"]],
    ["contact_vendor", ["contact vendor", "contact station", "talk to the station", "call the pump", "vendor number"]],
  ],
  vendor: [
    ["vendor_waiting", ["waiting", "who is waiting", "how many customers", "queue", "line"]],
    ["vendor_today", ["today's bookings", "todays bookings", "bookings today", "how many bookings", "today"]],
    ["vendor_serving", ["being served", "who is serving", "currently fuelling", "currently fueling", "at the pump now", "serving"]],
    ["vendor_stock", ["stock", "inventory", "tank", "litres left", "how much fuel", "how much petrol", "how much diesel"]],
    ["vendor_prices", ["price", "prices", "rate", "update price", "change price"]],
    ["vendor_status", ["station status", "is my station open", "am i open"]],
    ["vendor_support", ["admin", "support", "complaint", "help me", "human", "agent"]],
  ],
  admin: [
    ["admin_pending", ["pending vendor", "vendor issues", "vendor problems", "vendor conversations", "vendor chats"]],
    ["admin_unresolved", ["unresolved", "open conversations", "open chats", "customer issues", "customer conversations"]],
    ["admin_unread", ["unread", "waiting for a reply", "needs reply", "waiting for the team"]],
  ],
};

/** Help topics anyone may ask about, whatever their role. */
const SHARED_INTENTS = [
  ["queue_eta", ["how does the queue work", "how is eta", "how is the wait", "how is the queue"]],
  ["check_in", ["how does check in work", "how does check-in work"]],
  ["payment", ["payment methods", "how do i pay", "online payment"]],
  ["fuel_prices", ["price", "rate", "cost", "availability", "available"]],
  ["fuel_types", ["cng", "petrol", "diesel", "kg", "litre", "liter"]],
  ["contact_admin", ["admin", "support", "complaint", "help me", "human", "agent"]],
];

/**
 * The intent behind a question, or null when nothing matches.
 *
 * `role` is the asker's verified role; an unknown role falls back to the
 * customer table, which is the only audience that can reach the assistant
 * without one.
 */
function intentOf(question, role = "customer") {
  const text = String(question || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return null;
  const tables = [...(ROLE_INTENTS[role] || ROLE_INTENTS.customer), ...SHARED_INTENTS];
  for (const [intent, words] of tables) {
    if (words.some((w) => text.includes(w))) return intent;
  }
  return null;
}

/**
 * Answer one question, or one quick action.
 *
 * `intent` (a quick-action id) wins over `question` when both are sent, because
 * a tapped button is not a guess. An unrecognised question is answered
 * honestly: it says it did not understand and offers the topics it does know,
 * rather than producing something that sounds like an answer.
 */
async function answer(user, { question, intent } = {}) {
  const chosen = (typeof intent === "string" && intent.trim()) || intentOf(question, user.role);
  const ctx = await contextFor(user);

  if (!chosen) {
    return {
      intent: null,
      answer:
        "I did not understand that. I can answer questions about your bookings, the queue, check-in, prices and payment -- or put you through to the admin team.",
      quickActions: ctx.quickActions,
      context: ctx,
      understood: false,
    };
  }

  const reply =
    (user.role === "vendor" && vendorAnswer(chosen, ctx)) ||
    (user.role === "admin" && adminAnswer(chosen, ctx)) ||
    (user.role === "customer" && customerAnswer(chosen, ctx)) ||
    topicAnswer(chosen);

  if (!reply) {
    return {
      intent: chosen,
      answer: "I do not have an answer for that yet. The admin team can help.",
      quickActions: ctx.quickActions,
      context: ctx,
      understood: false,
    };
  }

  return {
    intent: chosen,
    understood: true,
    ...reply,
    context: ctx,
  };
}

/** A static help topic, for either audience. */
function topicAnswer(intent) {
  const topic = HELP_TOPICS.find((t) => t.id === intent) || VENDOR_TOPICS.find((t) => t.id === intent);
  return topic ? { answer: topic.answer, source: "help" } : null;
}

/**
 * The answers built from a customer's own booking.
 *
 * Each one states only fields that were actually read. `nothing()` is what an
 * unavailable figure gets -- never a guess.
 */
function customerAnswer(intent, ctx) {
  const b = ctx.booking?.summary;

  if (["booking_where", "booking_queue", "booking_checkin", "booking_payment"].includes(intent)) {
    if (!ctx.booking?.available) {
      return { answer: "I could not read your bookings just now, so I cannot tell you where this one stands. Please try again in a moment.", source: "unavailable" };
    }
    if (!b) {
      return {
        answer: "You have no active booking at the moment. I can help you find a station and book a slot.",
        source: "booking",
        quickActions: HELP_TOPICS.slice(0, 3).map(({ id, label, icon }) => ({ id, label, icon })),
      };
    }
  }

  switch (intent) {
    case "booking_where": {
      const lines = [
        `Booking ${b.reference || b.bookingId} at ${b.station?.name || "your station"} -- ${b.fuelType}${b.quantity ? ` ${b.quantity} ${b.unit}` : ""}.`,
        `Status: ${statusWords(b.status)}.`,
        b.bookingDate && b.timeSlot ? `Slot: ${b.timeSlot} on ${b.bookingDate}.` : null,
        queueLine(b),
        b.checkIn.done ? "You are checked in at the pump." : "You have not checked in yet -- tap Check In at Petrol Pump when you reach the station.",
        paymentLine(b),
      ].filter(Boolean);
      return { answer: lines.join("\n"), source: "booking", booking: b };
    }
    case "booking_queue":
      return { answer: [queueLine(b), b.status === "serving" ? "Your fill is in progress." : null].filter(Boolean).join("\n"), source: "booking", booking: b };
    case "booking_checkin": {
      const lines = [
        b.checkIn.done
          ? `You checked in at ${when(b.checkIn.at)}.`
          : "You have not checked in yet. Tap \"Check In at Petrol Pump\" in the app once you are at the station -- your location is checked.",
        b.pin
          ? b.pin.usable
            ? `Your code is ${b.pin.code}. Show it to the attendant.`
            : `Your code is ${b.pin.code}, and it starts working the moment you check in at the station.`
          : "Your code is issued once your slot is confirmed.",
      ];
      return { answer: lines.join("\n"), source: "booking", booking: b };
    }
    case "booking_payment":
      return { answer: [paymentLine(b), "Payment is made at the pump -- the attendant records it as cash or UPI."].join("\n"), source: "booking", booking: b };
    case "contact_vendor":
      if (b?.station) {
        return {
          answer: `You can message ${b.station.name || "the station"} about this booking${b.station.phone ? `, or call them on ${b.station.phone}` : ""}.`,
          source: "booking",
          action: { type: "contact_vendor", bookingId: b.bookingId, stationId: b.station.stationId },
        };
      }
      return topicAnswer("contact_vendor");
    case "contact_admin":
      return { ...topicAnswer("contact_admin"), action: { type: "contact_admin", bookingId: b?.bookingId || null } };
    default:
      return topicAnswer(intent);
  }
}

/** The answers built from a vendor's own stations. */
function vendorAnswer(intent, ctx) {
  const list = ctx.stations?.list || [];
  if (list.length === 0 && intent.startsWith("vendor_") && intent !== "vendor_support") {
    return { answer: "You have no station yet, so there is nothing to report. Add one in Stations.", source: "station" };
  }

  const per = (fn) => list.map(fn).filter(Boolean).join("\n");

  switch (intent) {
    case "vendor_today":
      return {
        answer: per((s) =>
          s.bookingsToday.available
            ? `${s.name}: ${s.bookingsToday.total} booking(s) today -- ${s.bookingsToday.upcoming} upcoming, ${s.bookingsToday.serving} being served, ${s.bookingsToday.completed} completed, ${s.bookingsToday.cancelled} cancelled.`
            : `${s.name}: today's bookings could not be read just now.`,
        ),
        source: "bookings",
      };
    case "vendor_waiting":
      return {
        answer: per((s) => {
          if (!s.queue.available) return `${s.name}: the queue could not be read just now.`;
          // A real zero is stated as a zero; it is only the phrasing that
          // changes, the same way the customer's "no wait" does.
          const wait =
            s.queue.waitMinutes == null
              ? ""
              : s.queue.waitMinutes === 0
                ? ", nobody waiting"
                : `, about ${s.queue.waitMinutes} minute(s) of queue`;
          return `${s.name}: ${s.queue.waiting} vehicle(s) in line${wait} (${s.queue.status || "status unknown"}).`;
        }),
        source: "queue",
      };
    case "vendor_serving":
      return {
        answer: per((s) =>
          s.bookingsToday.available
            ? `${s.name}: ${s.bookingsToday.serving} vehicle(s) being fuelled, ${s.bookingsToday.upcoming} still to arrive.`
            : `${s.name}: could not be read just now.`,
        ),
        source: "bookings",
      };
    case "vendor_stock":
      return {
        answer: per((s) => {
          const parts = Object.entries(s.stock)
            .filter(([, v]) => v)
            .map(([fuel, v]) => `${fuel}: ${v.freeToSell} free to sell of ${v.inTank} in tank${v.promisedToBookings ? ` (${v.promisedToBookings} held for bookings)` : ""}`);
          return parts.length ? `${s.name} -- ${parts.join("; ")}.` : `${s.name}: no stock recorded yet.`;
        }),
        source: "inventory",
      };
    case "vendor_prices":
      return {
        answer: per((s) => {
          const parts = Object.entries(s.prices).map(([fuel, price]) =>
            price == null ? `${fuel}: not published` : `${fuel}: ₹${price}`,
          );
          return `${s.name} -- ${parts.join("; ")}.`;
        }),
        source: "station",
      };
    case "vendor_status":
      return { answer: per((s) => `${s.name}: ${s.status}${s.phone ? ` · ${s.phone}` : ""}.`), source: "station" };
    case "vendor_support":
      return { ...topicAnswer("vendor_support"), action: { type: "contact_admin", bookingId: null } };
    default:
      return topicAnswer(intent) || null;
  }
}

/** The admin's own answers: the state of the support queue. */
function adminAnswer(intent, ctx) {
  if (!ctx.conversations?.available) {
    return { answer: "The support figures could not be read just now.", source: "unavailable" };
  }
  const { customer, vendor } = ctx.conversations;
  const live = (t) => (t.open || 0) + (t.pending || 0);

  switch (intent) {
    case "admin_pending":
      return {
        answer: `Vendor conversations: ${live(vendor)} unresolved (${vendor.open || 0} open, ${vendor.pending || 0} pending), ${vendor.resolved || 0} resolved.`,
        source: "conversations",
        action: { type: "open_centre", kind: "vendor_admin", status: "open" },
      };
    case "admin_unresolved":
      return {
        answer: `Customer conversations: ${live(customer)} unresolved (${customer.open || 0} open, ${customer.pending || 0} pending), ${customer.resolved || 0} resolved.`,
        source: "conversations",
        action: { type: "open_centre", kind: "customer_admin", status: "open" },
      };
    case "admin_unread":
      return {
        answer: ctx.support
          ? `${ctx.support.threads} conversation(s) with ${ctx.support.messages} unread message(s) waiting for the team.`
          : "The unread count could not be read just now.",
        source: "conversations",
        action: { type: "open_centre", kind: null, status: null },
      };
    default:
      return topicAnswer(intent) || null;
  }
}

// ── wording helpers ────────────────────────────────────────────────────────

/** The queue sentence, or an honest "not available". */
function queueLine(b) {
  const q = b?.queue;
  if (!q) return "A queue position is not available for this booking yet.";
  const bits = [];
  if (q.queuePosition != null) bits.push(`You are number ${q.queuePosition} in line`);
  if (q.vehicleCountAhead != null) bits.push(`${q.vehicleCountAhead} vehicle(s) ahead of you`);
  // queueInfo formats a zero wait as "No wait" (services/queue/queueInfo.js),
  // so the sentence has to bend around it: "about No wait to wait" is what
  // wrapping every value in the same phrase produced.
  if (q.expectedWaitingSeconds === 0 || /^no wait$/i.test(String(q.expectedWaitingTime || ""))) {
    bits.push("no wait");
  } else if (q.expectedWaitingTime) {
    bits.push(`about ${q.expectedWaitingTime} to wait`);
  }
  if (q.estimatedStartTime) bits.push(`expected to start around ${q.estimatedStartTime}`);
  return bits.length ? `${bits.join(", ")}.` : "A queue position is not available for this booking right now.";
}

/** The payment sentence, from the stored state only. */
function paymentLine(b) {
  const map = {
    due_at_station: "Payment is due at the pump",
    paid: "This booking is paid",
    pending: "Payment is pending",
    failed: "The last payment attempt failed",
    refunded: "This booking was refunded",
  };
  const state = map[b?.payment?.status] || "Payment status is not available";
  const amount = b?.amount != null ? ` (₹${b.amount})` : "";
  return `${state}${amount}.`;
}

/** Booking statuses in words a customer uses. */
function statusWords(status) {
  return (
    {
      upcoming: "confirmed, waiting for you to arrive",
      serving: "being fuelled now",
      waitlisted: "on the waiting list for that slot",
      completed: "completed",
      cancelled: "cancelled",
      no_show: "closed because the slot passed without an arrival",
      expired: "expired",
    }[status] || status
  );
}

function when(date) {
  if (!date) return "an unknown time";
  return new Date(date).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

module.exports = {
  HELP_TOPICS,
  VENDOR_TOPICS,
  contextFor,
  answer,
  intentOf,
  queueLine,
  paymentLine,
  statusWords,
};
