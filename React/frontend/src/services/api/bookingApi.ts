import { apiClient } from "./apiClient";
import type { AvailabilityResponse, Booking } from "@/types";

/**
 * Booking endpoints -- backend/routes/bookingRoutes.js and the customer's
 * own listing in customerRoutes.js. Contracts unchanged.
 */

/**
 * The user's bookings.
 *
 * /api/customer/bookings first, falling back to /api/bookings, exactly as
 * fetchUserBookings() in js/app.js did. The fallback is not redundant: the
 * customer route additionally runs expireUserPastBookings() server-side, and
 * a vendor/admin token gets a 403 there and needs the generic route.
 */
export async function fetchMyBookings(): Promise<Booking[]> {
  try {
    const { data } = await apiClient.get<Booking[]>("/customer/bookings");
    if (Array.isArray(data)) return data;
  } catch {
    /* fall through to the generic route below */
  }
  const { data } = await apiClient.get<Booking[]>("/bookings");
  return Array.isArray(data) ? data : [];
}

export async function fetchBookingById(id: string): Promise<Booking> {
  const { data } = await apiClient.get<Booking>(`/bookings/${id}`);
  return data;
}

/** PATCH /api/bookings/:id/cancel -- the server owns the cancellation rules. */
export async function cancelBooking(id: string, reason?: string): Promise<{ msg?: string; booking?: Booking }> {
  const { data } = await apiClient.patch(`/bookings/${id}/cancel`, reason ? { reason } : undefined);
  return data;
}

export interface CreateBookingResponse {
  msg?: string;
  booking: Booking;
}

/**
 * POST /api/bookings.
 *
 * The body keys are exactly what bookingController.createBooking requires --
 * quantity, price and bookingDate included. Omitting them is what made every
 * booking fail validation in an earlier version of the Vanilla app.
 */
export async function createBooking(payload: Record<string, unknown>): Promise<CreateBookingResponse> {
  const { data } = await apiClient.post<CreateBookingResponse>("/bookings", payload);
  return data;
}

/**
 * GET /api/bookings/availability -- real per-slot nozzle availability from
 * services/queue/nozzleScheduler.js.
 *
 * The server stays the final authority at submit time regardless; this only
 * stops the grid showing every slot as clickable when the nozzle is already
 * reserved.
 */
export async function fetchAvailability(
  stationId: string,
  fuelType: string,
  date: string,
): Promise<AvailabilityResponse> {
  const { data } = await apiClient.get<AvailabilityResponse>("/bookings/availability", {
    params: { stationId, fuelType, date },
  });
  return data;
}

/** GET /api/v1/slots/recommend-alternative -- see BookingRecommendation. */
export interface BookingRecommendation {
  target: {
    stationId: string;
    name: string;
    canBook: boolean;
    unavailableCode: string | null;
    unavailableReason: string | null;
    distanceKm: number;
    waitMinutes: number | null;
    totalTripTimeMinutes: number | null;
  };
  alternative: {
    stationId: string;
    name: string;
    address?: string;
    distanceKm: number;
    waitMinutes: number;
    totalTripTimeMinutes: number;
    /** null when the chosen station cannot take the booking at all. */
    timeSavedMinutes: number | null;
    price: number | null;
    reason: string;
  } | null;
  candidatesChecked: number;
  /** "app-nozzle" (today's live line) or "reserved-slot" (another day). */
  waitBasis: string;
  /** "customer" or "target-station" when the customer's position is unknown. */
  positionBasis: string;
}

/**
 * The server's decision on whether another station serves this exact booking
 * better. Nothing is decided in the browser.
 */
export async function fetchBookingRecommendation(params: {
  stationId: string;
  fuelType: string;
  quantity: number;
  date: string;
  timeSlot: string;
  lat?: number;
  lng?: number;
}): Promise<BookingRecommendation> {
  const { data } = await apiClient.get<BookingRecommendation>("/v1/slots/recommend-alternative", { params });
  return data;
}

