import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useLocationStore } from "@/store/locationStore";

vi.mock("@/components/layout/Layout", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/station/PumpCard", () => ({
  default: ({ station, isPrimary }: { station: { name: string; distance: number }; isPrimary?: boolean }) => (
    <div data-testid="pump" data-primary={isPrimary ? "yes" : "no"}>
      {station.name} {station.distance}
    </div>
  ),
}));

import NearestPump from "./NearestPump";

describe("Nearest pump results", () => {
  it("lists stations nearest first, whatever order the ranking returned", () => {
    useLocationStore.setState({
      result: {
        fuelType: "PETROL",
        stations: [
          { stationId: "a", name: "BALSKAR", distance: 1.32 },
          { stationId: "b", name: "Bharat", distance: 1.2 },
          { stationId: "c", name: "Far", distance: 4.8 },
          { stationId: "d", name: "Unknown", distance: null },
          { stationId: "e", name: "Close", distance: 0.4 },
        ],
      } as never,
    });
    render(
      <MemoryRouter>
        <NearestPump />
      </MemoryRouter>,
    );
    const cards = screen.getAllByTestId("pump");
    expect(cards.map((c) => c.textContent?.split(" ")[0])).toEqual(["Close", "Bharat", "BALSKAR", "Far", "Unknown"]);
    expect(cards[0].dataset.primary).toBe("yes");
  });
});
