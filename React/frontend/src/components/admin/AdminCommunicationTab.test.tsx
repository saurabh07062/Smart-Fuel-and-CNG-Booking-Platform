import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Phase 7 of the chat feature: the admin communication centre.
 *
 * What is checked: the two tabs ask the server for the right channel, the
 * filters and the search are passed through rather than applied locally (the
 * server owns visibility), the account and booking behind a thread are shown so
 * the queue is workable, and the status controls do what they say.
 *
 * The centre asks for one kind at a time and renders the rows it is given --
 * which is the point: a customer_vendor thread is never in an admin's list
 * because the SERVER does not return one (backend services/chat/access.js), not
 * because this component filters it out.
 */

vi.mock("@/services/api/chatApi", () => ({
  fetchChatContext: vi.fn(),
  askAssistant: vi.fn(),
  fetchConversations: vi.fn(),
  fetchUnread: vi.fn(async () => ({ threads: 2, messages: 3, side: "admin" })),
  fetchThread: vi.fn(),
  openConversation: vi.fn(),
  sendChatMessage: vi.fn(),
  markConversationRead: vi.fn(),
  setConversationStatus: vi.fn(),
}));

import * as api from "@/services/api/chatApi";
import type { ConversationRow } from "@/services/api/chatApi";
import AdminCommunicationTab from "./AdminCommunicationTab";
import { useChatStore } from "@/store/chatStore";
import { useAuthStore } from "@/store/authStore";

const customerRow: ConversationRow = {
  conversationId: "c1",
  kind: "customer_admin",
  subject: "Queue is not moving",
  topic: "queue",
  status: "open",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastMessage: { text: "I have been waiting 25 minutes.", at: new Date().toISOString(), senderRole: "customer" },
  unread: 2,
  booking: {
    bookingId: "b1",
    reference: "FM-2026-ABCD1234",
    fuelType: "Petrol",
    bookingDate: "2026-02-01",
    timeSlot: "10:00 AM",
    status: "upcoming",
    paymentStatus: "due_at_station",
  },
  station: { stationId: "s1", name: "Baner Fuels", address: "Baner Road", status: "Active" },
  customer: { userId: "u1", name: "Asha K", email: "asha@example.com", phone: "9876543210" },
  vendor: null,
  unreadBySide: { customer: 0, vendor: 0, admin: 2 },
  assignedAdmin: null,
};

const vendorRow: ConversationRow = {
  ...customerRow,
  conversationId: "v1",
  kind: "vendor_admin",
  subject: "Price update not showing",
  topic: "station",
  status: "pending",
  unread: 0,
  customer: null,
  vendor: { userId: "u2", name: "Ravi", businessName: "Urja Fuels", vendorCode: "VEN-2026-0042", email: "ravi@example.com", phone: "9812345678" },
  unreadBySide: { customer: 0, vendor: 0, admin: 0 },
};

const page = (rows: ConversationRow[]) => ({ conversations: rows, total: rows.length, page: 1, pages: 1, perPage: 25 });

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.getState().reset();
  useAuthStore.setState({ user: { id: "admin1", name: "Admin", role: "admin" } as never, isAuthenticated: true });
  vi.mocked(api.fetchConversations).mockImplementation(async (filters) =>
    page(filters?.kind === "vendor_admin" ? [vendorRow] : [customerRow]),
  );
});

describe("the queue", () => {
  it("opens on customer conversations and names the account behind each", async () => {
    render(<AdminCommunicationTab />);

    await waitFor(() =>
      expect(api.fetchConversations).toHaveBeenCalledWith(expect.objectContaining({ kind: "customer_admin", page: 1 })),
    );
    expect(await screen.findByText("Queue is not moving")).toBeTruthy();
    expect(screen.getByText("Asha K")).toBeTruthy();
    expect(screen.getByText("· FM-2026-ABCD1234")).toBeTruthy();
    expect(screen.getByLabelText("2 unread messages")).toBeTruthy();
  });

  it("the Vendors tab asks the server for the vendor channel", async () => {
    const user = userEvent.setup();
    render(<AdminCommunicationTab />);
    await screen.findByText("Queue is not moving");

    await user.click(screen.getByRole("tab", { name: /Vendors/ }));
    await waitFor(() =>
      expect(api.fetchConversations).toHaveBeenCalledWith(expect.objectContaining({ kind: "vendor_admin" })),
    );
    expect(await screen.findByText("Price update not showing")).toBeTruthy();
    expect(screen.getByText("Urja Fuels")).toBeTruthy();
  });

  it("a status filter and a search go to the server, not a local filter", async () => {
    const user = userEvent.setup();
    render(<AdminCommunicationTab />);
    await screen.findByText("Queue is not moving");

    await user.click(screen.getByRole("button", { name: "pending" }));
    await waitFor(() => expect(api.fetchConversations).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" })));

    await user.type(screen.getByLabelText("Search conversations"), "refund");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(api.fetchConversations).toHaveBeenCalledWith(expect.objectContaining({ q: "refund" })));
  });

  it("says so plainly when there is nothing, rather than showing an empty frame", async () => {
    vi.mocked(api.fetchConversations).mockResolvedValue(page([]));
    render(<AdminCommunicationTab />);
    expect(await screen.findByText("Nothing here")).toBeTruthy();
    expect(screen.getByText(/No customer has opened a support conversation yet/)).toBeTruthy();
  });

  it("shows the team's unread total in the header", async () => {
    render(<AdminCommunicationTab />);
    await useChatStore.getState().loadUnread();
    expect(await screen.findByText(/2 conversation\(s\) with 3 unread message\(s\)/)).toBeTruthy();
  });
});

