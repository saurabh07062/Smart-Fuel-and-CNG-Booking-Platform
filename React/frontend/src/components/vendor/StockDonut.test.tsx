import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import StockDonut from "./StockDonut";

describe("Stock ring", () => {
  it("shows the server's percentage and says what it means", () => {
    render(<StockDonut fuel="petrol" percent={64} tier="normal" label="Petrol stock" />);
    const ring = screen.getByTestId("stock-donut-petrol");
    expect(ring.textContent).toContain("64%");
    expect(ring.getAttribute("aria-label")).toBe("Petrol stock: 64% of tank");
  });

  it("without a recorded tank capacity it shows a dash, not a made-up level", () => {
    render(<StockDonut fuel="diesel" percent={null} tier="capacity_unset" label="Diesel stock" />);
    const ring = screen.getByTestId("stock-donut-diesel");
    expect(ring.textContent).toContain("—");
    expect(ring.textContent).not.toContain("%");
    expect(ring.getAttribute("aria-label")).toBe("Diesel stock: tank capacity not set");
    // Only the muted dashed track is drawn.
    expect(ring.querySelectorAll("circle")).toHaveLength(1);
  });

  it("the ring takes the tier's colour, and fills by the percentage", () => {
    const { container, rerender } = render(<StockDonut fuel="petrol" percent={100} tier="normal" label="Petrol stock" />);
    const full = container.querySelectorAll("circle")[1];
    // The TOKEN, not a hex. The colour itself belongs to the theme and changes
    // between light and dark; what this ring must get right is that a healthy
    // tank is drawn in the "good" colour, whatever that currently is.
    expect(full.getAttribute("stroke")).toBe("var(--status-good)");
    const [drawn, total] = (full.getAttribute("stroke-dasharray") ?? "").split(" ").map(Number);
    expect(drawn).toBeCloseTo(total, 5);

    rerender(<StockDonut fuel="petrol" percent={8} tier="critical" label="Petrol stock" />);
    const low = container.querySelectorAll("circle")[1];
    expect(low.getAttribute("stroke")).toBe("var(--status-bad)");
    const [part, whole] = (low.getAttribute("stroke-dasharray") ?? "").split(" ").map(Number);
    expect(part / whole).toBeCloseTo(0.08, 2);
  });

  it("an out-of-stock tank draws an empty ring, not a full one", () => {
    const { container } = render(<StockDonut fuel="diesel" percent={0} tier="out_of_stock" label="Diesel stock" />);
    const arc = container.querySelectorAll("circle")[1];
    expect(Number((arc.getAttribute("stroke-dasharray") ?? "").split(" ")[0])).toBe(0);
    expect(screen.getByTestId("stock-donut-diesel").textContent).toContain("0%");
  });
});
