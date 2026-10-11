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

/** The labels the API and UiStation.uiPrices use, keyed by the lower-case fuel. */
const FUEL_LABEL: Record<VendorFuel, "Petrol" | "Diesel" | "CNG"> = {
  petrol: "Petrol",
  diesel: "Diesel",
  cng: "CNG",
};

/**
 * Any spelling of a fuel -> the one label the rest of the app uses.
 *
 * "CNG" is the reason this exists: title-casing a fuel name by hand turns it
 * into "Cng", which then misses `uiPrices.CNG` and shows a priced station as
 * unpriced. Every place that takes a fuel from a URL, an API row or a user
 * goes through here instead of capitalising the first letter itself.
 */
export function canonicalFuel(value: string | null | undefined): "Petrol" | "Diesel" | "CNG" | null {
  const key = String(value ?? "").trim().toLowerCase();
  return (FUEL_LABEL as Record<string, "Petrol" | "Diesel" | "CNG">)[key] ?? null;
}
