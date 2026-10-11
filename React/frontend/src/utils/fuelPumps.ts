import type { UiStation } from "@/types";

export type FuelKey = "Petrol" | "Diesel" | "CNG";

/**
 * Can a customer fill this fuel here, right now?
 *
 * Three conditions, and all three matter: the station lists the fuel, it has
 * not marked it out of stock, and it has published a price (the server
 * refuses a booking for an unpriced fuel, so offering one is a dead end).
 *
 * One definition, used by the dashboard list and by the "nearest pump" card
 * above it -- when they each had their own, the card could name a pump the
 * list below it did not contain.
 */
export function sellsFuel(station: UiStation, fuel: FuelKey): boolean {
  const key = fuel.toLowerCase() as "petrol" | "diesel" | "cng";
  const lists = station.fuelTypes?.some((f) => f.toLowerCase() === key) ?? false;
  const inStock = station.fuelAvailability?.[key] !== false;
  const price = station.uiPrices?.[fuel];
  return lists && inStock && typeof price === "number" && price > 0;
}

/** The open pumps that can serve this fuel, in the order they were given. */
export function pumpsFor(fuel: FuelKey, stations: UiStation[]): UiStation[] {
  return stations.filter((s) => s.open && sellsFuel(s, fuel));
}
