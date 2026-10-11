import { apiClient } from "./apiClient";

/**
 * Fleet booking -- one customer, several vehicles, one visit.
 *
 * Backend: routes/bookingRoutes.js ("/fleet/*"), planned by
 * services/booking/fleetPlanner.js and written by fleetBooking.js. The plan
 * holds nothing: the server allocates again on confirm, so the answer to
 * "is this slot still free?" is only ever given at the moment it matters.
 */

/** What a vehicle's row in the plan is doing. Drives the status chips. */
export type FleetVehicleState = "suggested" | "conflict" | "unavailable" | "full" | "selected" | "confirmed";

export interface FleetVehicleInput {
  vehiclePlate: string;
  quantity: number;
  /** The saved vehicle it came from, when it came from the garage. */
  vehicleId?: string | null;
  vehicleType?: string | null;
  nickname?: string | null;
  /** Set once a slot has been chosen or edited. */
  timeSlot?: string | null;
}

export interface FleetPlanVehicle extends FleetVehicleInput {
  index: number;
  state: FleetVehicleState;
  reason?: string;
  message?: string;
  timeSlot?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  resource?: number;
  durationSeconds?: number;
  pricePerUnit?: number;
  taxes?: number;
  amount?: number;
  existingBookingId?: string;
}

export interface FleetPlan {
  station: { stationId: string; name: string | null; nozzles: number };
  fuelType: string;
  unit: string;
  bookingDate: string;
  preferredSlot: string | null;
  generatedAt: string;
  vehicles: FleetPlanVehicle[];
  totals: {
    requested: number;
    scheduled: number;
    conflicts: number;
    unavailable: number;
    quantity: number;
    amount: number;
  };
  /** `freeToSell` is null when the station does not track that fuel's stock. */
  stock: { freeToSell: number | null; enough: boolean };
  consecutive: boolean;
  /** The plan in a sentence, including what could not be arranged. */
  summary: string;
}

export interface FleetBookingRow {
  bookingId: string;
  orderId: string | null;
  fleetGroup: string | null;
  fleetIndex: number | null;
  vehiclePlate: string | null;
  vehicleName: string | null;
  fuelType: string;
  quantity: number;
  amount: number;
  bookingDate: string;
  timeSlot: string;
  startTime: string | null;
  endTime: string | null;
  status: string;
  paymentStatus: string | null;
  verificationCode: string | null;
  qrCodeData: string | null;
  queueInfo: {
    queuePosition: number | null;
    vehicleCountAhead: number | null;
    expectedWaitingTime: string | null;
    estimatedStartTime: string | null;
  } | null;
  etaMinutes: number | null;
  stationCheckInAt: string | null;
}

export interface FleetGroup {
  fleetId: string;
  reference: string;
  fuelType: string;
  bookingDate: string;
  preferredSlot: string | null;
  vehicleCount: number;
  createdAt: string;
  station: { stationId: string; name?: string | null; address?: string | null; status?: string | null };
  /** Derived from the members on every read -- never a stored summary. */
  status: "active" | "completed" | "cancelled" | "partial" | "empty";
  counts: { total: number; live: number; completed: number; cancelled: number };
  quantity: number;
  amount: number;
  /** The group's reward-points discount, over the vehicles still going ahead. */
  rewardPointsUsed?: number;
  rewardDiscount?: number;
  /** What is collected at the pump for the whole group: amount - rewardDiscount. */
  payableAmount?: number;
  vehicles: { bookingId: string; vehiclePlate: string | null; timeSlot: string | null; status: string; paymentStatus: string | null }[];
  /** Present on a single-group read. */
  bookings?: FleetBookingRow[];
}

export interface FleetFailure {
  vehiclePlate: string;
  quantity: number;
  timeSlot: string | null;
  fleetIndex: number | null;
  reason: string;
  message: string;
}

export interface FleetConfirmation {
  group: FleetGroup;
  bookings: FleetBookingRow[];
  /** Vehicles that could not be booked, each with the reason in words. */
  failures: FleetFailure[];
  summary: string;
  /**
   * Present only when reward points were asked for: what the server actually
   * applied, or why it applied nothing. The points are split across the
   * vehicles that were booked (backend services/booking/fleetBooking.js).
   */
  reward?: { applied: boolean; points: number; discount: number; msg: string };
}

export interface FleetRequest {
  stationId: string;
  fuelType: string;
  bookingDate: string;
  preferredSlot?: string | null;
  vehicles: FleetVehicleInput[];
  /** Reward points to spend on the group, as one figure. The server splits it. */
  redeemPoints?: number;
}

/** POST /bookings/fleet/plan -- "Find best slots". Reserves nothing. */
export async function planFleet(input: FleetRequest): Promise<FleetPlan> {
  const { data } = await apiClient.post<FleetPlan>("/bookings/fleet/plan", input);
  return data;
}

/**
 * POST /bookings/fleet/plan-vehicle -- "Edit slot" for ONE vehicle.
 *
 * The rest of the plan goes with it so the server can place this vehicle
 * around its own group as well as around everyone else's bookings.
 */
export async function planFleetVehicle(input: {
  stationId: string;
  fuelType: string;
  bookingDate: string;
  vehicles: FleetPlanVehicle[];
  vehiclePlate: string;
  timeSlot: string;
}): Promise<FleetPlanVehicle> {
  const { data } = await apiClient.post<FleetPlanVehicle>("/bookings/fleet/plan-vehicle", input);
  return data;
}

/**
 * POST /bookings/fleet -- confirm.
 *
 * 207 (some booked, some not) is a SUCCESS as far as axios is concerned, and
 * that is right: the bookings that were made are real. The caller shows
 * `failures` beside them rather than treating the whole thing as an error.
 */
export async function confirmFleet(input: FleetRequest & { payMethod?: string }): Promise<FleetConfirmation> {
  const { data } = await apiClient.post<FleetConfirmation>("/bookings/fleet", input);
  return data;
}

/** GET /bookings/fleet -- the customer's own groups, newest first. */
export async function fetchFleetBookings(): Promise<FleetGroup[]> {
  const { data } = await apiClient.get<{ groups: FleetGroup[] }>("/bookings/fleet");
  return data.groups ?? [];
}

/** GET /bookings/fleet/:id -- one group, with live queue figures per vehicle. */
export async function fetchFleetBooking(fleetId: string): Promise<FleetGroup> {
  const { data } = await apiClient.get<FleetGroup>(`/bookings/fleet/${fleetId}`);
  return data;
}
