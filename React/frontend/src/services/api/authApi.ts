import { apiClient, toApiError } from "./apiClient";
import type { LoginResponse, User } from "@/types";
import { FORGOT_PASSWORD_GENERIC_MSG } from "@/constants/auth";

/**
 * Authentication against the existing /api/auth endpoints.
 * No contract changed -- these are the same routes, bodies and responses the
 * Vanilla app used.
 */

export interface LoginResult {
  ok: boolean;
  data?: LoginResponse;
  /** The backend sets this when the account exists but is unverified. */
  needsVerification?: boolean;
  msg?: string;
}

export async function login(email: string, password: string): Promise<LoginResult> {
  try {
    const { data } = await apiClient.post<LoginResponse>("/auth/login", {
      email,
      password,
    });
    return { ok: true, data };
  } catch (err) {
    const e = toApiError(err);
    // Preserved from the Vanilla flow: an unverified account is offered a
    // "resend" action rather than being told its password is wrong.
    const needsVerification =
      (err as { response?: { data?: { needsVerification?: boolean } } })?.response?.data
        ?.needsVerification ?? false;
    return { ok: false, msg: e.msg, needsVerification };
  }
}

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
}

export async function register(input: RegisterInput) {
  try {
    const { data } = await apiClient.post<LoginResponse & { msg?: string }>(
      "/auth/register",
      input,
    );
    return { ok: true as const, data };
  } catch (err) {
    return { ok: false as const, ...toApiError(err) };
  }
}

export async function resendVerification(email: string) {
  try {
    const { data } = await apiClient.post<{ msg: string }>("/auth/resend-verification", {
      email,
    });
    return { ok: true as const, msg: data.msg };
  } catch (err) {
    return { ok: false as const, ...toApiError(err) };
  }
}

/**
 * GET /api/auth/verify-email/:token -- the link in the verification email
 * (backend/src/services/notification/emailService.js) lands on `/?verify=<token>`.
 */
export async function verifyEmail(token: string) {
  try {
    const { data } = await apiClient.get<{ msg?: string }>(
      `/auth/verify-email/${encodeURIComponent(token)}`,
    );
    return { ok: true as const, msg: data?.msg };
  } catch (err) {
    const e = toApiError(err);
    // Same fallbacks the Vanilla page used for the two failure kinds.
    return {
      ok: false as const,
      msg: e.reason === "NETWORK" ? "Network error while verifying." : e.msg || "Invalid or expired token.",
    };
  }
}

const httpStatus = (err: unknown) => (err as { response?: { status?: number } })?.response?.status;

/**
 * POST /api/auth/forgot-password -- ask for a reset link.
 *
 * A request the server accepted always resolves to the same generic message,
 * never the server's own text, so nothing on screen depends on whether the
 * email is registered. Only problems that say nothing about the account
 * (offline, rate-limited) are reported as failures.
 */
export async function requestPasswordReset(email: string): Promise<{ ok: boolean; msg: string }> {
  try {
    await apiClient.post("/auth/forgot-password", { email });
    return { ok: true, msg: FORGOT_PASSWORD_GENERIC_MSG };
  } catch (err) {
    const status = httpStatus(err);
    const e = toApiError(err);
    if (status === 429) return { ok: false, msg: "Too many reset requests. Please wait a few minutes and try again." };
    if (e.reason === "NETWORK") return { ok: false, msg: e.msg };
    if (status === 400) return { ok: false, msg: e.msg };
    return { ok: false, msg: "Could not send the reset link right now. Please try again." };
  }
}

export interface ResetPasswordResult {
  ok: boolean;
  msg: string;
  /** "INVALID_RESET_TOKEN" (bad, used or expired link) | "WEAK_PASSWORD" | "NETWORK" | ... */
  reason?: string;
}

/**
 * POST /api/auth/reset-password -- set a new password with the emailed token.
 * On success the server has signed the account out on every device.
 */
export async function resetPassword(token: string, password: string): Promise<ResetPasswordResult> {
  try {
    const { data } = await apiClient.post<{ msg?: string }>("/auth/reset-password", { token, password });
    return { ok: true, msg: data?.msg ?? "Your password has been reset. Please sign in with your new password." };
  } catch (err) {
    if (httpStatus(err) === 429) {
      return { ok: false, msg: "Too many attempts. Please wait a few minutes and try again.", reason: "RATE_LIMITED" };
    }
    const e = toApiError(err);
    return { ok: false, msg: e.msg, reason: e.reason };
  }
}

export type MeResult =
  | { status: "ok"; user: User }
  /** The server actively rejected the token (401/403). The session is dead. */
  | { status: "unauthorized" }
  /** The server could not be reached, or failed. Says NOTHING about the token. */
  | { status: "unreachable" };

/**
 * Re-read the signed-in user from the server.
 *
 * Called on boot so a persisted profile cannot drift from reality: a vendor
 * approved (or suspended) since the last visit gets their real status, rather
 * than whatever localStorage remembered.
 *
 * The three-way result matters. An earlier version returned `User | null` and
 * the caller logged out on null -- so a backend restart, a dropped Wi-Fi
 * moment or a 500 destroyed a perfectly valid session and dumped the user on
 * the login screen. Only a 401/403 is evidence about the token; everything
 * else is evidence about the network.
 */
export async function getMe(): Promise<MeResult> {
  try {
    const { data } = await apiClient.get<{ user: User }>("/auth/me");
    return data.user ? { status: "ok", user: data.user } : { status: "unauthorized" };
  } catch (err) {
    const code = (err as { response?: { status?: number } })?.response?.status;
    if (code === 401 || code === 403) return { status: "unauthorized" };
    return { status: "unreachable" };
  }
}

/**
 * POST /api/auth/logout -- the server revokes this device's session and
 * clears its httpOnly cookies. Never throws: the local session ends either way.
 */
export async function logoutRequest(): Promise<void> {
  try {
    await apiClient.post("/auth/logout");
  } catch {
    /* offline or failing: the access cookie still expires on its own */
  }
}

/** POST /api/auth/logout-all -- sign out on every device. */
export async function logoutEverywhere(): Promise<{ ok: boolean; msg?: string }> {
  try {
    const { data } = await apiClient.post<{ msg?: string }>("/auth/logout-all");
    return { ok: true, msg: data.msg };
  } catch (err) {
    return { ok: false, msg: toApiError(err).msg };
  }
}
