import type { ReactNode } from "react";
import Loader from "@/components/common/Loader";
import { vendorStatusVisual } from "@/utils/consoleFormat";

/**
 * The small shared console components, ported from js/console-ui.js.
 * All class names come from the existing console.css.
 */

/** vmStatCard(). `tone` maps to console.css's `.i-<tone>` icon tints. */
export function ConsoleStat({
  label,
  value,
  icon,
  tone = "blue",
}: {
  label: string;
  value: ReactNode;
  icon: string;
  tone?: "red" | "green" | "amber" | "slate" | "blue";
}) {
  return (
    <div className="vm-stat">
      <span className={`vm-stat-icon i-${tone}`}>
        <i className={`fas ${icon}`} aria-hidden />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="vm-stat-value">{value === undefined || value === null ? 0 : value}</div>
        <div className="vm-stat-label">{label}</div>
      </div>
    </div>
  );
}

/** vmStatusBadge(). Unknown statuses fall back to "Pending", as in the original. */
export function VendorStatusBadge({ status }: { status?: string }) {
  const s = vendorStatusVisual(status);
  return (
    <span className={`vm-status ${s.cls}`}>
      <i className={`fas ${s.icon}`} aria-hidden />
      {s.label}
    </span>
  );
}

/** The console's full-panel empty state. */
export function ConsoleEmpty({
  icon,
  title,
  text,
  action,
}: {
  icon: string;
  title: string;
  text?: string;
  action?: ReactNode;
}) {
  return (
    <div className="vm-empty">
      <i className={`fas ${icon}`} aria-hidden />
      <h3 className="vm-empty-title">{title}</h3>
      {text && <p className="vm-empty-text">{text}</p>}
      {action}
    </div>
  );
}

/** The spinner every console tab shows while its own fetch is in flight. */
export function ConsoleLoading({ label = "Loading…" }: { label?: string }) {
  // A second spinner with its own markup was the console's copy of the one in
  // components/common/Loader.tsx -- same shape, different size, and no
  // role="status", so a screen reader was told nothing was happening. Eight
  // console screens now draw the shared one.
  return <Loader full label={label} />;
}

/** The console's error state, with the retry the original offered. */
export function ConsoleError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-[60vh] text-center">
      <i className="fas fa-exclamation-triangle text-5xl text-red-400 mb-4" aria-hidden />
      <h3 className="text-xl font-bold vm-text mb-2">Error</h3>
      <p className="vm-text-muted mb-4">{message}</p>
      <button onClick={onRetry} className="vm-btn vm-btn-primary">
        <i className="fas fa-redo mr-2" aria-hidden /> Retry
      </button>
    </div>
  );
}

/** The console's panel wrapper (`.vm-panel` + head + body). */
export function ConsolePanel({
  title,
  icon,
  action,
  padded = true,
  children,
}: {
  title: string;
  icon?: string;
  action?: ReactNode;
  padded?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="vm-panel">
      <div className="vm-panel-head">
        <h3 className="vm-panel-title">
          {icon && <i className={`fas ${icon}`} aria-hidden />} {title}
        </h3>
        {action}
      </div>
      <div className={`vm-panel-body${padded ? " is-padded" : ""}`}>{children}</div>
    </div>
  );
}
