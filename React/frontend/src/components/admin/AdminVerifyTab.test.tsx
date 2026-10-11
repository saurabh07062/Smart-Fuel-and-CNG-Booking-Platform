import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/services/api/adminApi", () => ({ verifyBooking: vi.fn() }));

import * as api from "@/services/api/adminApi";
import AdminVerifyTab from "./AdminVerifyTab";

beforeEach(() => vi.clearAllMocks());

describe("Admin support check-in", () => {
  it("checks a customer in with their 4-digit code, and clears the box", async () => {
    vi.mocked(api.verifyBooking).mockResolvedValue({ msg: "Checked in. Fueling has started.", started: true } as never);
    render(<AdminVerifyTab />);

    const box = screen.getByLabelText("Verification code") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "12a34" } });
    expect(box.value).toBe("1234"); // digits only, four at most

    fireEvent.click(screen.getByRole("button", { name: "Check In" }));
    await waitFor(() => expect(api.verifyBooking).toHaveBeenCalledWith({ verificationCode: "1234" }));
    await waitFor(() => expect((screen.getByLabelText("Verification code") as HTMLInputElement).value).toBe(""));
  });

  it("does not send an incomplete code", () => {
    render(<AdminVerifyTab />);
    fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Check In" }));
    expect(api.verifyBooking).not.toHaveBeenCalled();
  });

  it("has no camera scanner any more", () => {
    const { container } = render(<AdminVerifyTab />);
    expect(container.querySelector("#qr-reader")).toBeNull();
    expect(screen.queryByRole("button", { name: /Camera/i })).toBeNull();
    expect(screen.queryByText(/Scan QR/i)).toBeNull();
  });
});

describe("The code is validated against the schema before it is sent", () => {
  it("keeps the button disabled until there are four digits, and says how many are left", () => {
    render(<AdminVerifyTab />);
    const box = screen.getByLabelText("Verification code") as HTMLInputElement;
    const button = screen.getByRole("button", { name: "Check In" }) as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "12" } });
    expect(button.disabled).toBe(true);
    fireEvent.blur(box);
    expect(screen.getByRole("alert").textContent).toContain("2 more digits to go");

    fireEvent.change(box, { target: { value: "123" } });
    expect(screen.getByRole("alert").textContent).toContain("1 more digit to go");

    fireEvent.change(box, { target: { value: "1234" } });
    expect(button.disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("never lets a non-digit into the field, and never more than four", () => {
    render(<AdminVerifyTab />);
    const box = screen.getByLabelText("Verification code") as HTMLInputElement;

    fireEvent.change(box, { target: { value: "ab12cd34ef" } });
    expect(box.value).toBe("1234");
    fireEvent.change(box, { target: { value: "98765" } });
    expect(box.value).toBe("9876");
    fireEvent.change(box, { target: { value: " 1 2 3 4 " } });
    expect(box.value).toBe("1234");
  });

  it("reports what the check-in actually did, and keeps it on screen", async () => {
    vi.mocked(api.verifyBooking).mockResolvedValue({ msg: "Checked in. Fueling has started.", started: true } as never);
    render(<AdminVerifyTab />);

    fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "4821" } });
    fireEvent.click(screen.getByRole("button", { name: "Check In" }));

    const outcome = await screen.findByTestId("verify-outcome");
    expect(outcome.textContent).toContain("fuelling started");
    expect(outcome.textContent).toContain("Checked in. Fueling has started.");
  });

  it("says the car is waiting when the nozzle is busy", async () => {
    vi.mocked(api.verifyBooking).mockResolvedValue({ msg: "Checked in. Waiting for the nozzle.", queued: true } as never);
    render(<AdminVerifyTab />);

    fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "4821" } });
    fireEvent.click(screen.getByRole("button", { name: "Check In" }));

    expect((await screen.findByTestId("verify-outcome")).textContent).toContain("waiting for the nozzle");
  });
});
