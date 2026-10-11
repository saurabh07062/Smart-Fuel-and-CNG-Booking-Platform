import type { BookingStatus } from "./api";

export interface Booking {
  _id: string;
  bookingId?: string;
  /** Admin order reference, when one was issued. */
  orderId?: string;
  /** When the attendant recorded a pay-at-the-pump payment, and who did. */
  collectedAt?: string | null;
  collectedBy?: string | null;
  user?: string | { _id: string; name?: string };
  station?: string | { _id: string; name?: string; owner?: string };
  stationName?: string;
  fuelType?: string;
  quantity?: number;
  price?: number;
  taxes?: number;
  amount?: number;
  bookingDate?: string;
  timeSlot?: string;
  status: BookingStatus;
  paymentStatus?: string;
  /** How a pay-at-the-pump payment was collected: cash, or UPI scanned at the pump. */
  collectionMethod?: "cash" | "upi" | null;
  /** When the customer tapped "Check In at Petrol Pump" at the station. */
  stationCheckInAt?: string | null;
  /**
   * Vehicles ahead, position, wait and estimated start, computed by the
   * server for an active booking (backend services/queue/queueInfo.js); null otherwise.
   */
  queueInfo?: {
    vehicleCountAhead: number;
    queuePosition: number;
    expectedWaitingSeconds: number;
    expectedWaitingTime: string;
    estimatedStartTime: string | null;
  } | null;
  payMethod?: string;
  vehiclePlate?: string;
  /** Snapshot of the vehicle at booking time. Null on older bookings. */
  vehicleType?: string | null;
  vehicleName?: string | null;
  /** Set when the customer booked the slot for another person. */
  bookedForName?: string | null;
  bookedForPhone?: string | null;
  verificationCode?: string;
  bookingStartTime?: string;
  bookingEndTime?: string;
  /**
   * How long the nozzle is held, decided by the server from
   * backend/config/fuelDurations.js -- CNG 300s, petrol/diesel 40s. The
   * client NEVER computes this; it only displays it and counts down to it.
   */
  serviceDurationSeconds?: number;
  /** Set by the vendor when fueling actually starts. Anchors the countdown. */
  fuelingStartTime?: string | null;
  arrivalTime?: string | null;
  completionTime?: string | null;
  /** Minutes until this booking's turn at the nozzle, from the live line (today only). */
  etaMinutes?: number | null;
  /** Place in today's nozzle line, from the live eta_update event. */
  queuePosition?: number | null;
  /** Place in line for a waitlisted booking's slot (1 = next to be promoted). */
  waitlistPosition?: number | null;
  createdAt?: string;
}

/** One row of GET /api/bookings/availability -- services/queue/nozzleScheduler.js. */
export interface SlotAvailability {
  label: string;
  start: string | null;
  end: string | null;
  durationSeconds: number | null;
  /** The nozzle is free for this fuel's service window. */
  available: boolean;
  elapsed?: boolean;
  /** Within the station's opening hours that day. */
  withinHours?: boolean;
  /** Can be booked: not passed, open, nozzle free. */
  bookable?: boolean;
  reason?: "PASSED" | "CLOSED" | "RESERVED" | null;
  /**
   * The window's capacity for this fuel (backend services/queue/slotAllocator.js):
   * total = nozzles x services that fit in 30 minutes; available = still free.
   */
  capacity?: { total: number; available: number; reserved: number; resources: number };
}

export interface AvailabilityResponse {
  stationId: string;
  fuelType: string;
  date: string;
  stationActive?: boolean;
  slots: SlotAvailability[];
}

/** The booking wizard's in-progress selection (Vanilla's state.bookingData). */
export interface BookingDraft {
  stationId: string | null;
  stationName: string | null;
  fuelType: string | null;
  /** A saved vehicle's id, or null for a one-time vehicle entered in the wizard. */
  vehicleId: string | null;
  vehiclePlate: string | null;
  /** Only needed for a one-time vehicle; a saved one is resolved from the user. */
  vehicleType: string | null;
  vehicleName: string | null;
  date: string | null;
  timeSlot: string | null;
  quantity: number;
  /**
   * How the customer is saying "how much".
   *
   * "quantity" is the original flow: they choose litres/kg. "amount" is
   * "₹1000 of petrol" -- they type rupees and the SERVER divides by the
   * station's published price (backend services/booking/fuelAmount.js). The
   * litres shown on screen in that mode are a preview of that division, and
   * the booking uses the server's figure, not this one.
   */
  bookBy: "quantity" | "amount";
  /** The rupees typed, when bookBy is "amount". */
  fuelAmount: number;
  payMethod: string | null;
  /** Set when the slot is booked for someone else; null = for the customer. */
  bookedForName: string | null;
  bookedForPhone: string | null;
  /**
   * Reward points the customer chose to spend on this booking.
   *
   * A request, not a decision: the SERVER checks the balance and the cap and
   * works out the discount (backend services/rewards/rewardService.js), so the
   * figures on screen are a preview of its answer -- never the authority.
   */
  redeemPoints: number;
}
