/**
 * Booking constants.
 *
 * TIME_SLOTS mirrors backend/config/booking.js BOOKABLE_SLOT_LABELS. The slot
 * grid renders the server's GET /api/bookings/availability rows (which also
 * apply the station's opening hours and the nozzle); this list is only the
 * fallback while that loads, and the check that a slot passed in a URL is a
 * real label.
 */
export const TIME_SLOTS = [
  "6:00 AM", "6:30 AM", "7:00 AM", "7:30 AM", "8:00 AM", "8:30 AM",
  "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "11:00 AM", "11:30 AM",
  "12:00 PM", "12:30 PM", "1:00 PM", "1:30 PM", "2:00 PM", "2:30 PM",
  "3:00 PM", "3:30 PM", "4:00 PM", "4:30 PM", "5:00 PM", "5:30 PM",
  "6:00 PM", "6:30 PM", "7:00 PM", "7:30 PM", "8:00 PM", "8:30 PM",
  "9:00 PM", "9:30 PM",
] as const;

export const BOOKING_STEPS = ["Fuel & Vehicle", "Date & Slot", "Quantity", "Confirm & Pay"];

/** Flat convenience fee added to every booking. Vanilla's SERVICE_FEE. */
export const SERVICE_FEE = 5;

export const QUANTITY_MIN = 1;
export const QUANTITY_MAX = 60;
export const QUANTITY_DEFAULT = 5;
export const QUANTITY_PRESETS = [5, 10, 15, 20];

/**
 * Client-side FALLBACK service durations, used only to render a countdown for
 * an older booking whose document predates `serviceDurationSeconds`.
 *
 * These mirror backend/config/fuelDurations.js, which is the single source of
 * truth -- the server stamps every new booking with its own value and this is
 * never used to decide anything, only to display something sensible when the
 * field is genuinely absent.
 */
export const FALLBACK_SERVICE_SECONDS = { cng: 300, other: 40 } as const;

export function fallbackServiceSeconds(fuelType?: string): number {
  return String(fuelType).toLowerCase() === "cng"
    ? FALLBACK_SERVICE_SECONDS.cng
    : FALLBACK_SERVICE_SECONDS.other;
}

/**
 * The one payment method offered: pay the attendant at the petrol pump.
 * Online payment is switched off on the server (backend/src/config/payments.js),
 * which refuses any other method.
 */
export const PAY_AT_PUMP = "station";

export const PAY_METHODS: Array<{ icon: string; name: string; sub?: string; id: string }> = [
  { icon: "fa-gas-pump", name: "Pay at the petrol pump", sub: "Cash or UPI to the attendant", id: PAY_AT_PUMP },
];

/** Methods settled at the pump rather than through Razorpay. */
export const OFFLINE_PAY_METHODS = ["cod", "station"];
