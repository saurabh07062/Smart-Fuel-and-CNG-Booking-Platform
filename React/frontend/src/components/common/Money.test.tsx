import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Money, { MASK } from "./Money";

describe("Hidden income amounts", () => {
  it("is masked until its eye is tapped, and masked again on a second tap", () => {
    render(<Money label="today's revenue">₹25,450.00</Money>);
    expect(screen.getByTestId("money").textContent).toContain(MASK);
    expect(screen.queryByText("₹25,450.00")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show today's revenue" }));
    expect(screen.getByText("₹25,450.00")).toBeTruthy();
    expect(screen.getByTestId("money").textContent).not.toContain(MASK);

    fireEvent.click(screen.getByRole("button", { name: "Hide today's revenue" }));
    expect(screen.getByTestId("money").textContent).toContain(MASK);
    expect(screen.queryByText("₹25,450.00")).toBeNull();
  });

  it("each amount has its own eye: showing one leaves the others hidden", () => {
    render(
      <>
        <Money label="today's revenue">₹100.00</Money>
        <Money label="this month's revenue">₹200.00</Money>
        <Money label="all-time revenue">₹300.00</Money>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show this month's revenue" }));
    expect(screen.getByText("₹200.00")).toBeTruthy();
    expect(screen.queryByText("₹100.00")).toBeNull();
    expect(screen.queryByText("₹300.00")).toBeNull();
    expect(screen.getAllByTestId("money-hidden")).toHaveLength(2);
  });

  it("the eye says which amount it is, for screen readers", () => {
    render(<Money label="awaiting collection">₹10.00</Money>);
    const eye = screen.getByRole("button", { name: "Show awaiting collection" });
    expect(eye.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(eye);
    expect(screen.getByRole("button", { name: "Hide awaiting collection" }).getAttribute("aria-pressed")).toBe("true");
  });
});
