import { apiClient } from "./apiClient";
import type { Booking, Station } from "@/types";
import type { HistoryForecast } from "./adminApi";

/**
 * Vendor panel endpoints -- backend/routes/vendorPanelRoutes.js, unchanged.
 *
 * Every call is authenticated by the httpOnly session cookie the browser
 * sends itself (services/api/apiClient.ts), so no call here builds a header
 * object, and a 401/403 surfaces as a normal rejection instead of each
 * function checking res.status by hand.
 */

const BASE = "/vendor-panel";

/**
 * POST /api/vendors/register -- public vendor onboarding (backend/routes/vendorRoutes.js).
 * Multipart, same field names the Vanilla form sent; apiClient's 20 s timeout
 * replaces the old AbortController.
 */
export async function registerVendor(
  form: FormData,
): Promise<{ ok: true; msg?: string; vendorId?: string } | { ok: false; msg: string }> {
  try {
    const { data } = await apiClient.post<{ msg?: string; user?: { id?: string } }>(
      "/vendors/register",
      form,
    );
    return { ok: true, msg: data?.msg, vendorId: data?.user?.id };
  } catch (err) {
    const ax = err as { code?: string; response?: { status?: number; data?: { msg?: string } | string } };
    if (ax.code === "ECONNABORTED") return { ok: false, msg: "Request timed out. Please try again." };
    if (!ax.response) return { ok: false, msg: "Network error while submitting" };
    const d = ax.response.data;
    const msg = (typeof d === "string" ? d : d?.msg) || `Registration failed (HTTP ${ax.response.status})`;
    return { ok: false, msg };
  }
}

export interface VendorDashboard {
  /** Completed bookings whose payment was received today (backend services/payment/revenue.js). */
  todaysRevenue: number;
  todaysTransactions?: number;
  /** Fuelled at the pump, payment not recorded yet. Not revenue. */
  awaitingCollection?: { count: number; amount: number };
  revenueBasis?: string;
  /** Bookings scheduled for today at these stations. */
  todaysBookings: number;
  queueStatus: number;
  monthlySales: number;
  totalStations: number;
  totalBookings: number;
  activePumps: number;
  customersToday: number;
  fuelStock: { petrol: number; diesel: number; cng: number };
  /** Sum of recorded tank capacities; null where no station has recorded one. */
  fuelCapacity?: { petrol: number | null; diesel: number | null; cng: number | null };
  topSellingFuel?: string | null;
}

export type InventoryTier = "out_of_stock" | "critical" | "low" | "normal" | "capacity_unset";

/** One fuel's stock status, computed by backend/src/services/inventory/inventoryThreshold.js. */
export interface FuelInventoryStatus {
  current: number;
  capacity: number | null;
  unit: string;
  /** Promised to live bookings, not yet dispensed. */
  committed: number;
  /** current - committed: what can still be booked. */
  available: number;
  tier: InventoryTier;
  label: string;
  percent: number | null;
}

/** A fuel's nozzles: how many, and how many take app bookings (online); the rest serve walk-ins. */
export interface NozzleSetup {
  total: number;
  online: number;
}

/** One day's hours: open all day, closed, or open..close (HH:MM, India time). */
export interface DayHours {
  open: string;
  close: string;
  is24h: boolean;
  isClosed: boolean;
}

export type ScheduleDay = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
export type OperatingSchedule = Record<ScheduleDay, DayHours>;

export interface VendorStation extends Station {
  operatingSchedule?: Partial<OperatingSchedule>;
  nozzleConfig?: { petrol?: NozzleSetup; diesel?: NozzleSetup; cng?: NozzleSetup };
  inventory?: { petrol: number; diesel: number; cng: number };
  tankCapacity?: { petrol: number | null; diesel: number | null; cng: number | null };
  /** Only fuels the station sells appear here. */
  inventoryStatus?: Partial<Record<"petrol" | "diesel" | "cng", FuelInventoryStatus>>;
  openingHours?: string;
}

/**
 * GET /vendor-panel/revenue -- completed bookings whose payment was received
 * (backend services/payment/revenue.js). Week = last 7 days including today.
 */
export interface VendorRevenue {
  todaysRevenue: number;
  weeklyRevenue: number;
  monthlyRevenue: number;
  allTimeRevenue: number;
  transactions: { today: number; week: number; month: number; allTime: number };
  /** This month's revenue split into fuel (price x quantity) and convenience fees. */
  monthBreakdown: { fuelValue: number; fees: number; quantity: number };
  /** Revenue transactions this month. */
  totalBookings: number;
  fuelSales: Record<string, { quantity: number; revenue: number; transactions?: number }>;
  awaitingCollection: { count: number; amount: number };
  basis: string;
  asOf: string;
}

