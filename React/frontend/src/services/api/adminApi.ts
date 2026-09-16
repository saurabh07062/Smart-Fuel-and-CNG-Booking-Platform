import { apiClient } from "./apiClient";
import type { Station } from "@/types";

/**
 * Admin endpoints -- backend/routes/adminRoutes.js (mounted at both
 * /api/superadmin and /api/v1/admin), backend/routes/vendorRoutes.js
 * (/api/vendors, all adminAuth) and the admin-protected half of
 * backend/routes/stationRoutes.js. No contract changed.
 *
 * Every call is authenticated by the httpOnly session cookie the browser sends
 * itself (services/api/apiClient.ts), so a 401/403 surfaces as a normal
 * rejection instead of every call site re-checking res.status.
 */

export interface AdminOrder {
  bookingId: string;
  orderId: string;
  userName: string;
  userContact: string;
  stationName: string;
  bookingDate: string;
  timeSlot: string;
  startTime: string;
  endTime: string;
  vehiclePlate: string;
  fuelType: string;
  quantity: number;
  amount: number;
  paymentStatus?: string;
  payMethod?: string;
  status: string;
  createdAt?: string;
}

export interface AdminOrdersResponse {
  summary: {
    total?: number;
    today?: number;
    upcoming?: number;
    serving?: number;
    completed?: number;
    cancelled?: number;
    waitlisted?: number;
  };
  stations: Array<{
    stationId: string;
    stationName: string;
    address: string;
    bookings: AdminOrder[];
  }>;
  total: number;
}

export interface OrderFilters {
  date?: string;
  from?: string;
  to?: string;
  stationId?: string;
  status?: string;
  search?: string;
}

/** GET /api/v1/admin/orders -- every booking, grouped by station. */
export async function fetchAdminOrders(filters: OrderFilters = {}): Promise<AdminOrdersResponse> {
  // Only non-empty values are sent, matching the Vanilla URLSearchParams
  // build -- the backend treats an empty status differently from an absent
  // one (the empty string is not "all").
  const params = Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );
  const { data } = await apiClient.get<AdminOrdersResponse>("/v1/admin/orders", { params });
  return data;
}

/** PATCH /api/v1/admin/orders/:id/status -- also recomputes the station queue. */
export async function updateAdminOrderStatus(bookingId: string, status: string) {
  const { data } = await apiClient.patch<{ ok: boolean; status: string; msg?: string }>(
    `/v1/admin/orders/${bookingId}/status`,
    { status },
  );
  return data;
}

export interface SecurityEventRow {
  id: string;
  rule: string;
  reason: string;
  score: number;
  threshold: number;
  action: "blocked" | "flagged";
  route: string | null;
  user: { name?: string; email?: string } | null;
  station: { name?: string } | null;
  createdAt: string;
}

/** GET /api/v1/admin/security-events -- the risk engine report. */
export interface SecurityReport {
  total: number;
  last24h: { blocked: number; flagged: number };
  attempts24h: { total: number; byOutcome: Record<string, number> };
  /** Percent of the last 24 h's booking attempts that were blocked; null with no attempts. */
  blockRate24h: number | null;
  byRule7d: Array<{ rule: string; action: string; count: number }>;
  topUsers7d: Array<{
    userId: string;
    name: string | null;
    email: string | null;
    events: number;
    blocked: number;
    lastAt: string;
  }>;
  rules: {
    threshold: number;
    /** Hard per-account ceiling on booking requests, checked before scoring. */
    requestLimit?: { rule: string; perMinute: number };
    list: Array<{ rule: string; points: number; limit: number; windowMinutes: number }>;
  };
  events: SecurityEventRow[];
}

export async function fetchSecurityReport(
  params: { action?: "blocked" | "flagged"; rule?: string; limit?: number } = {},
): Promise<SecurityReport> {
  const query = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ""));
  const { data } = await apiClient.get<SecurityReport>("/v1/admin/security-events", { params: query });
  return data;
}

/**
 * A forecast gated on how much history exists (backend services/algorithms/forecast.js
 * forecastFromHistory). `ready: false` means there is not enough history for
 * a number; `errorPercent` is a typical error, lower is better.
 */
export interface HistoryForecast {
  ready: boolean;
  forMonth: string | null;
  value: number | null;
  method: string;
  errorPercent: number | null;
  reliability: "good" | "fair" | "poor" | "unmeasured";
  trend?: number;
  completeMonths: number;
  daysObserved: number;
  runRate?: { value: number; basis: string; daysObserved: number } | null;
  reason?: string;
  note?: string | null;
}

export interface SalesEvidence {
  firstSaleAt: string | null;
  lastSaleAt: string | null;
  daysObserved: number;
  saleDays: number;
  totalBookings: number;
  nonCustomerBookings: number;
  /** "customer-sales": the forecast counts out bookings by vendor/admin accounts. */
  basis?: "customer-sales" | "all-sales";
  excludedBookings?: number;
}

