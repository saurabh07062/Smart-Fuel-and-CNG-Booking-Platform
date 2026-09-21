/**
 * The fuels a vendor sells (chosen at registration, backend
 * services/vendor/vendorFuels.js). The vendor panel shows only these.
 */
export type VendorFuel = "petrol" | "diesel" | "cng";

export const VENDOR_FUELS: Array<{ key: VendorFuel; label: string; unit: string }> = [
  { key: "petrol", label: "Petrol", unit: "L" },
  { key: "diesel", label: "Diesel", unit: "L" },
  { key: "cng", label: "CNG", unit: "Kg" },
];

export const FUEL_REQUIRED_MSG = "Select at least one fuel your station sells: Petrol, Diesel or CNG.";

/** Fuel keys from any list (registration choices, labels, "EV Charging"...), in the standard order. */
export function toVendorFuels(values: readonly string[] | null | undefined): VendorFuel[] {
  const chosen = new Set((values ?? []).map((v) => String(v).toLowerCase().trim()));
  return VENDOR_FUELS.map((f) => f.key).filter((k) => chosen.has(k));
}

/** What a vendor sells; a vendor registered before this was recorded sells every fuel. */
export function soldFuels(values: readonly string[] | null | undefined): VendorFuel[] {
  const fuels = toVendorFuels(values);
  return fuels.length ? fuels : VENDOR_FUELS.map((f) => f.key);
}
