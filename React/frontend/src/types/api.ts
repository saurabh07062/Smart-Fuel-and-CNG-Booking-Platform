/** Shapes returned by the existing Express API. Nothing here changes the
 *  contract -- these are descriptions of what the backend already sends. */

export type Role = "customer" | "vendor" | "admin";

export type VendorStatus =
  | "pending"
  | "under_review"
  | "active"
  | "suspended"
  | "rejected";

/** Booking.status enum, exactly as models/Booking.js declares it. */
export type BookingStatus =
  | "upcoming"
  | "serving"
  | "waitlisted"
  | "completed"
  | "cancelled"
  | "no_show"
  | "expired";

export type FuelKey = "petrol" | "diesel" | "cng";

export interface ApiError {
  msg: string;
  reason?: string;
  code?: string;
  field?: string;
  suggestion?: string | null;
}
