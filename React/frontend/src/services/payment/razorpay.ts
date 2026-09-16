import { apiClient } from "@/services/api/apiClient";

/**
 * Razorpay Checkout handoff.
 *
 * The secret never reaches the browser: this fetches only the PUBLIC key id
 * from the server, opens Checkout, and sends the signed response back for
 * server-side verification. Everything that decides whether a payment counts
 * lives in backend/controllers/paymentController.js.
 *
 * One thing improved over the Vanilla flow, and it is a real bug rather than
 * a preference: /create-order and /verify-payment now require auth (see
 * routes/paymentRoutes.js -- they were public, which let anyone mint orders
 * against the merchant account). The Vanilla code called them with bare
 * fetch() and no token, so it would 401 today. These calls go through
 * apiClient, which sends the httpOnly session cookie, so they are
 * authenticated without any call site remembering to do it.
 */

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => {
      open: () => void;
      on: (event: string, handler: (response: RazorpayFailure) => void) => void;
    };
  }
}

export interface RazorpayFailure {
  error?: { description?: string };
}

export interface RazorpaySuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

/**
 * Load Checkout once, on demand.
 *
 * The Vanilla app carried this <script> in index.html on every page load,
 * including for users who never paid. Loading it only when the pay button is
 * pressed keeps it off the critical path without changing what it does.
 */
let scriptPromise: Promise<boolean> | null = null;

export function loadRazorpayScript(): Promise<boolean> {
  if (window.Razorpay) return Promise.resolve(true);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<boolean>((resolve) => {
    const el = document.createElement("script");
    el.src = CHECKOUT_SRC;
    el.async = true;
    el.onload = () => resolve(true);
    el.onerror = () => {
      // Allow a later retry rather than caching the failure forever.
      scriptPromise = null;
      resolve(false);
    };
    document.body.appendChild(el);
  });

  return scriptPromise;
}

export interface PaymentStatus {
  configured: boolean;
  mode: string | null;
  reason?: string;
}

/**
 * GET /api/razorpay/status -- public on purpose, so the UI can disable online
 * payment when Razorpay is not set up rather than letting a customer reach
 * Checkout and fail there.
 */
export async function fetchPaymentStatus(): Promise<PaymentStatus> {
  try {
    const { data } = await apiClient.get<PaymentStatus>("/razorpay/status");
    return data;
  } catch (err) {
    // A non-2xx here still carries the config body; treat anything else as
    // "not configured" rather than assuming it works.
    const body = (err as { response?: { data?: PaymentStatus } })?.response?.data;
    return body ?? { configured: false, mode: null };
  }
}

export async function fetchRazorpayKey(): Promise<string> {
  const { data } = await apiClient.get<{ key: string }>("/razorpay/get-key");
  return data.key;
}

export async function createOrder(amount: number, bookingId?: string) {
  const { data } = await apiClient.post<{ id: string; amount: number; currency: string }>(
    "/razorpay/create-order",
    { amount, ...(bookingId ? { booking_id: bookingId } : {}) },
  );
  return data;
}

export async function verifyPayment(payload: RazorpaySuccess & { booking_id: string }) {
  const { data } = await apiClient.post<{ success: boolean; msg?: string }>(
    "/razorpay/verify-payment",
    payload,
  );
  return data;
}

export interface CheckoutParams {
  amount: number;
  bookingId: string;
  user: { name?: string; email?: string } | null;
  onSuccess: () => void;
  onFailure: (message: string) => void;
}

/** Open Checkout and verify the result server-side. Same options as Vanilla. */
export async function openCheckout({
  amount,
  bookingId,
  user,
  onSuccess,
  onFailure,
}: CheckoutParams): Promise<void> {
  const loaded = await loadRazorpayScript();
  if (!loaded || !window.Razorpay) {
    onFailure("Could not load the payment window. Check your connection and try again.");
    return;
  }

  const key = await fetchRazorpayKey();
  const order = await createOrder(amount, bookingId);

  const rzp = new window.Razorpay({
    key,
    amount: order.amount,
    currency: order.currency,
    name: "FuelMart",
    description: "Fuel Booking Payment",
    order_id: order.id,
    handler: async (response: RazorpaySuccess) => {
      try {
        const result = await verifyPayment({ ...response, booking_id: bookingId });
        if (result.success) onSuccess();
        else onFailure(result.msg || "Payment verification failed");
      } catch (err) {
        // A refusal (e.g. 409 BOOKING_NOT_PAYABLE) carries the server's explanation.
        const msg = (err as { response?: { data?: { msg?: string } } }).response?.data?.msg;
        onFailure(msg || "Error verifying payment");
      }
    },
    prefill: { name: user?.name ?? "", email: user?.email ?? "" },
    theme: { color: "#2563EB" },
  });

  rzp.on("payment.failed", (response: RazorpayFailure) => {
    onFailure(response.error?.description || "Payment failed");
  });

  rzp.open();
}
