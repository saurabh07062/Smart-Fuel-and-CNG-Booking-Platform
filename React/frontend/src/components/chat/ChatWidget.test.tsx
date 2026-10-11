import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Phase 5 of the chat feature: the customer and vendor widget.
 *
 * The assertions are about what the customer is TOLD, which is where a chatbot
 * does damage if it is careless:
 *
 *   - a booking's figures are the server's, and a figure the server could not
 *     read reads as "not available" rather than as 0 or a guess
 *   - the 4-digit code says plainly that it only works after check-in
 *   - a customer with no booking is offered the help topics instead of an empty
 *     booking card
 *   - a vendor sees their own station, and the widget never renders for a role
 *     that has no assistant
 */

vi.mock("@/services/api/chatApi", () => ({
  fetchChatContext: vi.fn(),
  askAssistant: vi.fn(),
  fetchConversations: vi.fn(async () => ({ conversations: [], total: 0, page: 1, pages: 1, perPage: 25 })),
  fetchUnread: vi.fn(async () => ({ threads: 0, messages: 0, side: "customer" })),
  fetchThread: vi.fn(),
  openConversation: vi.fn(),
  sendChatMessage: vi.fn(),
  markConversationRead: vi.fn(),
  setConversationStatus: vi.fn(),
}));

import * as api from "@/services/api/chatApi";
import type { ChatContext } from "@/services/api/chatApi";
import ChatWidget from "./ChatWidget";
import { useChatStore } from "@/store/chatStore";
import { useAuthStore } from "@/store/authStore";

const signIn = (role: string | null) =>
  useAuthStore.setState({
    user: role ? ({ id: "u1", name: "Customer", role } as never) : null,
    isAuthenticated: Boolean(role),
  });

const bookingContext = (over: Partial<ChatContext> = {}): ChatContext => ({
  role: "customer",
  generatedAt: new Date().toISOString(),
  greeting: "You have a Petrol booking at Baner Fuels.",
  quickActions: [
    { id: "booking_where", label: "Where is my booking?", icon: "fa-location-dot" },
    { id: "booking_queue", label: "Queue and waiting time", icon: "fa-hourglass-half" },
  ],
  support: { threads: 0, messages: 0, side: "customer" },
  canContactVendor: true,
  booking: {
    available: true,
    hasBooking: true,
    summary: {
      bookingId: "b1",
      reference: "FM-2026-ABCD1234",
      status: "upcoming",
      fuelType: "Petrol",
      quantity: 12,
      unit: "L",
      amount: 1254,
      pricePerUnit: 104.5,
      bookingDate: "2026-02-01",
      timeSlot: "10:00 AM",
      startTime: "10:00",
      endTime: "10:05",
      station: { stationId: "s1", name: "Baner Fuels", address: "Baner Road", phone: "9876543210", status: "Active" },
      vehiclePlate: "MH12AB3456",
      queue: {
        queuePosition: 3,
        vehicleCountAhead: 2,
        expectedWaitingSeconds: 600,
        expectedWaitingTime: "10 min",
        estimatedStartTime: "10:12 AM",
        estimatedStartAt: new Date().toISOString(),
      },
      etaMinutes: 10,
      checkIn: { done: false, at: null, distanceM: null },
      payment: { method: "station", methodLabel: "Pay at pump", status: "due_at_station", collectedAt: null },
      pin: { code: "7788", usable: false },
      qrCodeData: null,
    },
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.getState().reset();
  signIn("customer");
});

describe("the widget only exists for the roles that have an assistant", () => {
  it("a signed-out visitor gets nothing", () => {
    signIn(null);
    render(<ChatWidget />);
    expect(screen.queryByTestId("chat-fab")).toBeNull();
  });

  it("an admin gets nothing here -- their chat is the communication centre", () => {
    signIn("admin");
    render(<ChatWidget />);
    expect(screen.queryByTestId("chat-fab")).toBeNull();
  });
});

describe("a customer with a booking", () => {
  beforeEach(() => vi.mocked(api.fetchChatContext).mockResolvedValue(bookingContext()));

  it("opens to their own booking, with the server's figures", async () => {
    const user = userEvent.setup();
    render(<ChatWidget />);

    await user.click(screen.getByTestId("chat-fab"));
    await waitFor(() => expect(api.fetchChatContext).toHaveBeenCalled());

    expect(await screen.findByText("You have a Petrol booking at Baner Fuels.")).toBeTruthy();
    expect(screen.getByText("FM-2026-ABCD1234 · 10:00 AM · 2026-02-01")).toBeTruthy();
    expect(screen.getByText("#3")).toBeTruthy();
    expect(screen.getByText("10 min")).toBeTruthy();
    expect(screen.getByText("10:12 AM")).toBeTruthy();
    expect(screen.getByText("₹1,254.00")).toBeTruthy();
  });

  it("says the code only works after check-in", async () => {
    const user = userEvent.setup();
    render(<ChatWidget />);
    await user.click(screen.getByTestId("chat-fab"));

    expect(await screen.findByText("7788")).toBeTruthy();
    expect(screen.getByText("Works after check-in")).toBeTruthy();
    expect(screen.getByText("Not checked in")).toBeTruthy();
  });

  it("a quick action asks the server and shows its answer", async () => {
    const user = userEvent.setup();
    vi.mocked(api.askAssistant).mockResolvedValue({
      intent: "booking_queue",
      understood: true,
      answer: "You are number 3 in line, 2 vehicle(s) ahead of you, about 10 min to wait.",
      context: bookingContext(),
    });

    render(<ChatWidget />);
    await user.click(screen.getByTestId("chat-fab"));
    await user.click(await screen.findByRole("button", { name: /Queue and waiting time/ }));

    await waitFor(() => expect(api.askAssistant).toHaveBeenCalledWith({ intent: "booking_queue" }));
    expect(await screen.findByText(/You are number 3 in line/)).toBeTruthy();
  });

  it("\"Chat with Admin\" opens a thread and attaches the booking", async () => {
    const user = userEvent.setup();
    vi.mocked(api.openConversation).mockResolvedValue({
      conversation: {
        conversationId: "c1",
        kind: "customer_admin",
        subject: "Help with FM-2026-ABCD1234 booking",
        topic: "booking",
        status: "open",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastMessage: null,
        unread: 0,
        booking: null,
        station: null,
        counterparty: { role: "admin", name: "FuelMart support" },
      },
      messages: [],
      hasMore: false,
      created: true,
    });

    render(<ChatWidget />);
    await user.click(screen.getByTestId("chat-fab"));
    await user.click(await screen.findByRole("button", { name: /Chat with Admin/ }));

    await waitFor(() =>
      expect(api.openConversation).toHaveBeenCalledWith(
        expect.objectContaining({ with: "admin", bookingId: "b1", topic: "booking" }),
      ),
    );
    // The thread panel takes over, with a box to write in.
    expect(await screen.findByLabelText("Your message")).toBeTruthy();
  });

  it("\"Contact the station\" opens a booking-scoped vendor thread", async () => {
    const user = userEvent.setup();
    vi.mocked(api.openConversation).mockResolvedValue({
      conversation: {
        conversationId: "c2",
        kind: "customer_vendor",
        subject: "Question about a booking",
        topic: "booking",
        status: "open",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastMessage: null,
        unread: 0,
        booking: { bookingId: "b1", reference: "FM-2026-ABCD1234", fuelType: "Petrol", bookingDate: null, timeSlot: null, status: "upcoming", paymentStatus: null },
        station: null,
        counterparty: { role: "vendor", name: "Baner Fuels" },
      },
      messages: [],
      hasMore: false,
      created: true,
    });

    render(<ChatWidget />);
    await user.click(screen.getByTestId("chat-fab"));
    await user.click(await screen.findByRole("button", { name: /Contact the station/ }));

    await waitFor(() =>
      expect(api.openConversation).toHaveBeenCalledWith({ with: "vendor", bookingId: "b1", topic: "booking" }),
    );
  });
});

describe("a figure the server could not read is not filled in", () => {
  it("an unavailable queue reads as \"Not available yet\", never as 0", async () => {
    const user = userEvent.setup();
    const context = bookingContext();
    context.booking!.summary!.queue = null;
    vi.mocked(api.fetchChatContext).mockResolvedValue(context);

    render(<ChatWidget />);
    await user.click(screen.getByTestId("chat-fab"));

    const notAvailable = await screen.findAllByText("Not available yet");
    expect(notAvailable.length).toBeGreaterThanOrEqual(4); // position, ahead, wait, start
    expect(screen.queryByText("#0")).toBeNull();
  });

  it("a failed context read is reported, not shown as \"no booking\"", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchChatContext).mockRejectedValue({ response: { data: { msg: "Could not read your current details." } } });

    render(<ChatWidget />);
    await user.click(screen.getByTestId("chat-fab"));

    expect((await screen.findByRole("alert")).textContent).toContain("Could not read your current details.");
  });
});

