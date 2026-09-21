import { describe, expect, it, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import FuelSelection from "./FuelSelection";
import { useLocationStore } from "@/store/locationStore";

const view = () =>
  render(
    <MemoryRouter>
      <FuelSelection />
    </MemoryRouter>,
  );

beforeEach(() => {
  useLocationStore.setState({ coords: null, located: false, gpsFailed: false, fuelType: null, searching: false });
});

describe("Dashboard fuel question", () => {
  it("is not asked from a location remembered from an earlier visit", () => {
    useLocationStore.setState({ coords: { lat: 18.5721, lng: 73.9842 }, located: false });
    view();
    expect(screen.queryByText(/what do you need/i)).toBeNull();
  });

  it("is asked only after Use my location (GPS); a map click alone does not unlock it", () => {
    view();
    expect(screen.queryByText(/what do you need/i)).toBeNull();
    act(() => useLocationStore.getState().setCoords(18.5721, 73.9842, "map"));
    expect(screen.queryByText(/what do you need/i)).toBeNull();
    act(() => useLocationStore.getState().setCoords(18.5721, 73.9842, "gps"));
    expect(screen.getByText(/what do you need/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /petrol/i })).toBeTruthy();
  });

  it("after GPS, dragging the pin keeps the question", () => {
    view();
    act(() => useLocationStore.getState().setCoords(18.5721, 73.9842, "gps"));
    act(() => useLocationStore.getState().setCoords(18.5725, 73.9845, "map"));
    expect(screen.getByText(/what do you need/i)).toBeTruthy();
  });

  it("when the device cannot give a position, a map click is enough", () => {
    view();
    act(() => useLocationStore.getState().markGpsFailed());
    act(() => useLocationStore.getState().setCoords(18.5721, 73.9842, "map"));
    expect(screen.getByText(/what do you need/i)).toBeTruthy();
  });

  it("a new sign-in asks for the location again", () => {
    view();
    act(() => useLocationStore.getState().setCoords(18.5721, 73.9842, "gps"));
    expect(screen.getByText(/what do you need/i)).toBeTruthy();
    act(() => useLocationStore.getState().resetSession());
    expect(screen.queryByText(/what do you need/i)).toBeNull();
  });
});