describe("an open conversation", () => {
  beforeEach(() => {
    vi.mocked(api.fetchThread).mockResolvedValue({
      conversation: customerRow,
      messages: [
        {
          messageId: "m1",
          conversationId: "c1",
          senderId: "u1",
          senderRole: "customer",
          senderName: "Asha K",
          kind: "text",
          body: "I have been waiting 25 minutes.",
          context: { reference: "FM-2026-ABCD1234" },
          clientId: null,
          readBy: [],
          createdAt: new Date().toISOString(),
        },
      ],
      hasMore: false,
    });
  });

  it("shows its messages and the records it concerns", async () => {
    const user = userEvent.setup();
    render(<AdminCommunicationTab />);
    await user.click(await screen.findByRole("button", { name: /Queue is not moving/ }));

    expect(await screen.findByText("I have been waiting 25 minutes.")).toBeTruthy();
    // The booking and station are named from the server's row, not guessed.
    // (The reference appears twice on purpose -- in the list row and in the
    // detail panel -- so this asserts the detail panel's copy specifically.)
    expect(screen.getAllByText(/FM-2026-ABCD1234/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/· Petrol · 2026-02-01 10:00 AM · upcoming · due_at_station/)).toBeTruthy();
    expect(screen.getByText(/· Active · s1/)).toBeTruthy();
    expect(screen.getByText("asha@example.com")).toBeTruthy();
    expect(screen.getByText("customer 0 · vendor 0 · team 2")).toBeTruthy();
  });

  it("a reply is sent through the API", async () => {
    const user = userEvent.setup();
    vi.mocked(api.sendChatMessage).mockResolvedValue({
      message: {
        messageId: "m2",
        conversationId: "c1",
        senderId: "admin1",
        senderRole: "admin",
        senderName: "Admin",
        kind: "text",
        body: "We are checking with the station now.",
        context: null,
        clientId: "c-x",
        readBy: [],
        createdAt: new Date().toISOString(),
      },
      duplicate: false,
    });

    render(<AdminCommunicationTab />);
    await user.click(await screen.findByRole("button", { name: /Queue is not moving/ }));
    await user.type(await screen.findByLabelText("Your message"), "We are checking with the station now.");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(api.sendChatMessage).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ body: "We are checking with the station now." }),
      ),
    );
    expect(await screen.findByText("We are checking with the station now.")).toBeTruthy();
  });

  it("marking it resolved goes through the API", async () => {
    const user = userEvent.setup();
    vi.mocked(api.setConversationStatus).mockResolvedValue({
      conversation: { ...customerRow, status: "resolved" },
      changed: true,
    });

    render(<AdminCommunicationTab />);
    await user.click(await screen.findByRole("button", { name: /Queue is not moving/ }));
    await user.click(await screen.findByRole("button", { name: /Resolved/ }));

    await waitFor(() => expect(api.setConversationStatus).toHaveBeenCalledWith("c1", "resolved"));
  });

  it("a closed conversation offers no reply box", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchConversations).mockResolvedValue(page([{ ...customerRow, status: "closed" }]));
    vi.mocked(api.fetchThread).mockResolvedValue({
      conversation: { ...customerRow, status: "closed" },
      messages: [],
      hasMore: false,
    });

    render(<AdminCommunicationTab />);
    await user.click(await screen.findByRole("button", { name: /Queue is not moving/ }));

    expect(await screen.findByText(/Set it back to Open to reply/)).toBeTruthy();
    expect(screen.queryByLabelText("Your message")).toBeNull();
  });
});