export interface VendorEmployee {
  _id: string;
  name: string;
  phone?: string;
  email?: string;
  role?: string;
  shift?: string;
  salary?: number;
  station?: { _id: string; name: string } | null;
}

export interface VendorReview {
  name?: string;
  stationName?: string;
  rating?: number;
  comment?: string;
  date?: string;
}

export interface VendorCustomer {
  user?: { name?: string; email?: string; phone?: string };
  totalBookings?: number;
  totalSpent?: number;
  lastVisit?: string;
}

/** GET /vendor-panel/stations/:id/forecast -- backend services/algorithms/forecast.js forecastFromHistory. */
export interface VendorForecast {
  fuel: string;
  unit: string;
  history: {
    months: Array<{ month: string; quantity: number; bookings: number; complete: boolean }>;
    current: { month: string; daysElapsed: number; daysInMonth: number };
    firstSaleAt: string | null;
    lastSaleAt: string | null;
    daysObserved: number;
    saleDays: number;
    totalQuantity: number;
    totalBookings: number;
    nonCustomerBookings: number;
    /** "customer-sales": bookings by vendor/admin accounts are not demand. */
    basis?: "customer-sales" | "all-sales";
    excludedBookings?: number;
  };
  stock: { current: number; available: number };
  forecast: HistoryForecast;
  dailyHistory?: {
    completeDays: number;
    windowDays: number;
    firstSaleDate: string | null;
    basis: "customer-sales" | "all-sales";
    excludedBookings: number;
  };
  reorder: ReorderPlan;
  reorderReason: string | null;
  /** The lead time the plan used and why (backend services/inventory/leadTime.js). */
  leadTime?: {
    usedDays: number;
    sdDays: number;
    basis: LeadTimeBasis;
    measured: {
      ready: boolean;
      samples: number;
      requiredSamples: number;
      windowDays: number;
      medianDays: number | null;
      meanDays: number | null;
      sdDays: number | null;
      deliveries: number;
      deliveriesWithoutOrderDate: number;
      deliveryIntervalMedianDays: number | null;
      lastDeliveryAt: string | null;
    };
  };
}

/** entered: given for this calculation; measured: from recorded order dates; assumed: a default. */
export type LeadTimeBasis = "entered" | "measured" | "assumed";

/**
 * Reorder point from measured daily demand variation (backend
 * services/algorithms/forecast.js reorderPlan). `ready: false` until enough complete
 * days exist; the numeric fields are present only when ready.
 */
export interface ReorderPlan {
  ready: boolean;
  sampleDays: number;
  requiredDays: number;
  serviceLevel: number;
  leadTimeDays: number;
  leadTimeSdDays?: number;
  leadTimeBasis?: LeadTimeBasis | null;
  reason?: string;
  z?: number;
  dailyDemand?: number;
  dailyStdDev?: number;
  variability?: number;
  leadTimeDemand?: number;
  safetyStock?: number;
  reorderPoint?: number;
  cycleDemand?: number;
  cycleBasis?: "forecast" | "daily-average";
  periodDays?: number;
  available?: number;
  shouldReorder?: boolean;
  suggestedQty?: number;
  daysOfCover?: number;
}

export const SERVICE_LEVELS = [90, 95, 98, 99] as const;

/** leadTimeDays null = let the server use the measured lead time (or its labelled default). */
export async function fetchVendorForecast(
  stationId: string,
  fuel: string,
  leadTimeDays: number | null = null,
  serviceLevel = 95,
): Promise<VendorForecast> {
  const { data } = await apiClient.get<VendorForecast>(`${BASE}/stations/${stationId}/forecast`, {
    params: { fuel, serviceLevel, ...(leadTimeDays === null ? {} : { leadTimeDays }) },
  });
  return data;
}

export interface VendorReports {
  totalRevenue: number;
  totalBookings: number;
  /** Completed-sale revenue by India month, from the first sale; `complete: false` = the running month. */
  monthlyData: Array<{ month: string; revenue: number; bookings: number; complete?: boolean }>;
  stationPerformance: Array<{
    stationName: string;
    totalBookings: number;
    completedTransactions?: number;
    revenue: number;
    rating?: number;
  }>;
}

