import { describe, it, expect } from "vitest";
import { canonicalFuel } from "./vendorFuels";

describe("canonicalFuel", () => {
  it("settles every spelling a URL, an API row or a user can produce", () => {
    expect(canonicalFuel("CNG")).toBe("CNG");
    // The bug this exists for: title-casing by hand gave "Cng", which matched
    // no key in uiPrices and showed a priced station as unpriced.
    expect(canonicalFuel("Cng")).toBe("CNG");
    expect(canonicalFuel("cng")).toBe("CNG");
    expect(canonicalFuel(" PETROL ")).toBe("Petrol");
    expect(canonicalFuel("diesel")).toBe("Diesel");
  });

  it("returns null for anything that is not a fuel we sell", () => {
    expect(canonicalFuel("EV Charging")).toBeNull();
    expect(canonicalFuel("")).toBeNull();
    expect(canonicalFuel(null)).toBeNull();
  });
});
