import { apiClient } from "./apiClient";

/**
 * The assistant and the support conversations -- backend routes/chatRoutes.js.
 *
 * One module for all three roles, because one API serves all three: what a
 * caller may see is decided on the server per request
 * (backend services/chat/access.js), never by which function the client calls.
 * Nothing here sends a role or a user id -- the session is the identity.
 */

// ── the assistant ──────────────────────────────────────────────────────────

/** The five live queue figures, exactly as backend queueInfo.js names them. */
export interface ChatQueueInfo {
  queuePosition: number | null;
  vehicleCountAhead: number | null;
  expectedWaitingSeconds: number | null;
  expectedWaitingTime: string | null;
  estimatedStartTime: string | null;
  estimatedStartAt: string | null;
}

export interface ChatBookingSummary {
  bookingId: string;
  reference: string | null;
  status: string;
  fuelType: string;
  quantity: number | null;
  unit: string;
  amount: number | null;
  pricePerUnit: number | null;
  bookingDate: string | null;
  timeSlot: string | null;
  startTime: string | null;
  endTime: string | null;
  station: { stationId: string; name: string | null; address: string | null; phone: string | null; status: string | null } | null;
  vehiclePlate: string | null;
  /** null when the queue genuinely has no figures for this booking yet. */
  queue: ChatQueueInfo | null;
  etaMinutes: number | null;
  checkIn: { done: boolean; at: string | null; distanceM: number | null };
  payment: { method: string | null; methodLabel: string | null; status: string | null; collectedAt: string | null };
  /** `usable` is false until the customer has checked in at the pump. */
  pin: { code: string; usable: boolean } | null;
  qrCodeData: string | null;
}

export interface ChatQuickAction {
  id: string;
  label: string;
  icon: string;
}

export interface ChatVendorStation {
  stationId: string;
  name: string;
  address: string;
  status: string;
  phone: string | null;
  fuelTypes: string[];
  /** null = no price published for that fuel. Never 0-as-a-price. */
  prices: Record<"petrol" | "diesel" | "cng", number | null>;
  fuelAvailability: Record<"petrol" | "diesel" | "cng", boolean>;
  stock: Record<
    "petrol" | "diesel" | "cng",
    { inTank: number; promisedToBookings: number; freeToSell: number; capacity: number | null } | null
  >;
  bookingsToday: {
    available: boolean;
    upcoming: number;
    serving: number;
    waitlisted: number;
    completed: number;
    cancelled: number;
    noShow: number;
    total: number;
  };
  queue: { available: boolean; waiting?: number | null; waitMinutes?: number | null; status?: string | null; byFuel?: Record<string, { queueLength: number; waitMinutes: number | null; queueStatus: string }> };
}

export interface ChatSupportSummary {
  threads: number;
  messages: number;
  side: "customer" | "vendor" | "admin";
}

export interface ChatContext {
  role: "customer" | "vendor" | "admin";
  generatedAt: string;
  greeting: string;
  quickActions: ChatQuickAction[];
  support: ChatSupportSummary | null;
  /** Customers: `available: false` means the read failed, not "no booking". */
  booking?: { available: boolean; hasBooking: boolean; summary: ChatBookingSummary | null };
  canContactVendor?: boolean;
  /** Vendors: their own stations only. */
  stations?: { available: boolean; count: number; list: ChatVendorStation[] };
  /** Admins: the support queue, by kind and status. */
  conversations?: { available: boolean; customer: Record<string, number>; vendor: Record<string, number> };
}

export interface ChatAnswer {
  intent: string | null;
  understood: boolean;
  answer: string;
  source?: string;
  booking?: ChatBookingSummary;
  /** What the UI should offer to DO about the answer (open a chat, a screen). */
  action?: { type: string; bookingId?: string | null; stationId?: string; kind?: string | null; status?: string | null };
  quickActions?: ChatQuickAction[];
  context: ChatContext;
}

export async function fetchChatContext(): Promise<ChatContext> {
  const { data } = await apiClient.get<ChatContext>("/chat/context");
  return data;
}

/**
 * Ask one question, or run one quick action.
 *
 * A tapped action sends `intent` and no question: the server treats that as
 * certain rather than as something to guess at.
 */
export async function askAssistant(input: { question?: string; intent?: string }): Promise<ChatAnswer> {
  const { data } = await apiClient.post<ChatAnswer>("/chat/ask", input);
  return data;
}

