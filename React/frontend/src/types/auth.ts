import type { Role, VendorStatus } from "./api";

export interface Vehicle {
  _id?: string;
  vehicleType?: string;
  nickname?: string;
  registrationNumber?: string;
  brand?: string;
  model?: string;
  fuelType?: string;
  color?: string;
  /** Public path under /uploads, or null. See middleware/upload.js. */
  image?: string | null;
  isDefault?: boolean;
}

export interface User {
  id: string;
  _id?: string;
  name: string;
  email: string;
  role: Role;
  vendorStatus?: VendorStatus;
  vendorCode?: string | null;
  activated?: boolean;
  businessName?: string | null;
  /** Vendors: fuel keys chosen at registration. Absent for older vendors (they sell every fuel). */
  vendorFuelTypes?: Array<"petrol" | "diesel" | "cng">;
  wallet?: number;
  rewards?: number;
  vehicles?: Vehicle[];
  profileImage?: string | null;
}

/** Login / registration. The session itself arrives as httpOnly cookies, never in the body. */
export interface LoginResponse {
  user: User;
}
