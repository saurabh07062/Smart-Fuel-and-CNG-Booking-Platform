import type { ReactNode } from "react";
import StatCard from "@/components/common/StatCard";

/**
 * Small shared pieces of the vendor console: stat card, fuel bar, empty
 * state, and the section panel. All ported from vendorPanel.js's helpers.
 */

/**
 * The colour names the vendor tabs pass, translated into what a figure MEANS.
 *
 * The call sites say "emerald", "cyan", "indigo" — decorative names that tell
 * a reader nothing and dark mode nothing. Rather than edit forty call sites,
 * they are mapped here to the four semantic tones the shared card understands,
 * so a vendor figure and an admin figure become the same object on screen
 * (components/common/StatCard.tsx).
 *
 * Totals and money read as neutral; anything owed or waiting reads as a
 * warning; anything confirmed reads as good.
 */
const TONE_FOR: Record<string, "primary" | "good" | "warn" | "bad"> = {
  blue: "primary",
  cyan: "primary",
  indigo: "primary",
  emerald: "good",
  green: "good",
  yellow: "warn",
  orange: "warn",
  amber: "warn",
  red: "bad",
};

interface StatProps {
  label: string;
  value: ReactNode;
  icon: string;
  /**
   * A legacy colour name from the call sites ("emerald", "cyan", …), mapped
   * to a semantic tone by TONE_FOR. Plainly `string`: `keyof` would drag a
   * symbol into the union and an unknown name falls back to "primary" anyway.
   */
  color?: string;
}

/**
 * renderVendorStatCard().
 *
 * The original built its classes by splitting a string and interpolating
 * `bg-${c.split(" ")[0]}` — which produced `bg-blue-500/20 vm-accent-text`
 * as a CLASS NAME, i.e. `bg-bg-blue-500/20`. The colours are written out
 * here instead, so the tint actually applies; the intended palette is
 * unchanged.
 */
export function VendorStatCard({ label, value, icon, color = "blue" }: StatProps) {
  // Still exported under its own name, because forty call sites use it. What
  // changed is that it no longer draws anything itself.
  return <StatCard label={label} value={value} icon={icon} tone={TONE_FOR[color] ?? "primary"} />;
}

const BAR_COLORS: Record<string, string> = {
  orange: "bg-orange-500",
  indigo: "bg-indigo-500",
  emerald: "bg-emerald-500",
};

interface FuelBarProps {
  label: string;
  current: number;
  /** Tank capacity; null/undefined when none is recorded. */
  max?: number | null;
  color: keyof typeof BAR_COLORS | string;
  unit?: string;
}

/** renderVendorFuelBar(). */
export function VendorFuelBar({ label, current, max, color, unit = "L" }: FuelBarProps) {
  // Without a recorded tank capacity there is nothing honest to fill a bar
  // against, so only the stock figure is shown.
  const hasMax = typeof max === "number" && max > 0;
  const pct = hasMax ? Math.min((current / max) * 100, 100) : 0;
  return (
    <div>
      <div className="flex justify-between items-end mb-2">
        <span className="text-sm font-bold">{label}</span>
        <span className="text-[11px] font-bold vm-text-muted">
          <span className="vm-text">
            {current}
            {unit}
          </span>{" "}
          {hasMax ? (
            <>
              / {max}
              {unit}
            </>
          ) : (
            "· capacity not set"
          )}
        </span>
      </div>
      <div className="h-2 w-full vm-bg-ground rounded-full overflow-hidden">
        {hasMax && (
          <div
            className={`h-full ${BAR_COLORS[color] ?? "bg-blue-500"} rounded-full transition-all`}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}

interface EmptyProps {
  icon: string;
  title?: string;
  message: string;
  action?: ReactNode;
}

/** The console's repeated "nothing here yet" block. */
export function VendorEmpty({ icon, title, message, action }: EmptyProps) {
  return (
    <div className="vm-bg-surface rounded-2xl border vm-border p-12 text-center">
      <i className={`fas ${icon} text-5xl vm-text-muted mb-4`} aria-hidden />
      {title && <h3 className="text-xl font-bold vm-text mb-2">{title}</h3>}
      <p className="vm-text-muted mb-4">{message}</p>
      {action}
    </div>
  );
}

/**
 * The "click below to load" state several tabs open in.
 *
 * Kept because it is the original's behaviour, but it now only appears when
 * a load genuinely produced nothing -- the store sets `loading` before the
 * request, so this can no longer flash while data is already on its way.
 */
export function VendorLoadPrompt({
  icon,
  title,
  message,
  label,
  onLoad,
}: {
  icon: string;
  title: string;
  message: string;
  label: string;
  onLoad: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-[60vh] text-center">
      <i className={`fas ${icon} text-5xl vm-text-muted mb-4`} aria-hidden />
      <h3 className="text-xl font-bold vm-text mb-2">{title}</h3>
      <p className="vm-text-muted mb-4">{message}</p>
      <button onClick={onLoad} className="vm-btn vm-btn-primary">
        <i className="fas fa-download mr-2" aria-hidden /> {label}
      </button>
    </div>
  );
}

/** The console's section heading row. */
export function VendorHeading({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-6">
      <h2 className="vm-stat-value" style={{ fontSize: 22 }}>
        {title}
      </h2>
      {action}
    </div>
  );
}
