import { apiClient } from "./apiClient";

/**
 * Commission and settlement, from the server.
 *
 * Nothing here works out what anyone owes. The rate, the split per booking,
 * the day's total and whether a transfer has actually been confirmed are all
 * the backend's answers (backend services/commission/commissionService.js).
 * A commission figure computed in the browser would be a second opinion about
 * money, which is the one thing a UI must never have.
 */

/** One booking's commission, as the dashboards list it. */
export interface CommissionEntry {
  id: string;
  bookingRef: string | null;
  bookingId: string | null;
  fuelType: string | null;
  date: string;
  /** What the customer actually paid. */
  gross: number;
  commission: number;
  /** The vendor's share of the same sale — already theirs, paid at the pump. */
  vendorPayable: number;
  rate: number;
  status: "pending" | "settled" | "failed" | "refunded";
  settlementRef: string | null;
  settledAt: string | null;
  at: string;
  note: string | null;
}

/** One day's transfer from a vendor to FuelMart. */
export interface Settlement {
  id: string;
  reference: string;
  date: string;
  amount: number;
  entryCount: number;
  /**
   * `awaiting_confirmation` is not a failure: it means the settlement was
   * raised and nothing has confirmed the money moved yet. Only `settled`
   * means it did.
   */
  status: "awaiting_confirmation" | "settled" | "failed";
  mode: "manual" | "gateway";
  transferRef: string | null;
  attempts: number;
  error: string | null;
  confirmedAt: string | null;
  at: string;
  vendor: { id: string; name?: string | null; businessName?: string | null } | null;
}

export interface VendorCommission {
  success: boolean;
  /** The percentage of fuel value taken, as configured on the server. */
  rate: number;
  settlementTime: string;
  minSettlement: number;
  earned: number;
  pending: number;
  pendingCount: number;
  settled: number;
  settledCount: number;
  vendorPayable: number;
  today: { day: string; gross: number; commission: number; vendorPayable: number; bookings: number };
}

export interface AdminCommission {
  success: boolean;
  rate: number;
  settlementTime: string;
  payoutMode: "manual" | "gateway";
  earned: number;
  pending: number;
  settled: number;
  refunded: number;
  awaitingConfirmation: { amount: number; count: number };
  failed: { amount: number; count: number };
}

/* ───────────────────────────── vendor ───────────────────────────── */

export async function fetchVendorCommission(): Promise<VendorCommission> {
  const { data } = await apiClient.get<VendorCommission>("/v1/commission/vendor");
  return data;
}

export async function fetchVendorCommissionEntries(params: { limit?: number; skip?: number; status?: string } = {}) {
  const { data } = await apiClient.get<{ entries: CommissionEntry[]; total: number }>("/v1/commission/vendor/entries", {
    params,
  });
  return { entries: data.entries ?? [], total: data.total ?? 0 };
}

export async function fetchVendorSettlements(params: { limit?: number; skip?: number } = {}) {
  const { data } = await apiClient.get<{ settlements: Settlement[]; total: number }>(
    "/v1/commission/vendor/settlements",
    { params },
  );
  return { settlements: data.settlements ?? [], total: data.total ?? 0 };
}

/* ───────────────────────────── admin ───────────────────────────── */

export async function fetchAdminCommission(): Promise<AdminCommission> {
  const { data } = await apiClient.get<AdminCommission>("/v1/commission/admin");
  return data;
}

export async function fetchAdminSettlements(params: { limit?: number; skip?: number; status?: string } = {}) {
  const { data } = await apiClient.get<{ settlements: Settlement[]; total: number }>("/v1/commission/admin/settlements", {
    params,
  });
  return { settlements: data.settlements ?? [], total: data.total ?? 0 };
}

/**
 * Record that a settlement's money actually arrived.
 *
 * The only thing that turns "awaiting confirmation" into "settled" when there
 * is no payout gateway — a person saying the transfer happened.
 */
export async function confirmSettlement(id: string, transferRef?: string) {
  const { data } = await apiClient.post<{ settlement: Settlement; alreadySettled: boolean; msg: string }>(
    `/v1/commission/admin/settlements/${encodeURIComponent(id)}/confirm`,
    { transferRef: transferRef || undefined },
  );
  return data;
}

/** Settle a day now rather than waiting for the scheduled time. */
export async function runSettlement(day?: string) {
  const { data } = await apiClient.post<{ day: string; vendors: number; raised: number; settled: number; failed: number; skipped: number; amount: number }>(
    "/v1/commission/admin/run",
    day ? { day } : {},
  );
  return data;
}