// ── conversations ──────────────────────────────────────────────────────────

export type ConversationKind = "customer_admin" | "vendor_admin" | "customer_vendor";
export type ConversationStatus = "open" | "pending" | "resolved" | "closed";

export interface ConversationRow {
  conversationId: string;
  kind: ConversationKind;
  subject: string;
  topic: string;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
  lastMessage: { text: string; at: string; senderRole: string | null } | null;
  /** This viewer's own unread count -- never another side's. */
  unread: number;
  booking: {
    bookingId: string;
    reference: string | null;
    fuelType: string | null;
    bookingDate: string | null;
    timeSlot: string | null;
    status: string | null;
    paymentStatus: string | null;
  } | null;
  station: { stationId: string; name: string | null; address: string | null; status: string | null } | null;
  /** Who the other side is, at the detail this viewer is entitled to. */
  counterparty?: { role: string; name: string };
  /** Admin console only: the account behind the thread. */
  customer?: { userId: string; name: string | null; email: string | null; phone: string | null } | null;
  vendor?: { userId: string; name: string | null; businessName: string | null; vendorCode: string | null; email: string | null; phone: string | null } | null;
  unreadBySide?: { customer: number; vendor: number; admin: number };
  assignedAdmin?: string | null;
}

export interface ChatMessage {
  messageId: string;
  conversationId: string;
  senderId: string;
  senderRole: "customer" | "vendor" | "admin";
  senderName: string;
  kind: "text" | "system";
  body: string;
  /** The booking snapshot the server attached to the thread's first message. */
  context: Record<string, unknown> | null;
  clientId: string | null;
  readBy: string[];
  createdAt: string;
}

export interface ConversationThread {
  conversation: ConversationRow;
  messages: ChatMessage[];
  hasMore: boolean;
  created?: boolean;
}

export interface ConversationPage {
  conversations: ConversationRow[];
  total: number;
  page: number;
  pages: number;
  perPage: number;
}

export interface ConversationFilters {
  kind?: ConversationKind;
  status?: ConversationStatus;
  q?: string;
  bookingId?: string;
  stationId?: string;
  page?: number;
  limit?: number;
}

export async function fetchConversations(filters: ConversationFilters = {}): Promise<ConversationPage> {
  const { data } = await apiClient.get<ConversationPage>("/chat/conversations", { params: filters });
  return data;
}

export async function fetchUnread(): Promise<ChatSupportSummary> {
  const { data } = await apiClient.get<ChatSupportSummary>("/chat/unread");
  return data;
}

export async function fetchThread(conversationId: string): Promise<ConversationThread> {
  const { data } = await apiClient.get<ConversationThread>(`/chat/conversations/${conversationId}`);
  return data;
}

/**
 * Open (or re-enter) a conversation.
 *
 * `with: "admin"` is the caller's own support thread; `with: "vendor"` needs the
 * booking it is about. Re-entering an existing thread is the normal case and
 * comes back with its history, so the customer is not shown an empty box.
 */
export async function openConversation(input: {
  with: "admin" | "vendor";
  bookingId?: string;
  subject?: string;
  topic?: string;
  message?: string;
  clientId?: string;
}): Promise<ConversationThread> {
  const { data } = await apiClient.post<ConversationThread>("/chat/conversations", input);
  return data;
}

/**
 * Send a message.
 *
 * `clientId` makes a retry idempotent: if the connection dropped after the
 * server stored it, sending again returns that same message
 * (`duplicate: true`) instead of posting it twice.
 */
export async function sendChatMessage(
  conversationId: string,
  input: { body: string; clientId?: string },
): Promise<{ message: ChatMessage; duplicate: boolean }> {
  const { data } = await apiClient.post<{ message: ChatMessage; duplicate: boolean }>(
    `/chat/conversations/${conversationId}/messages`,
    input,
  );
  return data;
}

export async function markConversationRead(conversationId: string): Promise<void> {
  await apiClient.post(`/chat/conversations/${conversationId}/read`, {});
}

/** Admin only (the server refuses anyone else). */
export async function setConversationStatus(
  conversationId: string,
  status: ConversationStatus,
): Promise<{ conversation: ConversationRow; changed: boolean }> {
  const { data } = await apiClient.patch<{ conversation: ConversationRow; changed: boolean }>(
    `/chat/conversations/${conversationId}/status`,
    { status },
  );
  return data;
}
