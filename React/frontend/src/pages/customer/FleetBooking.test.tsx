import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

/**
 * Phase 4 of fleet booking: the screen.
 *
 * What these check is that the page never decides anything the server owns,
 * and never hides an outcome from the customer:
 *
 *   - the suggested schedule shown is the one the server returned
 *   - editing one vehicle's slot asks the server about THAT vehicle and
 *     leaves the others where they were
 *   - a vehicle the server marked as a conflict is shown as one, with its
 *     reason, and is not sent on Confirm
 *   - a partial confirmation shows both halves: what was booked, and what was
 *     not, with the reason
 *   - the same vehicle cannot be added twice
 */

vi.mock("@/services/api/fleetApi", () => ({
  planFleet: vi.fn(),
  planFleetVehicle: vi.fn(),
  confirmFleet: vi.fn(),
  fetchFleetBookings: vi.fn(async () => []),
  fetchFleetBooking: vi.fn(),
}));
vi.mock("@/hooks/useSocket", () => ({
  useSocketEvent: () => {},
  useResync: () => {},
  useWatchStation: () => {},
  useWatchStations: () => {},
}));
vi.mock("@/hooks/useLiveQueueInfo", () => ({ useLiveQueueInfo: () => {} }));
vi.mock("@/hooks/useChatRealtime", () => ({ useChatRealtime: () => {} }));
vi.mock("@/components/chat/ChatWidget", () => ({ default: () => null }));

import * as api from "@/services/api/fleetApi";
import type { FleetPlan } from "@/services/api/fleetApi";
import FleetBooking from "./FleetBooking";
import { useFleetStore } from "@/store/fleetStore";
import { useAuthStore } from "@/store/authStore";
import { useStationStore } from "@/store/stationStore";

const STATION = { id: "st1", _id: "st1", name: "Baner Fuels", fuelTypes: ["Petrol", "Diesel"] };

