import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

vi.mock("@/services/api/authApi", () => ({
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  login: vi.fn(),
  register: vi.fn(),
  resendVerification: vi.fn(),
  logoutRequest: vi.fn(async () => {}),
}));

import * as authApi from "@/services/api/authApi";
import { FORGOT_PASSWORD_GENERIC_MSG } from "@/constants/auth";
import Login from "./Login";
import Register from "./Register";
import ForgotPassword from "./ForgotPassword";
import ResetPassword from "./ResetPassword";

const requestPasswordReset = vi.mocked(authApi.requestPasswordReset);
const resetPassword = vi.mocked(authApi.resetPassword);
const register = vi.mocked(authApi.register);

const TOKEN = "k3Yv9Qm2tX8pL4rW7sZ1nB6cD0fG5hJ2aE9uI3oP8yT";

/** Shows the router's current address so a test can check what is in the URL. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/login" element={<h2>Sign-in page</h2>} />
        <Route path="/login-form" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword redirectDelayMs={0} />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** A promise the test resolves by hand, to look at the page while a request is in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Forgot password", () => {
  it("the login page links to it and carries the typed email in router state, not the URL", async () => {
    const user = userEvent.setup();
    renderAt("/login-form");

    await user.type(screen.getByPlaceholderText("name@company.com"), "  asha@example.com ");
    await user.click(screen.getByRole("link", { name: "Forgot password?" }));

    expect(screen.getByTestId("location").textContent).toBe("/forgot-password");
    expect((screen.getByLabelText("Email Address") as HTMLInputElement).value).toBe("asha@example.com");
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });

  it("sends the email, shows a loading state, then the generic message only", async () => {
    const user = userEvent.setup();
    const pending = deferred<{ ok: boolean; msg: string }>();
    requestPasswordReset.mockReturnValue(pending.promise);
    renderAt("/forgot-password");

    await user.type(screen.getByLabelText("Email Address"), " asha@example.com ");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(requestPasswordReset).toHaveBeenCalledWith("asha@example.com");
    const sending = screen.getByRole("button", { name: /Sending link/ });
    expect((sending as HTMLButtonElement).disabled).toBe(true);

    pending.resolve({ ok: true, msg: FORGOT_PASSWORD_GENERIC_MSG });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain(FORGOT_PASSWORD_GENERIC_MSG);
    expect(status.textContent).not.toContain("asha@example.com");
    expect(screen.getByRole("link", { name: "Back to sign in" }).getAttribute("href")).toBe("/login");
  });

  it("does not call the API without an email", async () => {
    const user = userEvent.setup();
    renderAt("/forgot-password");

    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(requestPasswordReset).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Please enter your email address.");
  });

  it("shows a failure that says nothing about the account and keeps the form", async () => {
    const user = userEvent.setup();
    requestPasswordReset.mockResolvedValue({ ok: false, msg: "Could not reach the server. Check your connection." });
    renderAt("/forgot-password");

    await user.type(screen.getByLabelText("Email Address"), "asha@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Could not reach the server. Check your connection.");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeTruthy();
  });
});

describe("Reset password", () => {
  it("reads the token, removes it from the URL, and never stores it", async () => {
    renderAt(`/reset-password?token=${TOKEN}`);

    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/reset-password"));
    expect(document.body.textContent).not.toContain(TOKEN);
    const stored = [localStorage, sessionStorage]
      .flatMap((s) => Object.keys(s).map((k) => s.getItem(k) ?? ""))
      .join(" ");
    expect(stored).not.toContain(TOKEN);
    expect(screen.getByLabelText("New Password")).toBeTruthy();
  });

  it("without a token shows the invalid-link state and a way to request a new link", () => {
    renderAt("/reset-password");

    expect(screen.getByRole("alert").textContent).toContain("invalid or has expired");
    expect(screen.getByRole("link", { name: "Request a new link" }).getAttribute("href")).toBe("/forgot-password");
    expect(screen.queryByLabelText("New Password")).toBeNull();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("requires at least 8 characters and matching passwords before calling the API", async () => {
    const user = userEvent.setup();
    renderAt(`/reset-password?token=${TOKEN}`);

    await user.type(screen.getByLabelText("New Password"), "short7!");
    await user.type(screen.getByLabelText("Confirm New Password"), "short7!");
    await user.click(screen.getByRole("button", { name: "Reset password" }));
    expect(screen.getByRole("alert").textContent).toBe("Password must be at least 8 characters.");

    await user.clear(screen.getByLabelText("New Password"));
    await user.type(screen.getByLabelText("New Password"), "long-enough-1");
    await user.clear(screen.getByLabelText("Confirm New Password"));
    await user.type(screen.getByLabelText("Confirm New Password"), "long-enough-2");
    await user.click(screen.getByRole("button", { name: "Reset password" }));
    expect(screen.getByRole("alert").textContent).toBe("Passwords do not match.");

    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("submits the token and password, shows loading and success, then redirects to sign in", async () => {
    const user = userEvent.setup();
    const pending = deferred<authApi.ResetPasswordResult>();
    resetPassword.mockReturnValue(pending.promise);
    renderAt(`/reset-password?token=${TOKEN}`);

    await user.type(screen.getByLabelText("New Password"), "new-password-123");
    await user.type(screen.getByLabelText("Confirm New Password"), "new-password-123");
    await user.click(screen.getByRole("button", { name: "Reset password" }));

    expect(resetPassword).toHaveBeenCalledWith(TOKEN, "new-password-123");
    expect((screen.getByRole("button", { name: /Resetting password/ }) as HTMLButtonElement).disabled).toBe(true);

    pending.resolve({ ok: true, msg: "Your password has been reset." });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/login"));
    expect(screen.getByRole("heading", { name: "Sign-in page" })).toBeTruthy();
  });

  it("an invalid or expired token from the server switches to the invalid-link state", async () => {
    const user = userEvent.setup();
    resetPassword.mockResolvedValue({
      ok: false,
      msg: "This password reset link is invalid or has expired. Please request a new one.",
      reason: "INVALID_RESET_TOKEN",
    });
    renderAt(`/reset-password?token=${TOKEN}`);

    await user.type(screen.getByLabelText("New Password"), "new-password-123");
    await user.type(screen.getByLabelText("Confirm New Password"), "new-password-123");
    await user.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByRole("link", { name: "Request a new link" })).toBeTruthy();
    expect(screen.queryByLabelText("New Password")).toBeNull();
    expect(screen.getByTestId("location").textContent).toBe("/reset-password");
  });

  it("any other server error is shown on the form, which stays usable", async () => {
    const user = userEvent.setup();
    resetPassword.mockResolvedValue({ ok: false, msg: "Password must be at least 8 characters.", reason: "WEAK_PASSWORD" });
    renderAt(`/reset-password?token=${TOKEN}`);

    await user.type(screen.getByLabelText("New Password"), "new-password-123");
    await user.type(screen.getByLabelText("Confirm New Password"), "new-password-123");
    await user.click(screen.getByRole("button", { name: "Reset password" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Password must be at least 8 characters.");
    expect((screen.getByRole("button", { name: "Reset password" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Registration password rule", () => {
  it("refuses a 7-character password without calling the API, and accepts 8", async () => {
    const user = userEvent.setup();
    register.mockResolvedValue({ ok: false, msg: "stop here", reason: undefined, code: undefined, field: undefined, suggestion: null });
    renderAt("/register");

    await user.type(screen.getByPlaceholderText("Your name"), "Asha");
    await user.type(screen.getByPlaceholderText("name@company.com"), "asha@example.com");
    await user.type(screen.getByPlaceholderText("At least 8 characters"), "seven77");
    await user.type(screen.getByPlaceholderText("Repeat your password"), "seven77");
    await user.click(screen.getByRole("button", { name: "Create Account" }));
    expect(register).not.toHaveBeenCalled();

    await user.type(screen.getByPlaceholderText("At least 8 characters"), "8");
    await user.type(screen.getByPlaceholderText("Repeat your password"), "8");
    await user.click(screen.getByRole("button", { name: "Create Account" }));
    await waitFor(() => expect(register).toHaveBeenCalledWith({ name: "Asha", email: "asha@example.com", password: "seven778" }));
  });
});
