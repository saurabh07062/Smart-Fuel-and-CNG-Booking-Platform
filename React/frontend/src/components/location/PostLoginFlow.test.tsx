import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * What happens between signing in and seeing pumps.
 *
 * The sequence the customer is promised: "Login successful", a pause, the
 * location ask, then "What do you want?". These tests hold the parts that
 * would quietly rot:
 *
 *   - the pause is real, and the customer can skip it rather than wait
 *   - a refused or failed fix lands on the typed-place search, not on a dead
 *     prompt
 *   - the stations shown come from the BACKEND for the real point; nothing
 *     here invents a station, a count or a coordinate
 *   - every answer -- allow, search, skip -- ends the flow, so it cannot nag
 */

// Only the device call is replaced; the rest of utils/geo (distances, the
// remembered point the location store seeds itself from) stays real.
vi.mock("@/utils/geo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/geo")>()),
  getFreshUserCoords: vi.fn(),
}));
vi.mock("@/services/api/stationApi", () => ({
  fetchNearbyStations: vi.fn(),
  searchPlaces: vi.fn(),
}));

import { getFreshUserCoords } from "@/utils/geo";
import { fetchNearbyStations, searchPlaces } from "@/services/api/stationApi";
import PostLoginFlow from "./PostLoginFlow";
import { useLocationStore } from "@/store/locationStore";
import { useAuthStore } from "@/store/authStore";

const onFuelChosen = vi.fn();
const onDone = vi.fn();

const renderFlow = () => render(<PostLoginFlow onFuelChosen={onFuelChosen} onDone={onDone} />);

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: "u1", name: "Asha Kulkarni", role: "customer" } as never, isAuthenticated: true });
  useLocationStore.setState({ coords: null, located: false, source: null, gpsFailed: false, signedInAt: Date.now() });
  vi.mocked(fetchNearbyStations).mockResolvedValue({ success: true, stations: [{ stationName: "Baner Fuels", distance: 1.2 }] } as never);
});

afterEach(() => vi.useRealTimers());

describe("login confirmation", () => {
  it("says the login worked, and counts down to the location ask", () => {
    renderFlow();
    expect(screen.getByText("Login successful")).toBeTruthy();
    expect(screen.getByText(/Welcome back, Asha/)).toBeTruthy();
    // A real wait, shown rather than hidden.
    expect(Number(screen.getByTestId("ask-countdown").textContent?.replace("s", ""))).toBeGreaterThan(10);
    expect(getFreshUserCoords).not.toHaveBeenCalled();
  });

  it("the customer need not wait: 'Share location now' asks immediately", async () => {
    const user = userEvent.setup();
    vi.mocked(getFreshUserCoords).mockResolvedValue({ lat: 18.58, lng: 73.97 } as never);
    renderFlow();

    await user.click(screen.getByRole("button", { name: /Share location now/ }));
    await waitFor(() => expect(getFreshUserCoords).toHaveBeenCalled());
  });

  it("'Skip for now' ends the flow without asking the device", async () => {
    const user = userEvent.setup();
    renderFlow();
    await user.click(screen.getByRole("button", { name: /Skip for now/ }));
    expect(getFreshUserCoords).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
    expect(useLocationStore.getState().gpsFailed).toBe(true);
  });
});

