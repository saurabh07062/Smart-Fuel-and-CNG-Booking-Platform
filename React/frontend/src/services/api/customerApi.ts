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

/**
 * Mark notifications read on the SERVER.
 *
 * Without an id, every unread one; with an id, just that one. The server
 * decides whose they are from the session, so no user id is sent.
 *
 * This has to be persisted rather than kept in the tab: the list is re-fetched
 * on every reconnect and the server's copy wins, so a read state that lives
 * only in memory is undone by the next resync and the same notifications
 * appear again.
 *
 * @returns the number changed, and the authoritative unread count after it.
 */
export async function markNotificationsRead(id?: string): Promise<{ updated: number; unread: number }> {
  const { data } = await apiClient.post<{ updated?: number; unread?: number }>(
    id ? `/customer/notifications/${encodeURIComponent(id)}/read` : "/customer/notifications/read",
  );
  return { updated: data?.updated ?? 0, unread: data?.unread ?? 0 };
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

/** POST /customer/profile/image (multipart field "profileImage") -- the new photo's path. */
export async function uploadProfileImage(file: File): Promise<string | null> {
  const fd = new FormData();
  fd.append("profileImage", file);
  const { data } = await apiClient.post<{ profileImage?: string | null }>("/customer/profile/image", fd, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data.profileImage ?? null;
}

/** DELETE /customer/profile/image -- back to the initials. */
export async function removeProfileImage(): Promise<void> {
  await apiClient.delete("/customer/profile/image");
}
