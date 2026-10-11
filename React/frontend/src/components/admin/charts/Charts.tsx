/**
 * The admin console's charts: a line, a bar column set and a donut, drawn as
 * inline SVG. No chart library, no new dependency, and they inherit the
 * console's dark palette.
 *
 * Every chart takes figures the server already computed and draws them as
 * they are -- nothing is smoothed, extrapolated or invented. An empty series
 * renders the "no data yet" note instead of an empty frame.
 */
import { useState, type ReactNode } from "react";
import Lightbox from "@/components/common/Lightbox";

export interface Point {
  label: string;
  value: number;
}

const EMPTY = (
  <p className="text-[11px] vm-text-muted py-6 text-center">No data yet.</p>
);

/** Panel around a chart: title, optional note on the right, then the chart. */
export function ChartCard({
  title,
  icon,
  note,
  subtitle,
  footer,
  children,
  testId,
  expandable = true,
}: {
  title: string;
  icon: string;
  note?: ReactNode;
  /** One line under the title saying what the panel is showing. */
  subtitle?: string;
  /** The panel's closing line: the reading the chart above leads to. */
  footer?: ReactNode;
  children: ReactNode;
  testId?: string;
  /**
   * Let the panel open its chart full screen.
   *
   * A chart in a dashboard grid is a few hundred pixels wide, which is fine
   * for the shape of a trend and useless for reading a particular week --
   * and on a phone it is smaller still. On by default: there is no chart in
   * this product that is worse for being bigger.
   */
  expandable?: boolean;
}) {
  const [zoomed, setZoomed] = useState(false);

  return (
    <section className="vm-panel" style={{ padding: 16 }} data-testid={testId}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="vm-eyebrow flex items-center gap-2">
          <span
            className="inline-flex items-center justify-center rounded-lg"
            style={{ width: 26, height: 26, background: "var(--z-accent-soft)", color: "var(--z-accent)" }}
            aria-hidden
          >
            <i className={`fas ${icon}`} style={{ fontSize: 11 }} />
          </span>
          <span>
            {title}
            {subtitle && (
              <span className="block text-[10.5px] font-medium tracking-normal normal-case vm-text-muted mt-0.5">
                {subtitle}
              </span>
            )}
          </span>
        </h3>
        <span className="flex items-center gap-2">
          {note && <span className="text-[11px] vm-text-muted">{note}</span>}
          {expandable && (
            <button
              type="button"
              className="ds-chart-expand"
              onClick={() => setZoomed(true)}
              aria-label={`Enlarge: ${title}`}
              data-testid={testId ? `${testId}-expand` : undefined}
            >
              <i className="fas fa-expand" aria-hidden />
            </button>
          )}
        </span>
      </div>
      {children}
      {footer && (
        <div
          className="flex items-center justify-between gap-3 flex-wrap text-[11px] vm-text-muted mt-3 pt-3"
          style={{ borderTop: "1px solid var(--z-line)" }}
        >
          {footer}
        </div>
      )}

      {/* The same chart, given the room to be read. It is rendered twice
          rather than moved, so the panel underneath does not collapse while
          the viewer is open. */}
      <Lightbox open={zoomed} onClose={() => setZoomed(false)} title={title}>
        <div className="ds-chart-zoom">
          {subtitle && <p className="ds-chart-zoom-sub">{subtitle}</p>}
          {children}
          {footer && <div className="ds-chart-zoom-foot">{footer}</div>}
        </div>
      </Lightbox>
    </section>
  );
}

/**
 * A line with a soft fill under it: a trend over time (months, days).
 * `format` renders the value in the point labels and the peak marker.
 */