describe("a customer with no booking", () => {
  it("is offered the help topics, not an empty booking card", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchChatContext).mockResolvedValue(
      bookingContext({
        greeting: "You have no active booking. I can help you find a station or explain how FuelMart works.",
        canContactVendor: false,
        booking: { available: true, hasBooking: false, summary: null },
        quickActions: [
          { id: "find_station", label: "Find a nearby station", icon: "fa-location-crosshairs" },
          { id: "book_slot", label: "How do I book a slot?", icon: "fa-calendar-check" },
        ],
      }),
    );

    render(<ChatWidget />);
    await user.click(screen.getByTestId("chat-fab"));

    expect(await screen.findByText(/no active booking/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Find a nearby station/ })).toBeTruthy();
    expect(screen.queryByLabelText("Your booking")).toBeNull();
    expect(screen.queryByText(/Contact the station/)).toBeNull();
  });
});

describe("a vendor", () => {
  it("sees their own station's figures", async () => {
    const user = userEvent.setup();
    signIn("vendor");
    vi.mocked(api.fetchChatContext).mockResolvedValue({
      role: "vendor",
      generatedAt: new Date().toISOString(),
      greeting: "Baner Fuels: 7 booking(s) today, 2 waiting.",
      quickActions: [{ id: "vendor_waiting", label: "Who is waiting?", icon: "fa-users" }],
      support: { threads: 1, messages: 2, side: "vendor" },
      stations: {
        available: true,
        count: 1,
        list: [
          {
            stationId: "s1",
            name: "Baner Fuels",
            address: "Baner Road",
            status: "Active",
            phone: null,
            fuelTypes: ["Petrol"],
            prices: { petrol: 104.5, diesel: null, cng: null },
            fuelAvailability: { petrol: true, diesel: true, cng: true },
            stock: { petrol: { inTank: 4000, promisedToBookings: 50, freeToSell: 3950, capacity: 10000 }, diesel: null, cng: null },
            bookingsToday: { available: true, upcoming: 4, serving: 1, waitlisted: 0, completed: 2, cancelled: 0, noShow: 0, total: 7 },
            queue: { available: true, waiting: 2, waitMinutes: 8, status: "Low" },
          },
        ],
      },
    });

    render(<ChatWidget />);
    await user.click(screen.getByTestId("chat-fab"));

    expect(await screen.findByText("Baner Fuels: 7 booking(s) today, 2 waiting.")).toBeTruthy();
    expect(screen.getByLabelText("Baner Fuels")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Who is waiting\?/ })).toBeTruthy();
  });
});
