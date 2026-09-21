import { describe, expect, it } from "vitest";
import { distanceNote } from "./distanceNote";

describe("distanceNote", () => {
  it("says which distance is shown", () => {
    expect(distanceNote({ distanceType: "road" })).toBe("by road");
    expect(distanceNote({ distanceType: "fixed" })).toBe("by road (Google Maps)");
    expect(distanceNote({ distanceType: "straight" })).toBe("straight line");
    expect(distanceNote({})).toBeNull();
    expect(distanceNote(null)).toBeNull();
  });
});