export function LineChart({
  points,
  colour = "#6366f1",
  height = 150,
  format = (v: number) => String(v),
  ariaLabel,
}: {
  points: Point[];
  colour?: string;
  height?: number;
  format?: (v: number) => string;
  ariaLabel: string;
}) {
  if (points.length === 0) return EMPTY;

  // One reading cannot make a line -- joining it to an invented zero would
  // draw a rise nobody measured. It is still worth drawing, though: one
  // column, at full height, labelled with its own month.
  if (points.length === 1) {
    const only = points[0];
    return (
      <div data-testid="line-chart-single">
        <div
          className="flex items-end justify-center"
          style={{ height }}
          role="img"
          aria-label={`${ariaLabel}: ${only.label} ${format(only.value)}`}
        >
          {/* The figure is already the headline above this chart, so the
              column carries only its month -- printing the amount a third
              time on one panel is noise, not emphasis. */}
          <div className="flex flex-col items-center gap-1.5" style={{ width: 72 }}>
            <div
              className="w-full"
              style={{
                height: height - 26,
                // color-mix, not "${colour}55": the caller may pass a CSS
                // variable, and a hex-suffix on var(--x) is not a colour.
                background: `linear-gradient(180deg, ${colour} 0%, color-mix(in srgb, ${colour} 35%, transparent) 100%)`,
                borderRadius: 12,
                boxShadow: `0 0 26px color-mix(in srgb, ${colour} 24%, transparent)`,
              }}
            />
            <span className="text-[10px] vm-text-muted">{only.label}</span>
          </div>
        </div>
        <p className="text-[10.5px] vm-text-muted text-center mt-1">
          One month of sales so far — the line starts once there are two.
        </p>
      </div>
    );
  }

  const w = 320;
  const h = height;
  const padX = 6;
  const padY = 14;
  const max = Math.max(...points.map((p) => p.value), 1);
  const stepX = points.length > 1 ? (w - padX * 2) / (points.length - 1) : 0;
  const x = (i: number) => padX + i * stepX;
  const y = (v: number) => padY + (1 - v / max) * (h - padY * 2);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${h - padY} L${x(0).toFixed(1)},${h - padY} Z`;
  const peak = points.reduce((best, p, i) => (p.value > points[best].value ? i : best), 0);
  // One gradient per chart instance: two charts on a page must not share an id.
  const gradientId = `trend-${ariaLabel.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;

  return (
    <div data-testid="line-chart">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        width="100%"
        height={h}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${ariaLabel}: ${points.map((p) => `${p.label} ${format(p.value)}`).join(", ")}`}
      >
        <defs>
          {/* Fading the fill downwards keeps the eye on the line itself,
              which is the part that carries the trend. */}
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colour} stopOpacity={0.34} />
            <stop offset="100%" stopColor={colour} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={w} y1={padY + f * (h - padY * 2)} y2={padY + f * (h - padY * 2)} stroke="currentColor" opacity={0.08} />
        ))}
        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} fill="none" stroke={colour} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {points.map((p, i) => (
          <circle key={p.label} cx={x(i)} cy={y(p.value)} r={i === peak ? 3.5 : 2.5} fill={i === peak ? colour : "var(--z-bg, #111)"} stroke={colour} strokeWidth={1.5} />
        ))}
      </svg>
      <div className="flex justify-between mt-1">
        {points.map((p, i) => (
          <span key={p.label} className={`text-[10px] ${i === peak ? "vm-text font-bold" : "vm-text-muted"}`}>
            {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Vertical bars: counts across a category (hours of the day, fuels). */
export function BarChart({
  points,
  colour = "#f97316",
  height = 140,
  ariaLabel,
}: {
  points: Point[];
  colour?: string;
  height?: number;
  ariaLabel: string;
}) {
  if (points.length === 0) return EMPTY;
  const max = Math.max(...points.map((p) => p.value), 1);

  return (
    <div data-testid="bar-chart">
      <div
        className="flex items-end gap-1"
        style={{ height }}
        role="img"
        aria-label={`${ariaLabel}: ${points.map((p) => `${p.label} ${p.value}`).join(", ")}`}
      >
        {points.map((p) => {
          const isPeak = p.value === max && p.value > 0;
          return (
            <div key={p.label} className="flex-1 flex flex-col items-center justify-end h-full gap-1" title={`${p.label}: ${p.value}`}>
              <span className={`text-[9.5px] ${isPeak ? "font-bold" : "vm-text-muted"}`} style={isPeak ? { color: colour } : undefined}>
                {p.value > 0 ? p.value : ""}
              </span>
              <div
                className="w-full"
                style={{
                  // A bar wider than it is tall stops reading as a bar; cap
                  // it and let the column keep the spacing.
                  maxWidth: 64,
                  height: `${Math.max(p.value > 0 ? 6 : 3, (p.value / max) * (height - 30))}px`,
                  // The busiest hour is the answer the chart is asked for, so
                  // it is the only bar drawn at full strength.
                  background: p.value > 0 ? colour : "currentColor",
                  opacity: p.value > 0 ? (isPeak ? 1 : 0.45) : 0.12,
                  borderRadius: 7,
                  boxShadow: isPeak
                    ? `0 0 18px color-mix(in srgb, ${colour} 34%, transparent), 0 0 0 1px color-mix(in srgb, ${colour} 40%, transparent)`
                    : undefined,
                  transition: "height .25s ease",
                }}
              />
              <span className="text-[9px] vm-text-muted whitespace-nowrap">{p.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A ring split by share, with the total in the middle. */
export function DonutChart({
  slices,
  total,
  centreLabel,
  size = 132,
  ariaLabel,
  layout = "row",
}: {
  slices: Array<{ label: string; value: number; colour: string }>;
  total?: number;
  centreLabel: string;
  size?: number;
  ariaLabel: string;
  /** "row" (default) puts the legend beside the ring; "stack" centres both. */
  layout?: "row" | "stack";
}) {
  const sum = total ?? slices.reduce((t, s) => t + s.value, 0);
  // A ring, not a doughnut wall: thin enough to read the number inside it.
  const stroke = Math.max(10, Math.round(size * 0.1));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div
      className={
        layout === "stack"
          ? "flex flex-col items-center gap-3"
          : "flex items-center gap-4 flex-wrap"
      }
      data-testid="donut-chart"
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${ariaLabel}: ${slices.map((s) => `${s.label} ${s.value}`).join(", ")}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} opacity={0.12} />
        {sum > 0 &&
          slices
            .filter((s) => s.value > 0)
            .map((s) => {
              const len = (s.value / sum) * c;
              const dash = <circle
                key={s.label}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.colour}
                strokeWidth={stroke}
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-offset}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              />;
              offset += len;
              return dash;
            })}
        <text x="50%" y="46%" textAnchor="middle" dominantBaseline="central" fill="currentColor" fontSize={size * 0.23} fontWeight="700">
          {sum}
        </text>
        <text x="50%" y="64%" textAnchor="middle" dominantBaseline="central" fill="currentColor" opacity={0.55} fontSize={size * 0.095} letterSpacing={0.4}>
          {centreLabel}
        </text>
      </svg>
      <ul className={`text-[11px] ${layout === "stack" ? "flex flex-wrap justify-center gap-x-4 gap-y-1" : "space-y-1 min-w-[120px]"}`}>
        {slices.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: s.colour }} aria-hidden />
            <span className={`vm-text-muted ${layout === "stack" ? "" : "flex-1"}`}>{s.label}</span>
            <span className="font-bold">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Money over a handful of periods: one column each, the amount above it and a
 * rupee scale down the left.
 *
 * A line needs enough points to have a shape; five weeks of a month do not,
 * and comparing five amounts is what the reader is actually doing. So this is
 * a column chart with the axis a money chart needs -- without it, "tall bar"
 * means nothing.
 */
export function MoneyColumns({
  points,
  colour = "var(--z-accent)",
  height = 170,
  format,
  ariaLabel,
  onSelect,
  selected,
}: {
  points: Point[];
  colour?: string;
  height?: number;
  /** Renders the amount above each column and on the axis. */
  format: (v: number) => string;
  ariaLabel: string;
  /**
   * Called with a period's label when its column or its name is pressed.
   * Given one, every column becomes a button; without it the chart is a
   * picture, as it was.
   */
  onSelect?: (point: Point) => void;
  /** The label currently picked out, so the caller owns the selection. */
  selected?: string | null;
}) {
  if (points.length === 0) return EMPTY;

  const max = Math.max(...points.map((p) => p.value), 1);
  // A round ceiling, so the axis reads 0 / 2.5K / 5K rather than 0 / 2,371.
  const step = niceStep(max / 4);
  const top = Math.max(step * 4, step);
  const ticks = [4, 3, 2, 1, 0].map((i) => i * step);
  const plot = height - 26; // room for the labels under the columns

  return (
    <div data-testid="money-columns">
      <div className="flex gap-3">
        <div className="flex flex-col justify-between text-[10px] vm-text-muted" style={{ height: plot }}>
          {ticks.map((t) => (
            <span key={t}>{format(t)}</span>
          ))}
        </div>

        <div
          className="flex-1 flex items-end gap-2 sm:gap-4 relative"
          style={{ height: plot }}
          role="img"
          aria-label={`${ariaLabel}: ${points.map((p) => `${p.label} ${format(p.value)}`).join(", ")}`}
        >
          {/* The gridlines the axis labels name. */}
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute left-0 right-0"
              style={{ bottom: `${(t / top) * 100}%`, borderTop: "1px solid currentColor", opacity: 0.08 }}
              aria-hidden
            />
          ))}

          {points.map((p) => {
            const isPeak = p.value === max && p.value > 0;
            const isPicked = selected === p.label;
            const Column = onSelect ? "button" : "div";
            return (
              <Column
                key={p.label}
                {...(onSelect
                  ? {
                      type: "button" as const,
                      onClick: () => onSelect(p),
                      "aria-pressed": isPicked,
                      "aria-label": `${p.label}: ${format(p.value)}`,
                      title: `${p.label}: ${format(p.value)}`,
                    }
                  : {})}
                className="flex-1 flex flex-col items-center justify-end h-full gap-1.5 relative"
                style={onSelect ? { cursor: "pointer", background: "none", border: 0, padding: 0 } : undefined}
              >
                {p.value > 0 && (
                  <span className={`text-[10.5px] ${isPeak ? "font-bold" : "vm-text-muted"}`} style={isPeak ? { color: colour } : undefined}>
                    {format(p.value)}
                  </span>
                )}
                <div
                  className="w-full"
                  style={{
                    maxWidth: 74,
                    height: `${Math.max(p.value > 0 ? 6 : 3, (p.value / top) * (plot - 22))}px`,
                    background:
                      p.value > 0
                        ? `linear-gradient(180deg, ${colour} 0%, color-mix(in srgb, ${colour} 45%, transparent) 100%)`
                        : "currentColor",
                    opacity: p.value > 0 ? (isPicked || isPeak ? 1 : 0.62) : 0.12,
                    borderRadius: 10,
                    boxShadow: isPicked
                      ? `0 0 0 2px ${colour}, 0 0 26px color-mix(in srgb, ${colour} 35%, transparent)`
                      : isPeak
                        ? `0 0 26px color-mix(in srgb, ${colour} 30%, transparent)`
                        : undefined,
                    transition: "height .25s ease, box-shadow .2s ease, opacity .2s ease",
                  }}
                />
              </Column>
            );
          })}
        </div>
      </div>

      <div className="flex gap-2 sm:gap-4 mt-1.5" style={{ paddingLeft: 42 }}>
        {points.map((p) => {
          const isPicked = selected === p.label;
          const text = `flex-1 text-center text-[10px] whitespace-nowrap ${isPicked ? "font-bold" : "vm-text-muted"}`;
          // The label is the easier thing to hit on a small chart, so it is
          // the same button as the column above it.
          return onSelect ? (
            <button
              key={p.label}
              type="button"
              className={text}
              onClick={() => onSelect(p)}
              aria-pressed={isPicked}
              style={{ background: "none", border: 0, padding: "2px 0", cursor: "pointer", color: isPicked ? colour : undefined }}
            >
              {p.label}
            </button>
          ) : (
            <span key={p.label} className={text}>
              {p.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** 1, 2, 2.5 or 5 x a power of ten -- the steps a person reads an axis in. */
function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const n = raw / power;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * power;
}

/**
 * A histogram: how a measurement is DISTRIBUTED, not how it changed.
 *
 * Deliberately a separate component from BarChart even though both draw
 * columns, because they answer different questions and must not be confused:
 * a bar chart compares named things (Petrol vs Diesel), a histogram shows
 * where a continuous measurement piles up (most people wait 2–5 minutes, a
 * few wait twenty). The bars touch, which is the convention that tells a
 * reader the x-axis is continuous.
 *
 * `total` is required, not optional. A distribution drawn from nine readings
 * looks exactly as authoritative as one drawn from nine thousand, so the
 * sample size is printed beside it and a sample below `minSample` is refused
 * outright — an honest "not enough data yet" beats a confident wrong shape.
 */
export function Histogram({
  buckets,
  total,
  colour = "var(--chart-1)",
  height = 170,
  minSample = 5,
  unitLabel,
  ariaLabel,
}: {
  buckets: Array<{ label: string; count: number }>;
  total: number;
  colour?: string;
  height?: number;
  /** Below this many readings the shape is noise, so it is not drawn. */
  minSample?: number;
  /** What one reading is, e.g. "bookings". */
  unitLabel?: string;
  ariaLabel: string;
}) {
  if (total < minSample) {
    return (
      <p className="text-[11.5px] vm-text-muted py-6 text-center" data-testid="histogram-too-few">
        Not enough data yet — {total} {unitLabel ?? "readings"} so far. This needs at least {minSample} to show a
        meaningful shape.
      </p>
    );
  }

  const peak = Math.max(...buckets.map((b) => b.count), 1);

  return (
    <div
      role="img"
      aria-label={`${ariaLabel}: ${buckets.map((b) => `${b.label} ${b.count}`).join(", ")}`}
      data-testid="histogram"
    >
      <div className="flex items-end gap-[2px]" style={{ height }}>
        {buckets.map((b) => {
          const share = b.count / peak;
          return (
            <div key={b.label} className="flex-1 flex flex-col items-center justify-end gap-1 min-w-0">
              {/* The count above the column: a histogram is read for its
                  shape, but the exact figure is what gets quoted. */}
              <span className="text-[10px] font-bold" style={{ color: b.count > 0 ? "var(--text)" : "var(--muted)" }}>
                {b.count}
              </span>
              <div
                style={{
                  width: "100%",
                  // A zero bucket still draws a sliver, so the gap in the
                  // distribution is visible rather than absent.
                  height: Math.max(2, share * (height - 34)),
                  background:
                    b.count > 0
                      ? `linear-gradient(180deg, ${colour} 0%, color-mix(in srgb, ${colour} 40%, transparent) 100%)`
                      : "var(--border)",
                  borderRadius: "4px 4px 0 0",
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex gap-[2px] mt-1.5">
        {buckets.map((b) => (
          <span key={b.label} className="flex-1 text-center text-[9.5px] vm-text-muted min-w-0 truncate">
            {b.label}
          </span>
        ))}
      </div>
      <p className="text-[10.5px] vm-text-muted mt-2 text-center">
        {total.toLocaleString("en-IN")} {unitLabel ?? "readings"}
      </p>
    </div>
  );
}

/**
 * A heatmap: when something happens, across two dimensions.
 *
 * Day of week down, hour across. A line chart of bookings per hour averages
 * the week away and hides that Saturday morning is nothing like Tuesday
 * morning; a grid keeps both.
 *
 * Colour carries one variable only — intensity — so it is a single hue at
 * varying strength rather than a rainbow. A rainbow scale implies categories
 * where there is only "more" and "less".
 */
export function Heatmap({
  cells,
  rows,
  columns,
  formatColumn = (c) => String(c),
  ariaLabel,
  emptyNote = "No bookings in this period yet.",
}: {
  cells: Array<{ row: string; column: number; count: number }>;
  rows: string[];
  columns: number[];
  formatColumn?: (column: number) => string;
  ariaLabel: string;
  emptyNote?: string;
}) {
  const peak = Math.max(...cells.map((c) => c.count), 0);
  if (peak === 0) {
    return (
      <p className="text-[11.5px] vm-text-muted py-6 text-center" data-testid="heatmap-empty">
        {emptyNote}
      </p>
    );
  }

  const at = (row: string, column: number) => cells.find((c) => c.row === row && c.column === column)?.count ?? 0;

  return (
    <div className="overflow-x-auto" data-testid="heatmap">
      <table className="border-separate" style={{ borderSpacing: 2 }} aria-label={ariaLabel}>
        <thead>
          <tr>
            <th />
            {columns.map((c) => (
              <th key={c} className="text-[9px] vm-text-muted font-semibold pb-1" style={{ minWidth: 22 }}>
                {formatColumn(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <th scope="row" className="text-[10px] vm-text-muted font-semibold pr-2 text-right whitespace-nowrap">
                {r}
              </th>
              {columns.map((c) => {
                const count = at(r, c);
                const share = count / peak;
                return (
                  <td
                    key={c}
                    title={`${r} ${formatColumn(c)} — ${count} booking${count === 1 ? "" : "s"}`}
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 4,
                      // One hue, strength carries the number. An empty cell is
                      // the surface colour, not a pale version of the hue, so
                      // "none" and "a few" never look alike.
                      background:
                        count === 0
                          ? "var(--card2)"
                          : `color-mix(in srgb, var(--chart-1) ${Math.round(14 + share * 86)}%, transparent)`,
                    }}
                  >
                    <span className="sr-only">{`${r} ${formatColumn(c)}: ${count}`}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