const plan = (over: Partial<FleetPlan> = {}): FleetPlan => ({
  station: { stationId: "st1", name: "Baner Fuels", nozzles: 1 },
  fuelType: "Petrol",
  unit: "L",
  bookingDate: "2099-01-05",
  preferredSlot: "10:00 AM",
  generatedAt: new Date().toISOString(),
  vehicles: [
    {
      index: 1,
      vehiclePlate: "MH12AB0001",
      quantity: 20,
      state: "suggested",
      timeSlot: "10:00 AM",
      startTime: "10:00",
      endTime: "10:30",
      startsAt: new Date().toISOString(),
      endsAt: new Date().toISOString(),
      resource: 1,
      pricePerUnit: 100,
      amount: 2005,
    },
    {
      index: 2,
      vehiclePlate: "MH12AB0002",
      quantity: 20,
      state: "suggested",
      timeSlot: "10:30 AM",
      startTime: "10:30",
      endTime: "11:00",
      startsAt: new Date().toISOString(),
      endsAt: new Date().toISOString(),
      resource: 1,
      pricePerUnit: 100,
      amount: 2005,
    },
  ],
  totals: { requested: 2, scheduled: 2, conflicts: 0, unavailable: 0, quantity: 40, amount: 4010 },
  stock: { freeToSell: 500, enough: true },
  consecutive: true,
  summary: "2 vehicles back to back from 10:00 AM to 10:30 AM.",
  ...over,
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <FleetBooking />
    </MemoryRouter>,
  );

/** Put two vehicles in the store, as the customer would have. */
const withTwoVehicles = () =>
  useFleetStore.setState({
    stationId: "st1",
    stationName: "Baner Fuels",
    fuelType: "Petrol",
    bookingDate: "2099-01-05",
    preferredSlot: "10:00 AM",
    vehicles: [
      { vehiclePlate: "MH12AB0001", quantity: 20 },
      { vehiclePlate: "MH12AB0002", quantity: 20 },
    ],
  });

beforeEach(() => {
  vi.clearAllMocks();
  useFleetStore.getState().reset();
  useFleetStore.setState({ groups: [] });
  useAuthStore.setState({
    user: { id: "u1", name: "Fleet owner", role: "customer", vehicles: [] } as never,
    isAuthenticated: true,
  });
  useStationStore.setState({ stations: [STATION] as never, load: (async () => {}) as never });
});

describe("the station the customer already chose", () => {
  /** The page as it is reached from a station: /fleet-booking?stationId=… */
  const renderFromStation = (query = "?stationId=st1&stationName=Baner%20Fuels&fuelType=Diesel") =>
    render(
      <MemoryRouter initialEntries={[`/fleet-booking${query}`]}>
        <FleetBooking />
      </MemoryRouter>,
    );

  it("is carried across and stated, not asked for again", async () => {
    renderFromStation();

    const panel = await screen.findByTestId("fleet-station-locked");
    expect(within(panel).getByText("Baner Fuels")).toBeTruthy();
    // The chooser is gone: there is nothing here to pick the station with.
    expect(screen.queryByTestId("fleet-station-select")).toBeNull();
    expect(screen.queryByText("Choose a station…")).toBeNull();
    // And it is the station that was passed, not a default or the first in the list.
    expect(useFleetStore.getState().stationId).toBe("st1");
    expect(useFleetStore.getState().stationLocked).toBe(true);
  });

  it("carries the fuel across too, when the station sells it", async () => {
    renderFromStation();
    await waitFor(() => expect(useFleetStore.getState().fuelType).toBe("Diesel"));
  });

  it("survives a reload, because the station is in the address", async () => {
    // A remount is what a refresh looks like to the page: nothing is kept in
    // memory, and the station still has to be there afterwards.
    const first = renderFromStation();
    await screen.findByTestId("fleet-station-locked");
    first.unmount();
    useFleetStore.getState().reset();

    renderFromStation();
    expect(within(await screen.findByTestId("fleet-station-locked")).getByText("Baner Fuels")).toBeTruthy();
    expect(useFleetStore.getState().stationId).toBe("st1");
  });

  it("shows the name from the address while the station list is still loading", async () => {
    // The pumps arrive from the API; the station's name came with the link, so
    // there is no moment where the panel reads "Station" with a blank beside it.
    useStationStore.setState({ stations: null as never });
    renderFromStation();
    expect(within(await screen.findByTestId("fleet-station-locked")).getByText("Baner Fuels")).toBeTruthy();
  });

  it("reached from the sidebar instead, the chooser is there", async () => {
    renderPage();
    expect(screen.getByTestId("fleet-station-select")).toBeTruthy();
    expect(screen.queryByTestId("fleet-station-locked")).toBeNull();
  });

  it("a station chosen earlier does not lock a fresh fleet booking", async () => {
    // Arrived from a station, then opened fleet booking again from the sidebar:
    // that is a booking started from scratch, so the chooser comes back.
    useFleetStore.setState({ stationId: "st1", stationName: "Baner Fuels", stationLocked: true });
    renderPage();
    await waitFor(() => expect(useFleetStore.getState().stationLocked).toBe(false));
    expect(screen.getByTestId("fleet-station-select")).toBeTruthy();
  });
});

describe("what has to be filled in before slots are found", () => {
  it("names what is missing instead of only greying the button out", async () => {
    renderPage();

    const button = () => screen.getByRole("button", { name: /Find best slots/ }) as HTMLButtonElement;
    // No station yet: that is the first thing to fix, and it is said.
    useFleetStore.setState({ stationId: null, vehicles: [] });
    await waitFor(() => expect(screen.getByTestId("fleet-missing").textContent).toMatch(/Choose a station/));
    expect(button().disabled).toBe(true);

    // A station but one vehicle: a fleet booking is two or more, and the
    // message points at the normal booking for one.
    useFleetStore.setState({ stationId: "st1", vehicles: [{ vehiclePlate: "MH12AB0001", quantity: 20 }] });
    await waitFor(() => expect(screen.getByTestId("fleet-missing").textContent).toMatch(/one more vehicle/i));
    expect(screen.getByTestId("fleet-missing").textContent).toMatch(/normal booking/i);
    expect(button().disabled).toBe(true);

    // A vehicle with no quantity is named, because the customer has to know
    // WHICH van to fix.
    useFleetStore.setState({
      vehicles: [
        { vehiclePlate: "MH12AB0001", quantity: 20 },
        { vehiclePlate: "MH12AB0002", quantity: 0 },
      ],
    });
    await waitFor(() => expect(screen.getByTestId("fleet-missing").textContent).toMatch(/MH12AB0002/));
    expect(button().disabled).toBe(true);

    // A day that has gone.
    useFleetStore.setState({
      bookingDate: "2020-01-01",
      vehicles: [
        { vehiclePlate: "MH12AB0001", quantity: 20 },
        { vehiclePlate: "MH12AB0002", quantity: 20 },
      ],
    });
    await waitFor(() => expect(screen.getByTestId("fleet-missing").textContent).toMatch(/has passed/i));
    expect(button().disabled).toBe(true);
  });

  it("two vehicles, each with its own quantity, is enough to look for slots", async () => {
    renderPage();
    useFleetStore.setState({
      stationId: "st1",
      bookingDate: "2099-01-05",
      vehicles: [
        { vehiclePlate: "MH12AB0001", quantity: 20 },
        // Deliberately different: a fleet is not one quantity five times.
        { vehiclePlate: "MH12AB0002", quantity: 35 },
      ],
    });

    await waitFor(() =>
      expect((screen.getByRole("button", { name: /Find best slots/ }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.queryByTestId("fleet-missing")).toBeNull();
  });
});

describe("building the request", () => {
  it("asks for at least two vehicles before it will look for slots", async () => {
    renderPage();
    expect(screen.getByText(/Add at least two vehicles/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Find best slots/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("refuses to add the same vehicle twice", async () => {
    const user = userEvent.setup();
    renderPage();
    const field = screen.getByLabelText("Registration number");

    await user.type(field, "mh12ab0001");
    await user.click(screen.getByRole("button", { name: /Add vehicle/ }));
    await user.type(field, "MH12 AB 0001"); // same van, written differently
    await user.click(screen.getByRole("button", { name: /Add vehicle/ }));

    expect(useFleetStore.getState().vehicles).toHaveLength(1);
    expect(useFleetStore.getState().vehicles[0].vehiclePlate).toBe("MH12AB0001");
  });
});

describe("quantities are per vehicle", () => {
  it("labels the add field as a fuel quantity and says each vehicle may differ", () => {
    renderPage();
    expect(screen.getByText("Fuel Quantity (L/kg)")).toBeTruthy();
    expect(screen.getByText("Each vehicle can have a different quantity.")).toBeTruthy();
    expect(screen.getByLabelText("Fuel quantity for the vehicle being added")).toBeTruthy();
  });

  it("every added vehicle keeps its own editable quantity", async () => {
    const user = userEvent.setup();
    withTwoVehicles();
    renderPage();

    const first = screen.getByLabelText("Fuel quantity for MH12AB0001") as HTMLInputElement;
    const second = screen.getByLabelText("Fuel quantity for MH12AB0002") as HTMLInputElement;
    expect(first.value).toBe("20");

    await user.clear(first);
    await user.type(first, "45");

    // Only that vehicle changed.
    expect(useFleetStore.getState().vehicles.find((v) => v.vehiclePlate === "MH12AB0001")?.quantity).toBe(45);
    expect(useFleetStore.getState().vehicles.find((v) => v.vehiclePlate === "MH12AB0002")?.quantity).toBe(20);
    expect(second.value).toBe("20");
  });

  it("shows each vehicle's own price and the total as their sum", async () => {
    const user = userEvent.setup();
    // Two different fills at the same rate: 20 L and 5 L.
    const mixed = plan();
    mixed.vehicles[1] = { ...mixed.vehicles[1], quantity: 5, amount: 505 };
    mixed.totals = { requested: 2, scheduled: 2, conflicts: 0, unavailable: 0, quantity: 25, amount: 2510 };
    vi.mocked(api.planFleet).mockResolvedValue(mixed);

    withTwoVehicles();
    renderPage();
    await user.click(screen.getByRole("button", { name: /Find best slots/ }));

    const schedule = await screen.findByLabelText("Suggested schedule");
    // Each row carries its own quantity, rate and amount.
    expect(within(schedule).getByText("20 L × ₹100 = ₹2,005.00")).toBeTruthy();
    expect(within(schedule).getByText("5 L × ₹100 = ₹505.00")).toBeTruthy();
    // The total is the sum of the individual quantities, said to be.
    expect(screen.getByText("Total fuel (all vehicles)")).toBeTruthy();
    expect(screen.getByText("25 L")).toBeTruthy();
    expect(screen.getByText("₹2,510.00")).toBeTruthy();
  });
});

describe("the suggested schedule", () => {
  it("shows the server's plan, its wording and its money", async () => {
    const user = userEvent.setup();
    vi.mocked(api.planFleet).mockResolvedValue(plan());
    withTwoVehicles();
    renderPage();

    await user.click(screen.getByRole("button", { name: /Find best slots/ }));
    await waitFor(() => expect(api.planFleet).toHaveBeenCalled());

    expect(await screen.findByText("2 vehicles back to back from 10:00 AM to 10:30 AM.")).toBeTruthy();
    const rows = screen.getAllByRole("listitem").filter((li) => li.className.includes("fm-fleet-slot"));
    expect(within(rows[0]).getByText("MH12AB0001")).toBeTruthy();
    expect(within(rows[0]).getByText("10:00 AM")).toBeTruthy();
    expect(within(rows[1]).getByText("10:30 AM")).toBeTruthy();
    // The totals come from the plan, not from anything added up here.
    expect(screen.getByText("₹4,010.00")).toBeTruthy();
    expect(screen.getByText("40 L")).toBeTruthy();
  });

  it("marks a vehicle the server says is already booked, and leaves it out of Confirm", async () => {
    const user = userEvent.setup();
    vi.mocked(api.planFleet).mockResolvedValue(
      plan({
        vehicles: [
          plan().vehicles[0],
          {
            index: 2,
            vehiclePlate: "MH12AB0002",
            quantity: 20,
            state: "conflict",
            reason: "VEHICLE_ALREADY_BOOKED",
            message: "MH12AB0002 already has a booking (9:00 AM on 2099-01-05).",
          },
        ],
        totals: { requested: 2, scheduled: 1, conflicts: 1, unavailable: 0, quantity: 20, amount: 2005 },
        summary: "One vehicle at 10:00 AM. 1 vehicle already has a booking and was left out.",
      }),
    );
    vi.mocked(api.confirmFleet).mockResolvedValue({
      group: { fleetId: "f1", reference: "FM-FLEET-2099-AAAA", counts: { total: 1, live: 1, completed: 0, cancelled: 0 } } as never,
      bookings: [
        {
          bookingId: "b1",
          orderId: "FM-2099-0001",
          fleetIndex: 1,
          vehiclePlate: "MH12AB0001",
          timeSlot: "10:00 AM",
          startTime: "10:00",
          endTime: "10:30",
          quantity: 20,
          verificationCode: "1234",
        } as never,
      ],
      failures: [],
      summary: "1 vehicle booked at 10:00 AM.",
    });

    withTwoVehicles();
    renderPage();
    await user.click(screen.getByRole("button", { name: /Find best slots/ }));

    const schedule = await screen.findByLabelText("Suggested schedule");
    // The summary sentence mentions it as well, which is right; what matters
    // is that the vehicle's own row carries the reason.
    expect(within(schedule).getAllByText(/already has a booking/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Conflict").length).toBeGreaterThan(0);

    // Confirm offers only the vehicle that has a slot...
    const confirm = await screen.findByRole("button", { name: /Confirm 1 bookings/ });
    await user.click(confirm);

    // ...and only that one is sent.
    await waitFor(() => expect(api.confirmFleet).toHaveBeenCalled());
    const sent = vi.mocked(api.confirmFleet).mock.calls[0][0];
    expect(sent.vehicles.map((v) => v.vehiclePlate)).toEqual(["MH12AB0001"]);
  });

  it("editing one vehicle's slot asks the server for that vehicle only", async () => {
    const user = userEvent.setup();
    vi.mocked(api.planFleet).mockResolvedValue(plan());
    vi.mocked(api.planFleetVehicle).mockResolvedValue({
      index: 2,
      vehiclePlate: "MH12AB0002",
      quantity: 20,
      state: "suggested",
      timeSlot: "1:00 PM",
      startTime: "13:00",
      endTime: "13:30",
      resource: 1,
      amount: 2005,
    });

    withTwoVehicles();
    renderPage();
    await user.click(screen.getByRole("button", { name: /Find best slots/ }));
    const schedule = await screen.findByLabelText("Suggested schedule");
    await within(schedule).findByText("10:30 AM");

    await user.click(screen.getAllByRole("button", { name: /Edit slot/ })[1]);
    await user.selectOptions(screen.getByLabelText("New time for MH12AB0002"), "1:00 PM");

    await waitFor(() => expect(api.planFleetVehicle).toHaveBeenCalled());
    const asked = vi.mocked(api.planFleetVehicle).mock.calls[0][0];
    expect(asked.vehiclePlate).toBe("MH12AB0002");
    expect(asked.timeSlot).toBe("1:00 PM");

    // The moved vehicle shows its new time; the other keeps its own.
    await waitFor(() => expect(within(schedule).getByText("1:00 PM")).toBeTruthy());
    expect(within(schedule).getByText("10:00 AM")).toBeTruthy();
    const state = useFleetStore.getState();
    expect(state.vehicles.find((v) => v.vehiclePlate === "MH12AB0001")?.timeSlot).toBe("10:00 AM");
    expect(state.vehicles.find((v) => v.vehiclePlate === "MH12AB0002")?.timeSlot).toBe("1:00 PM");
  });

  it("says so when the window the customer picked is full", async () => {
    const user = userEvent.setup();
    vi.mocked(api.planFleet).mockResolvedValue(plan());
    vi.mocked(api.planFleetVehicle).mockResolvedValue({
      index: 2,
      vehiclePlate: "MH12AB0002",
      quantity: 20,
      state: "full",
      reason: "SLOT_FULL",
      timeSlot: "1:00 PM",
      message: "1:00 PM is full for Petrol at this station. Pick another time.",
    });

    withTwoVehicles();
    renderPage();
    await user.click(screen.getByRole("button", { name: /Find best slots/ }));
    const schedule = await screen.findByLabelText("Suggested schedule");
    await within(schedule).findByText("10:30 AM");
    await user.click(screen.getAllByRole("button", { name: /Edit slot/ })[1]);
    await user.selectOptions(screen.getByLabelText("New time for MH12AB0002"), "1:00 PM");

    expect(await screen.findByText(/1:00 PM is full/)).toBeTruthy();
    // That vehicle now has no slot, so Confirm covers only the other one.
    await waitFor(() =>
      expect(useFleetStore.getState().vehicles.find((v) => v.vehiclePlate === "MH12AB0002")?.timeSlot).toBeNull(),
    );
  });
});

describe("confirming", () => {
  it("shows what was booked AND what was not", async () => {
    const user = userEvent.setup();
    vi.mocked(api.planFleet).mockResolvedValue(plan());
    vi.mocked(api.confirmFleet).mockResolvedValue({
      group: {
        fleetId: "f1",
        reference: "FM-FLEET-2099-BBBB",
        fuelType: "Petrol",
        counts: { total: 1, live: 1, completed: 0, cancelled: 0 },
      } as never,
      bookings: [
        {
          bookingId: "b1",
          orderId: "FM-2099-0001",
          fleetIndex: 1,
          vehiclePlate: "MH12AB0001",
          timeSlot: "10:00 AM",
          startTime: "10:00",
          endTime: "10:30",
          quantity: 20,
          verificationCode: "4321",
        } as never,
      ],
      failures: [
        {
          vehiclePlate: "MH12AB0002",
          quantity: 20,
          timeSlot: "10:30 AM",
          fleetIndex: 2,
          reason: "SLOT_TAKEN",
          message: "10:30 AM filled up before this was confirmed, so MH12AB0002 was not booked.",
        },
      ],
      summary: "1 vehicle booked at 10:00 AM. 1 could not be booked: MH12AB0002. The rest are confirmed.",
    });

    withTwoVehicles();
    renderPage();
    await user.click(screen.getByRole("button", { name: /Find best slots/ }));
    await user.click(await screen.findByRole("button", { name: /Confirm 2 bookings/ }));

    // Booked: its reference, and ONE code for the whole group.
    expect(await screen.findByText("FM-FLEET-2099-BBBB")).toBeTruthy();
    expect(screen.getByText("Your code for all vehicles")).toBeTruthy();
    expect(screen.getAllByText("4321")).toHaveLength(1);
    expect(screen.getByText(/it checks in every vehicle in this booking/)).toBeTruthy();
    expect(screen.getByText(/FM-2099-0001/)).toBeTruthy();

    // Not booked: said plainly, with the reason.
    expect(screen.getByText("Not booked")).toBeTruthy();
    expect(screen.getByText(/filled up before this was confirmed/)).toBeTruthy();
  });

  it("a refusal from the server is shown, not swallowed", async () => {
    const user = userEvent.setup();
    vi.mocked(api.planFleet).mockResolvedValue(plan());
    vi.mocked(api.confirmFleet).mockRejectedValue({
      response: { data: { msg: "This station is being booked by someone else at the moment." } },
    });

    withTwoVehicles();
    renderPage();
    await user.click(screen.getByRole("button", { name: /Find best slots/ }));
    await user.click(await screen.findByRole("button", { name: /Confirm 2 bookings/ }));

    expect((await screen.findAllByRole("alert")).some((a) => a.textContent?.includes("being booked by someone else"))).toBe(
      true,
    );
    // Still on the schedule, with the plan intact, so they can try again.
    expect(useFleetStore.getState().step).toBe("schedule");
  });
});