export interface VendorProfile {
  name?: string;
  email?: string;
  phone?: string;
  businessName?: string;
  gstNumber?: string;
  vendorAddress?: string;
  vendorDescription?: string;
  vendorStatus?: string;
  /** Public /uploads/vendors path, or null when no photo has been uploaded. */
  profileImage?: string | null;
  /** Signature printed on invoices, or null. */
  signatureImage?: string | null;
  /** Fuel keys chosen at registration; absent for older vendors. */
  vendorFuelTypes?: Array<"petrol" | "diesel" | "cng">;
}

export interface PriceHistoryEntry {
  _id: string;
  fuelType: string;
  oldPrice: number;
  newPrice: number;
  effectiveDate: string;
  note?: string;
}

export interface InventoryAlert {
  station: string;
  stationId?: string;
  fuelType: string;
  unit?: string;
  current: number;
  committed?: number;
  available?: number;
  capacity?: number | null;
  percent?: number | null;
  tier?: InventoryTier;
  label?: string;
}

/** One row of GET /vendor-panel/stations/:id/inventory/movements. */
export interface InventoryMovement {
  id: string;
  fuel: "petrol" | "diesel" | "cng";
  type: "delivery" | "stock_count" | "sale" | "capacity_change";
  quantity: number | null;
  stockAfter: number | null;
  capacityAfter: number | null;
  unit: string | null;
  note: string | null;
  recordedBy: string | null;
  orderId: string | null;
  /** Deliveries: the India date it was ordered, and the days until it arrived. */
  orderedOn?: string | null;
  leadTimeDays?: number | null;
  createdAt: string;
}

export async function fetchInventoryMovements(stationId: string, fuel?: string, limit = 20) {
  const { data } = await apiClient.get<InventoryMovement[]>(`${BASE}/stations/${stationId}/inventory/movements`, {
    params: { ...(fuel ? { fuel } : {}), limit },
  });
  return Array.isArray(data) ? data : [];
}

/** A booking as the vendor sees it -- the customer is populated. */
export interface VendorBooking extends Omit<Booking, "user"> {
  user?: { _id?: string; name?: string; phone?: string; email?: string } | string;
}

// ---------------------------------------------------------------- dashboard
export async function fetchVendorDashboard(): Promise<VendorDashboard> {
  const { data } = await apiClient.get<VendorDashboard>(`${BASE}/dashboard`);
  return data;
}

// ----------------------------------------------------------------- stations
export async function fetchVendorStations(): Promise<VendorStation[]> {
  const { data } = await apiClient.get<VendorStation[]>(`${BASE}/stations`);
  return Array.isArray(data) ? data : [];
}

export interface CreateStationInput {
  name: string;
  address: string;
  /** Prices for the fuels this station sells only. */
  prices: Partial<Record<"petrol" | "diesel" | "cng", number>>;
  /** Labels ("Petrol", "CNG"); must be fuels the vendor registered for. */
  fuelTypes?: string[];
  openingHours: string;
  /** The pump's exact position, pinned on the map. Saved as GeoJSON `location` by the server. */
  coordinates?: { lat: number; lng: number };
}

export async function createVendorStation(input: CreateStationInput) {
  const { data } = await apiClient.post(`${BASE}/stations`, input);
  return data;
}

/**
 * PUT /vendor-panel/stations/:id/pump-images -- add or replace the petrol
 * and/or CNG pump photo. A photo not given is left unchanged on the server.
 */
export async function updateVendorPumpImages(id: string, files: { petrol?: File | null; cng?: File | null }) {
  const body = new FormData();
  if (files.petrol) body.append("petrolImage", files.petrol);
  if (files.cng) body.append("cngImage", files.cng);
  const { data } = await apiClient.put<{ msg?: string; pumpImages?: { petrol?: string | null; cng?: string | null } }>(
    `${BASE}/stations/${id}/pump-images`,
    body,
  );
  return data;
}

export interface UpdateStationInput {
  name?: string;
  address?: string;
  openingHours?: string;
  /** Labels ("Petrol", "CNG"); must be fuels the vendor registered for. */
  fuelTypes?: string[];
  coordinates?: { lat: number; lng: number };
  /** The station's updatedAt when the form opened; the server refuses (409) if it changed since. */
  expectedUpdatedAt?: string;
}

/** PUT /vendor-panel/stations/:id -- edit a station's details and location. */
export async function updateVendorStation(id: string, input: UpdateStationInput) {
  const { data } = await apiClient.put<VendorStation>(`${BASE}/stations/${id}`, input);
  return data;
}

