import { apiClient } from "./apiClient";

/**
 * Walk-in vehicles at a station's fuel nozzles -- backend
 * routes/vendorPanelRoutes.js /stations/:id/walk-ins (services/queue/walkIns.js).
 * Recording one puts it in that fuel's live queue for every customer.
 */

const BASE = "/vendor-panel";

export interface VendorWalkIn {
  _id: string;
  station: string;
  fuelType: string;
  quantity: number;
  vehicleNumber: string | null;
  status: "waiting" | "serving" | "completed" | "cancelled";
  arrivalTime: string;
  fuelingStartTime: string | null;
  completionTime: string | null;
  /** From the quantity, decided by the server (config/fuelDurations.js). */
  serviceDurationSeconds: number;
}

export async function fetchWalkIns(stationId: string): Promise<VendorWalkIn[]> {
  const { data } = await apiClient.get<VendorWalkIn[]>(`${BASE}/stations/${stationId}/walk-ins`);
  return Array.isArray(data) ? data : [];
}

export async function addWalkIn(
  stationId: string,
  input: { fuelType: string; quantity: number; vehicleNumber?: string | null },
): Promise<{ msg?: string; walkIn: VendorWalkIn }> {
  const { data } = await apiClient.post(`${BASE}/stations/${stationId}/walk-ins`, input);
  return data;
}

export async function updateWalkIn(
  stationId: string,
  walkInId: string,
  action: "complete" | "cancel",
): Promise<{ msg?: string; walkIn: VendorWalkIn }> {
  const { data } = await apiClient.patch(`${BASE}/stations/${stationId}/walk-ins/${walkInId}`, { action });
  return data;
}
