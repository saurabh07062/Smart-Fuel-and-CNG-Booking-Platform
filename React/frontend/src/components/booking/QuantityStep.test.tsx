import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Choosing how much fuel: by quantity, or by amount.
 *
 * The point of these tests is that the amount mode is a REQUEST, not a
 * calculation the client gets to make. The litres on screen are labelled as
 * an estimate, and what the page would send is the rupees — the server
 * divides by the price it holds when the booking is written
 * (backend services/booking/fuelAmount.js). They also hold the older flow
 * exactly as it was, because it is the one everybody already uses.
 */

vi.mock("./FuelQueuePreview", () => ({ default: () => null }));

import QuantityStep from "./QuantityStep";
import { useBookingDraftStore } from "@/store/bookingDraftStore";

const draft = () => useBookingDraftStore.getState().draft;

beforeEach(() => {
  useBookingDraftStore.getState().reset();
  useBookingDraftStore.getState().patch({ fuelType: "Petrol", stationId: "st1" });
});

describe("by quantity (the existing flow)", () => {
  it("opens on the quantity picker, unchanged", () => {
    render(<QuantityStep unitPrice={100} />);

    expect(draft().bookBy).toBe("quantity");
    expect(screen.getByLabelText("Quantity in litres")).toBeTruthy();
    expect(screen.getByText("1–60 L")).toBeTruthy();
    // 5 L at ₹100 plus the ₹5 fee, in the app's own money format.
    expect(screen.getByText("INR 505.00")).toBeTruthy();
  });

  it("the stepper and the presets still set litres", async () => {
    const user = userEvent.setup();
    render(<QuantityStep unitPrice={100} />);

    await user.click(screen.getByRole("button", { name: "Increase quantity" }));
    expect(draft().quantity).toBe(6);

    await user.click(screen.getByRole("button", { name: "20 L" }));
    expect(draft().quantity).toBe(20);
    expect(screen.getByText("INR 2,005.00")).toBeTruthy();
  });
});

describe("by amount", () => {
  it("shows what the money buys, and says the figure is an estimate", async () => {
    const user = userEvent.setup();
    render(<QuantityStep unitPrice={104.5} />);

    await user.click(screen.getByRole("button", { name: /By amount/ }));
    expect(draft().bookBy).toBe("amount");

    await user.type(screen.getByLabelText("Amount in rupees to spend on fuel"), "1000");
    expect(draft().fuelAmount).toBe(1000);

    // 1000 / 104.5 = 9.5693… -> 9.57
    const preview = screen.getByTestId("amount-preview");
    expect(preview.textContent).toContain("9.57 L");
    expect(preview.textContent).toContain("₹104.5/L");
    expect(screen.getByText(/worked out at the station's price when you confirm/)).toBeTruthy();
  });

  it("the cost estimate follows the amount, fee included", async () => {
    const user = userEvent.setup();
    render(<QuantityStep unitPrice={100} />);

    await user.click(screen.getByRole("button", { name: /By amount/ }));
    await user.click(screen.getByRole("button", { name: "₹1000" }));

    expect(draft().fuelAmount).toBe(1000);
    expect(screen.getByText("10 Litres")).toBeTruthy();
    // "₹1000" appears twice on purpose -- as the preset that is now selected
    // and as the fuel budget in the cost estimate.
    expect(screen.getAllByText("₹1000").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("INR 1,005.00")).toBeTruthy(); // with the fee
  });

  it("says plainly when the station has no price to convert with", async () => {
    const user = userEvent.setup();
    render(<QuantityStep unitPrice={null} />);

    await user.click(screen.getByRole("button", { name: /By amount/ }));
    await user.type(screen.getByLabelText("Amount in rupees to spend on fuel"), "500");

    expect(screen.getByTestId("amount-preview").textContent).toMatch(/has not published a price/);
    // No invented litres, and no total.
    expect(screen.queryByText(/^5 L$/)).toBeNull();
  });

  it("switching modes does not turn litres into rupees", async () => {
    const user = userEvent.setup();
    render(<QuantityStep unitPrice={100} />);

    await user.click(screen.getByRole("button", { name: "20 L" }));
    await user.click(screen.getByRole("button", { name: /By amount/ }));

    // The amount box starts empty rather than pre-filled with "20".
    expect(draft().fuelAmount).toBe(0);
    expect((screen.getByLabelText("Amount in rupees to spend on fuel") as HTMLInputElement).value).toBe("");

    // And going back keeps the litres they had chosen.
    await user.click(screen.getByRole("button", { name: /By quantity/ }));
    expect(draft().quantity).toBe(20);
  });

  it("CNG is measured in kg, in both modes", async () => {
    const user = userEvent.setup();
    useBookingDraftStore.getState().patch({ fuelType: "CNG" });
    render(<QuantityStep unitPrice={80} />);

    expect(screen.getByLabelText("Quantity in kilograms")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /By amount/ }));
    await user.click(screen.getByRole("button", { name: "₹200" }));
    expect(screen.getByTestId("amount-preview").textContent).toContain("2.5 kg");
  });
});
