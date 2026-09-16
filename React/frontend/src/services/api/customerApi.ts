import { apiClient } from "./apiClient";
import type { User, Vehicle } from "@/types";

/**
 * Customer endpoints -- backend/routes/customerRoutes.js. Contracts unchanged.
 *
 * Every vehicle mutation returns the FULL vehicles array (see
 * customerController.addVehicle / updateVehicle / deleteVehicle /
 * setDefaultVehicle), which is why the store replaces its list from the
 * response instead of patching one entry locally: the server also
 * re-assigns `isDefault` on its own (first vehicle added, or the default
 * being deleted), and a local patch would miss that.
 */

export async function fetchProfile(): Promise<User> {
  const { data } = await apiClient.get<{ user: User }>("/customer/profile");
  return data.user;
}

export interface NotificationItem {
  _id: string;
  type?: string;
  title?: string;
  /** The notification text, as stored (backend models/Notification.js). */
  body?: string;
  message?: string;
  read?: boolean;
  createdAt?: string;
}

export async function fetchNotifications(): Promise<NotificationItem[]> {
  const { data } = await apiClient.get<NotificationItem[]>("/customer/notifications");
  return Array.isArray(data) ? data : [];
}

interface VehiclesResponse {
  msg?: string;
  vehicles: Vehicle[];
}

/**
 * Build the request body for a vehicle create/update.
 *
 * multipart/form-data ONLY when there is a file, plain JSON otherwise --
 * the same split the Vanilla form used. The multer field name must stay
 * "vehicleImage" (routes/customerRoutes.js); anything else is silently
 * ignored by multer and the photo is dropped without an error.
 */
function vehicleBody(fields: Partial<Vehicle>, file?: File | null) {
  if (!file) return { body: fields, headers: undefined };

  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => {
    if (v !== undefined && v !== null) fd.append(k, String(v));
  });
  fd.append("vehicleImage", file);
  return { body: fd, headers: { "Content-Type": "multipart/form-data" } };
}

export async function addVehicle(fields: Partial<Vehicle>, file?: File | null): Promise<Vehicle[]> {
  const { body, headers } = vehicleBody(fields, file);
  const { data } = await apiClient.post<VehiclesResponse>("/customer/vehicles", body, { headers });
  return data.vehicles ?? [];
}

export async function updateVehicle(
  id: string,
  fields: Partial<Vehicle>,
  file?: File | null,
): Promise<Vehicle[]> {
  const { body, headers } = vehicleBody(fields, file);
  const { data } = await apiClient.put<VehiclesResponse>(`/customer/vehicles/${id}`, body, { headers });
  return data.vehicles ?? [];
}

export async function deleteVehicle(id: string): Promise<Vehicle[]> {
  const { data } = await apiClient.delete<VehiclesResponse>(`/customer/vehicles/${id}`);
  return data.vehicles ?? [];
}

export async function setDefaultVehicle(id: string): Promise<Vehicle[]> {
  const { data } = await apiClient.patch<VehiclesResponse>(`/customer/vehicles/${id}/default`);
  return data.vehicles ?? [];
}