/** One vehicle in a fuel's line. Vehicles are masked plates only -- never customers. */
export interface QueuePreviewEntry {
  position: number;
  kind: "booking" | "walkin";
  vehicle: string | null;
  quantity: number | null;
  /** serving: at the nozzle · waiting: in line now · booked: a later slot today */
  status: "serving" | "waiting" | "booked";
  serviceSeconds: number;
  startsAt: string | null;
  endsAt: string | null;
}

/**
 * GET /api/v1/discovery/stations/:id/queue-preview -- the real line on one
 * fuel's nozzle and where this booking would stand in it, computed by the
 * server from live bookings and walk-ins (backend services/queue/stationQueue.js
 * buildQueuePreview). Nothing here is estimated in the browser.
 */
export interface QueuePreview {
  stationId: string;
  stationName: string;
  stationActive: boolean;
  fuelType: string;
  unit: string;
  /** Server time the figures were computed at. */
  asOf: string;
  basis: string;
  currentServing: {
    vehicle: string | null;
    kind: "booking" | "walkin";
    quantity: number | null;
    serviceSeconds: number;
    startedAt: string;
    endsAt: string;
    remainingSeconds: number;
  } | null;
  vehiclesWaiting: number;
  queueLength: number;
  waitMinutes: number;
  queue: QueuePreviewEntry[];
  you: {
    quantity: number;
    serviceSeconds: number;
    joinAt: string;
    position: number;
    vehiclesAhead: number;
    estimatedWaitSeconds: number;
    estimatedStartAt: string;
    estimatedCompleteAt: string;
    /** "scheduler" (the position a booking would get), "app-nozzle" (today's live line) or "reserved-slot". */
    basis: string;
  };
  /** The scheduler's summary for the chosen window; null without one. */
  schedule?: {
    fuelType: string;
    serviceDurationSeconds: number;
    resources: number;
    vehiclesServing: number;
    queueAhead: number;
    expectedWaitSeconds: number | null;
    estimatedStartTime: string | null;
    estimatedCompletionTime: string | null;
    availableCapacity: number;
    totalCapacity: number;
    resourceAvailable: boolean;
    reason: string | null;
  } | null;
  date: string | null;
  timeSlot: string | null;
}

export async function fetchQueuePreview(params: {
  stationId: string;
  fuelType: string;
  quantity: number;
  date?: string | null;
  timeSlot?: string | null;
}): Promise<QueuePreview> {
  const { stationId, fuelType, quantity, date, timeSlot } = params;
  const { data } = await apiClient.get<QueuePreview>(`/v1/discovery/stations/${stationId}/queue-preview`, {
    params: {
      fuelType,
      quantity,
      ...(date ? { date } : {}),
      ...(date && timeSlot ? { timeSlot } : {}),
    },
  });
  return data;
}

export interface UpiPayment {
  bookingId: string;
  stationName: string;
  verificationCode?: string;
  /** The upi://pay?... intent. Opens a UPI app directly on a phone. */
  uri: string;
  /** Server-rendered PNG data URI, when the server could produce one. */
  qrDataUri?: string | null;
  vpa: string;
  payeeName: string;
  amount: number;
}

/**
 * GET /api/v1/slots/:bookingId/upi -- the UPI intent for a pay-at-station
 * booking, so the customer can scan and pay the exact amount at the pump.
 *
 * The endpoint answers 409 for a booking that is already paid or was not a
 * pay-at-station booking, and 503 when no UPI id is configured. None of those
 * are errors the customer can act on and the booking is still valid either
 * way, so the caller falls back to "pay the attendant" rather than surfacing
 * them -- the same quiet fallback the Vanilla loadUpiPayment() had.
 */
export async function fetchUpiPayment(bookingId: string): Promise<UpiPayment | null> {
  try {
    const { data } = await apiClient.get<UpiPayment>(`/v1/slots/${bookingId}/upi`);
    return data?.uri ? data : null;
  } catch {
    return null;
  }
}