/** GET /api/v1/admin/analytics -- completed sales by fuel, top stations, revenue by month, and the gated forecast. */
export interface AdminAnalytics {
  months: number;
  byFuel: Array<{ fuelType: string; volume: number; revenue: number; bookings: number }>;
  topStations: Array<{ stationId: string; name: string; revenue: number; bookings: number }>;
  monthlyRevenue: Array<{ month: string; revenue: number; bookings: number; complete: boolean }>;
  forecast: HistoryForecast;
  history: SalesEvidence;
}

export async function fetchAdminAnalytics(months = 6): Promise<AdminAnalytics> {
  const { data } = await apiClient.get<AdminAnalytics>("/v1/admin/analytics", { params: { months } });
  return data;
}

/** One window of real revenue (backend services/payment/revenue.js). */
export interface RevenueWindow {
  revenue: number;
  fuelValue: number;
  fees: number;
  quantity: number;
  transactions: number;
}

export interface SuperAdminDashboard {
  stations: { total: number; active: number };
  vendors: { total: number; pending: number };
  customers: { total: number };
  bookings: Record<string, number>;
  /** Bookings scheduled today (India date), and by the hour their slot starts. */
  today?: {
    date: string;
    bookings: number;
    byHour: Array<{ hour: number; bookings: number; completed: number; cancelled: number }>;
  };
  /** Stock recorded at active stations; capacity null where no station recorded one. */
  fuelStock?: { petrol: number; diesel: number; cng: number };
  fuelCapacity?: { petrol: number | null; diesel: number | null; cng: number | null };
  /** The live line at active stations. avgWaitMinutes null with no stations. */
  liveQueue?: { stations: number; vehicles: number; avgWaitMinutes: number | null };
  revenue: {
    total: number;
    today?: RevenueWindow;
    week?: RevenueWindow;
    month?: RevenueWindow;
    allTime?: RevenueWindow;
    /** Fuelled at the pump, payment not recorded yet. Not revenue. */
    awaitingCollection?: { count: number; amount: number };
    basis?: string;
    asOf?: string;
    monthly: Array<{ month: string; revenue: number; bookings: number; complete?: boolean }>;
    forecastNextMonth: HistoryForecast;
    history?: SalesEvidence;
  };
}

/** GET /api/superadmin/dashboard. */
export async function fetchSuperAdminDashboard(): Promise<SuperAdminDashboard> {
  const { data } = await apiClient.get<SuperAdminDashboard>("/superadmin/dashboard");
  return data;
}

/** GET /api/stations -- public, but the admin station manager reads it too. */
export async function fetchAllStations(): Promise<Station[]> {
  const { data } = await apiClient.get<Station[]>("/stations");
  return Array.isArray(data) ? data : [];
}

export async function createStationAdmin(payload: Record<string, unknown>) {
  const { data } = await apiClient.post<{ msg?: string }>("/stations", payload);
  return data;
}

export async function updateStationAdmin(id: string, payload: Record<string, unknown>) {
  const { data } = await apiClient.put<{ msg?: string }>(`/stations/${id}`, payload);
  return data;
}

export async function deleteStationAdmin(id: string) {
  const { data } = await apiClient.delete<{ msg?: string }>(`/stations/${id}`);
  return data;
}

export async function toggleStationStatusAdmin(id: string) {
  const { data } = await apiClient.patch<{ msg?: string }>(`/stations/${id}/toggle-status`);
  return data;
}

/**
 * POST /api/bookings/verify -- the attendant QR / 4-digit CHECK-IN: the booking
 * moves to fueling (serving) and completes when its service time is up.
 *
 * Requires a signed-in admin or activated vendor (apiClient attaches the
 * token). A vendor only reaches bookings at their own stations, and a typed
 * code only matches today's live bookings. Takes EITHER a bookingId (from the
 * QR payload) or a verificationCode (typed).
 */
/**
 * POST /api/bookings/verify -- the check-in at the pump. `started`: fueling
 * began now and `completesAt` is when the nozzle is released. `queued`: the
 * nozzle is busy, the car waits and starts automatically at `nozzleFreeAt`
 * (backend services/queue/nozzleService.js).
 */
export interface VerifyBookingResponse {
  msg?: string;
  booking?: unknown;
  started?: boolean;
  queued?: boolean;
  completesAt?: string | null;
  nozzleFreeAt?: string | null;
}

export async function verifyBooking(input: { bookingId?: string; verificationCode?: string }) {
  const { data } = await apiClient.post<VerifyBookingResponse>(
    "/bookings/verify",
    input,
  );
  return data;
}