/**
 * POST /bookings/verify -- check a customer in at the pump with their 4-digit
 * code. The server starts fueling (or queues the car if the nozzle is busy)
 * and completes the booking by itself when the fuel's time is up.
 */
export async function checkInWithCode(verificationCode: string) {
  const { data } = await apiClient.post<{
    msg?: string;
    started?: boolean;
    queued?: boolean;
    completesAt?: string | null;
    booking?: {
      _id?: string;
      station?: string | { _id?: string };
      orderId?: string;
      status?: string;
      amount?: number;
      payMethod?: string;
      paymentStatus?: string;
    };
  }>("/bookings/verify", { verificationCode });
  return data;
}

/** PATCH /vendor-panel/stations/:id/nozzles -- e.g. { petrol: { total: 4, online: 1 } }. */
export async function updateNozzleConfig(id: string, setup: Partial<Record<"petrol" | "diesel" | "cng", NozzleSetup>>) {
  const { data } = await apiClient.patch<{ msg?: string; nozzleConfig?: Record<string, NozzleSetup> }>(`${BASE}/stations/${id}/nozzles`, setup);
  return data;
}

/** PATCH /vendor-panel/stations/:id/schedule -- all seven days; the booking slots follow them. */
export async function updateStationSchedule(id: string, schedule: OperatingSchedule) {
  const { data } = await apiClient.patch<{ msg?: string; openingHours?: string; outsideHours?: number }>(
    `${BASE}/stations/${id}/schedule`,
    schedule,
  );
  return data;
}

export async function toggleVendorStationStatus(id: string) {
  const { data } = await apiClient.patch<{ msg?: string }>(`${BASE}/stations/${id}/toggle-status`);
  return data;
}

export async function deleteVendorStation(id: string) {
  const { data } = await apiClient.delete<{ msg?: string }>(`${BASE}/stations/${id}`);
  return data;
}

// -------------------------------------------------------------------- price
export async function fetchPriceHistory(id: string): Promise<PriceHistoryEntry[]> {
  const { data } = await apiClient.get<PriceHistoryEntry[]>(`${BASE}/stations/${id}/price-history`);
  return Array.isArray(data) ? data : [];
}

export async function updateFuelPrice(id: string, fuelType: string, newPrice: number) {
  const { data } = await apiClient.put<{ msg?: string }>(`${BASE}/stations/${id}/price`, {
    fuelType,
    newPrice,
  });
  return data;
}

// ----------------------------------------------------------------- bookings
export async function fetchStationBookings(id: string): Promise<VendorBooking[]> {
  const { data } = await apiClient.get<VendorBooking[]>(`${BASE}/stations/${id}/bookings`);
  return Array.isArray(data) ? data : [];
}

export async function updateVendorBookingStatus(
  stationId: string,
  bookingId: string,
  status: string,
  options: { collectPayment?: boolean } = {},
) {
  // waitingForNozzle: "serving" was asked while another car is at the nozzle;
  // the car is checked in and starts automatically when it is released.
  // Completing does not record payment unless collectPayment is sent.
  const { data } = await apiClient.patch<{ msg?: string; waitingForNozzle?: boolean }>(
    `${BASE}/stations/${stationId}/bookings/${bookingId}/status`,
    { status, ...options },
  );
  return data;
}

/**
 * PATCH /vendor-panel/stations/:stationId/bookings/:bookingId/collect -- the
 * attendant received a pay-at-the-pump payment. Recorded once on the server;
 * a repeat answers alreadyPaid.
 */
export async function collectVendorBookingPayment(stationId: string, bookingId: string, method: "cash" | "upi") {
  const { data } = await apiClient.patch<{ msg?: string; alreadyPaid?: boolean; booking?: VendorBooking }>(
    `${BASE}/stations/${stationId}/bookings/${bookingId}/collect`,
    { method },
  );
  return data;
}

// ---------------------------------------------------------------- inventory
/**
 * Add delivered stock and/or record the tank's real capacity. The server
 * refuses stock beyond a recorded capacity (409 EXCEEDS_CAPACITY).
 */
export async function updateInventory(
  stationId: string,
  fuelType: string,
  change: { quantity?: number; capacity?: number; note?: string; orderedOn?: string },
) {
  const { data } = await apiClient.put<{ msg?: string; warning?: string | null }>(`${BASE}/stations/${stationId}/inventory`, {
    fuelType,
    ...change,
    action: "add",
  });
  return data;
}