describe("the location, then the fuel", () => {
  it("a real fix is stored and the backend is asked what is nearby", async () => {
    const user = userEvent.setup();
    vi.mocked(getFreshUserCoords).mockResolvedValue({ lat: 18.5805, lng: 73.9753 } as never);
    renderFlow();

    await user.click(screen.getByRole("button", { name: /Share location now/ }));

    await waitFor(() => expect(screen.getByText("What do you want?")).toBeTruthy());
    // The point is the device's, and it is recorded as a measured fix.
    expect(useLocationStore.getState().coords).toEqual({ lat: 18.5805, lng: 73.9753 });
    expect(useLocationStore.getState().source).toBe("gps");
    // The station count is the server's answer for that point.
    expect(fetchNearbyStations).toHaveBeenCalledWith(18.5805, 73.9753, "PETROL");
    expect(screen.getByText(/1 station nearby/)).toBeTruthy();
  });

  it("choosing a fuel hands it to the dashboard and closes the flow", async () => {
    const user = userEvent.setup();
    vi.mocked(getFreshUserCoords).mockResolvedValue({ lat: 18.58, lng: 73.97 } as never);
    renderFlow();
    await user.click(screen.getByRole("button", { name: /Share location now/ }));
    await screen.findByText("What do you want?");

    await user.click(screen.getByTestId("choose-fuel-cng"));
    expect(onFuelChosen).toHaveBeenCalledWith("CNG");
    expect(useLocationStore.getState().fuelType).toBe("CNG");
    expect(onDone).toHaveBeenCalled();
  });

  it("an empty area is said to be empty, not shown as a count of nothing", async () => {
    const user = userEvent.setup();
    vi.mocked(getFreshUserCoords).mockResolvedValue({ lat: 18.58, lng: 73.97 } as never);
    vi.mocked(fetchNearbyStations).mockResolvedValue({ success: true, stations: [] } as never);
    renderFlow();

    await user.click(screen.getByRole("button", { name: /Share location now/ }));
    expect(await screen.findByText(/No station is listed around you yet/)).toBeTruthy();
  });

  it("a failed lookup still keeps the location and moves on", async () => {
    const user = userEvent.setup();
    vi.mocked(getFreshUserCoords).mockResolvedValue({ lat: 18.58, lng: 73.97 } as never);
    vi.mocked(fetchNearbyStations).mockRejectedValue(new Error("network"));
    renderFlow();

    await user.click(screen.getByRole("button", { name: /Share location now/ }));
    await screen.findByText("What do you want?");
    expect(useLocationStore.getState().coords).toEqual({ lat: 18.58, lng: 73.97 });
    expect(screen.getByText(/Choose a fuel and we will list the stations/)).toBeTruthy();
  });
});

describe("when the device will not say", () => {
  it("a refused or failed fix offers the typed search, with the reason", async () => {
    const user = userEvent.setup();
    vi.mocked(getFreshUserCoords).mockResolvedValue(null as never);
    renderFlow();

    await user.click(screen.getByRole("button", { name: /Share location now/ }));

    expect(await screen.findByText("Where are you?")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/could not get your location/i);
    expect(screen.getByTestId("place-search")).toBeTruthy();
    expect(useLocationStore.getState().gpsFailed).toBe(true);
  });

  it("a searched place becomes the location, and the backend is asked about it", async () => {
    const user = userEvent.setup();
    vi.mocked(searchPlaces).mockResolvedValue([
      { name: "Wagholi, Haveli", label: "Wagholi, Haveli, Pune, India", lat: 18.5805, lng: 73.9753, type: "suburb" },
    ]);
    renderFlow();

    await user.click(screen.getByRole("button", { name: /Enter it myself/ }));
    await user.type(screen.getByLabelText(/Search for your area/), "wagholi");

    const result = await screen.findByRole("button", { name: /Wagholi, Haveli/ });
    await user.click(result);

    await waitFor(() => expect(screen.getByText("What do you want?")).toBeTruthy());
    expect(useLocationStore.getState().coords).toEqual({ lat: 18.5805, lng: 73.9753 });
    // A typed place is a chosen point, not a measured one.
    expect(useLocationStore.getState().source).toBe("map");
    expect(fetchNearbyStations).toHaveBeenCalledWith(18.5805, 73.9753, "PETROL");
    expect(screen.getByText(/Looking around Wagholi, Haveli/)).toBeTruthy();
  });

  it("a search that matches nothing says so instead of pretending", async () => {
    const user = userEvent.setup();
    vi.mocked(searchPlaces).mockResolvedValue([]);
    renderFlow();

    await user.click(screen.getByRole("button", { name: /Enter it myself/ }));
    await user.type(screen.getByLabelText(/Search for your area/), "zzzzzz");

    expect(await screen.findByTestId("place-search-empty")).toBeTruthy();
    expect(screen.queryByText("What do you want?")).toBeNull();
  });

  it("a failed search is reported as a failure, not as 'no such place'", async () => {
    const user = userEvent.setup();
    vi.mocked(searchPlaces).mockRejectedValue({ response: { data: { msg: "Search is unavailable right now." } } });
    renderFlow();

    await user.click(screen.getByRole("button", { name: /Enter it myself/ }));
    await user.type(screen.getByLabelText(/Search for your area/), "baner");

    expect((await screen.findByRole("alert")).textContent).toContain("Search is unavailable right now.");
    expect(screen.queryByTestId("place-search-empty")).toBeNull();
  });
});