export interface VendorMgmtStats {
  totalVendors: number;
  activeVendors: number;
  pendingApprovals: number;
  suspendedVendors: number;
  rejectedVendors: number;
  totalStations: number;
  totalBookings: number;
  totalVendorRevenue: number;
  monthlyEarnings?: Array<{ month: string; revenue: number }>;
  topPerformingVendors?: Array<{
    vendorName?: string;
    businessName?: string;
    stationName?: string;
    revenue: number;
    bookings?: number;
  }>;
  recentRegistrations?: ManagedVendor[];
}

export interface ManagedVendor {
  _id: string;
  name?: string;
  email?: string;
  phone?: string;
  businessName?: string;
  gstNumber?: string;
  vendorAddress?: string;
  vendorDescription?: string;
  vendorCode?: string;
  vendorStatus?: string;
  activated?: boolean;
  createdAt?: string;
  stationCount?: number;
  totalRevenue?: number;
  /** Present for pending / under_review applications only. */
  completenessScore?: number;
  priorityScore?: number;
  daysWaiting?: number;
  rejectionReason?: string;
}

export interface VendorDetail extends ManagedVendor {
  stations?: Array<Station & { _id: string }>;
  bookings?: Array<Record<string, unknown>>;
}

export async function fetchVendorMgmtStats(): Promise<VendorMgmtStats> {
  const { data } = await apiClient.get<VendorMgmtStats>("/vendors/dashboard");
  return data;
}

export async function fetchManagedVendors(): Promise<ManagedVendor[]> {
  const { data } = await apiClient.get<ManagedVendor[]>("/vendors/");
  return Array.isArray(data) ? data : [];
}

/** The envelope GET /api/vendors/:id actually returns. */
interface VendorDetailResponse {
  vendor: ManagedVendor;
  stations?: VendorDetail["stations"];
  bookings?: VendorDetail["bookings"];
  totalRevenue?: number;
  totalStations?: number;
  totalBookings?: number;
  completenessScore?: number;
  priorityScore?: number;
  daysWaiting?: number;
}

/**
 * GET /api/vendors/:id.
 *
 * The response is an ENVELOPE -- the vendor document sits under `vendor`,
 * with stations, bookings and the computed scores as siblings, not merged
 * into it. Flattening here means the detail view reads one object, the same
 * shape the list rows already use.
 */
export async function fetchVendorDetail(id: string): Promise<VendorDetail> {
  const { data } = await apiClient.get<VendorDetailResponse>(`/vendors/${id}`);
  return {
    ...data.vendor,
    stations: data.stations ?? [],
    bookings: data.bookings ?? [],
    // The scores live outside `vendor`, so a spread alone would drop them and
    // the "Application Readiness" line would read 0% for every applicant.
    totalRevenue: data.totalRevenue ?? data.vendor?.totalRevenue,
    stationCount: data.totalStations ?? data.vendor?.stationCount,
    completenessScore: data.completenessScore ?? data.vendor?.completenessScore,
    priorityScore: data.priorityScore ?? data.vendor?.priorityScore,
    daysWaiting: data.daysWaiting ?? data.vendor?.daysWaiting,
  };
}

export async function approveVendor(id: string) {
  const { data } = await apiClient.patch<{ msg?: string; secretCodeEmailed?: boolean }>(
    `/vendors/${id}/approve`,
  );
  return data;
}

/**
 * POST /api/vendors/:id/reissue-secret-code.
 *
 * The recovery path for a bounced approval email, an expired code, or five
 * wrong attempts. The code itself is never in the response and must never be
 * shown to an admin -- only the vendor inbox ever holds it. Reissuing also
 * revokes the previous code, so this is a revocation tool as much as a
 * recovery one.
 */
export async function reissueSecretCode(id: string) {
  const { data } = await apiClient.post<{ msg?: string }>(`/vendors/${id}/reissue-secret-code`);
  return data;
}

export async function markVendorUnderReview(id: string) {
  const { data } = await apiClient.patch<{ msg?: string }>(`/vendors/${id}/under-review`);
  return data;
}

export async function rejectVendor(id: string, reason: string) {
  const { data } = await apiClient.patch<{ msg?: string }>(`/vendors/${id}/reject`, { reason });
  return data;
}

export async function suspendVendor(id: string, reason: string) {
  const { data } = await apiClient.patch<{ msg?: string }>(`/vendors/${id}/suspend`, { reason });
  return data;
}

export async function reactivateVendor(id: string) {
  const { data } = await apiClient.patch<{ msg?: string }>(`/vendors/${id}/reactivate`);
  return data;
}

export async function deleteVendor(id: string) {
  const { data } = await apiClient.delete<{ msg?: string }>(`/vendors/${id}`);
  return data;
}