export async function fetchInventoryAlerts(): Promise<InventoryAlert[]> {
  const { data } = await apiClient.get<InventoryAlert[]>(`${BASE}/inventory/alerts`);
  return Array.isArray(data) ? data : [];
}

// ------------------------------------------------------- revenue & reports
export async function fetchVendorRevenue(): Promise<VendorRevenue> {
  const { data } = await apiClient.get<VendorRevenue>(`${BASE}/revenue`);
  return data;
}

export async function fetchVendorReports(): Promise<VendorReports> {
  const { data } = await apiClient.get<VendorReports>(`${BASE}/reports`);
  return data;
}

// ---------------------------------------------------------------- employees
export async function fetchVendorEmployees(): Promise<VendorEmployee[]> {
  const { data } = await apiClient.get<VendorEmployee[]>(`${BASE}/employees`);
  return Array.isArray(data) ? data : [];
}

export interface AddEmployeeInput {
  name: string;
  phone: string;
  email?: string;
  role: string;
  shift: string;
  salary: number;
  station?: string;
}

export async function addVendorEmployee(input: AddEmployeeInput) {
  const { data } = await apiClient.post<{ msg?: string }>(`${BASE}/employees`, input);
  return data;
}

export async function deleteVendorEmployee(id: string) {
  const { data } = await apiClient.delete<{ msg?: string }>(`${BASE}/employees/${id}`);
  return data;
}

// ---------------------------------------------------- reviews & customers
export async function fetchVendorReviews(): Promise<VendorReview[]> {
  const { data } = await apiClient.get<VendorReview[]>(`${BASE}/reviews`);
  return Array.isArray(data) ? data : [];
}

export async function fetchVendorCustomers(): Promise<VendorCustomer[]> {
  const { data } = await apiClient.get<VendorCustomer[]>(`${BASE}/customers`);
  return Array.isArray(data) ? data : [];
}

// ------------------------------------------------------------------ profile
export async function fetchVendorProfile(): Promise<VendorProfile> {
  const { data } = await apiClient.get<VendorProfile>(`${BASE}/profile`);
  return data;
}

export async function updateVendorProfile(input: Partial<VendorProfile>) {
  const { data } = await apiClient.put<{ msg?: string }>(`${BASE}/profile`, input);
  return data;
}

/**
 * PUT /vendor-panel/profile with only a photo (multer field "vendorImage").
 * The server stores it through middleware/upload.js and deletes the old one;
 * the other profile fields are left as they are.
 */
export async function uploadVendorProfilePhoto(file: File) {
  const body = new FormData();
  body.append("vendorImage", file);
  const { data } = await apiClient.put<{ msg?: string; user?: VendorProfile }>(`${BASE}/profile`, body);
  return data;
}

/** PUT /vendor-panel/profile/signature (multer field "signatureImage"). */
export async function uploadVendorSignature(file: File) {
  const body = new FormData();
  body.append("signatureImage", file);
  const { data } = await apiClient.put<{ msg?: string; signatureImage?: string | null }>(`${BASE}/profile/signature`, body);
  return data;
}

// ------------------------------------------- vendor application / activation
export interface VendorApplication {
  vendorStatus?: string;
  activated?: boolean;
  name?: string;
  email?: string;
  businessName?: string;
  submittedAt?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  msg?: string;
  error?: string;
}

/** Public: an applicant checks their own status without being signed in. */
export async function fetchVendorApplication(id: string): Promise<VendorApplication> {
  const { data } = await apiClient.get<VendorApplication>(`/activation/vendors/${id}/status`);
  return data;
}

export async function activateVendor(id: string, code: string) {
  const { data } = await apiClient.post<{ msg?: string; token?: string }>(
    `/activation/vendors/${id}/activate`,
    { code },
  );
  return data;
}

/**
 * Redeem the emailed secret code. Unauthenticated by design -- the vendor is
 * usually reading the mail signed out, and the code is the only credential
 * they have. See backend/routes/vendorAccessRoutes.js for the rate limits
 * this endpoint carries because of that.
 */
export async function redeemVendorSecretCode(email: string, code: string) {
  const { data } = await apiClient.post<{ msg?: string; user?: unknown }>(
    "/vendor-access/verify",
    { email, code },
  );
  return data;
}

/** GET /api/vendor-access/session -- who the current vendor token belongs to. */
export async function fetchVendorSession() {
  const { data } = await apiClient.get<{ user?: VendorProfile & { _id?: string } }>(
    "/vendor-access/session",
  );
  return data;
}
