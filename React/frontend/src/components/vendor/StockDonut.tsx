/**
 * A small circular stock level for one fuel: the ring fills with the
 * percentage of the tank that is still in it, in the tier's colour (the same
 * red / yellow / green the badge uses). Inline SVG, so it stays sharp and
 * needs no chart library.
 *
 * Nothing is computed here: `percent` and `tier` come from the server
 * (backend services/inventory/inventoryThreshold.js). Without a recorded tank
 * capacity there is no percentage, and the ring shows a muted dashed circle
 * instead of pretending to know the level.
 */
const TIER_COLOR: Record<string, string> = {
  out_of_stock: "var(--status-bad)",
  critical: "var(--status-bad)",
  low: "var(--status-warn)",
  normal: "var(--status-good)",
};

/** Fuel colours, matching the bars on the same card. */
const FUEL_COLOR: Record<string, string> = {
  petrol: "var(--fuel-petrol)",
  diesel: "var(--fuel-diesel)",
  cng: "var(--fuel-cng)",
};

export default function StockDonut({
  fuel,
  percent,
  tier,
  size = 46,
  label,
}: {
  fuel: string;
  /** 0-100, or null when the tank capacity is not recorded. */
  percent: number | null;
  tier: string;
  size?: number;
  /** Read out to screen readers, e.g. "Petrol stock". */
  label: string;
}) {
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const known = percent != null && Number.isFinite(percent);
  const pct = known ? Math.max(0, Math.min(100, Number(percent))) : 0;
  const colour = TIER_COLOR[tier] ?? FUEL_COLOR[fuel] ?? "var(--chart-4)";

  return (
    <span
      className="inline-flex flex-shrink-0"
      data-testid={`stock-donut-${fuel}`}
      role="img"
      aria-label={known ? `${label}: ${pct}% of tank` : `${label}: tank capacity not set`}
      title={known ? `${pct}% of tank capacity` : "Set the tank capacity to see the level"}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeDasharray={known ? undefined : "3 4"}
          className="vm-text-muted"
          opacity={known ? 0.18 : 0.45}
        />
        {known && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={colour}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${(pct / 100) * c} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ transition: "stroke-dasharray .35s ease" }}
          />
        )}
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          fill="currentColor"
          fontSize={known ? size * 0.28 : size * 0.34}
          fontWeight="700"
        >
          {known ? `${Math.round(pct)}%` : "—"}
        </text>
      </svg>
    </span>
  );
}
