import type { ReactNode } from "react";

/**
 * One figure, labelled.
 *
 * Both consoles had their own: `VendorStatCard` in the vendor panel and an
 * inline `stat()` helper in the admin tabs, with different padding, different
 * value sizes and different colour names ("emerald", "cyan", "indigo") that
 * mapped to nothing in the token file. This is the shared one, built from
 * tokens, so a number means the same thing wherever it appears.
 *
 * Tones are SEMANTIC, not colours: `good`, `warn`, `bad`, `primary`. A caller
 * choosing "emerald" is choosing a colour and will be wrong in dark mode;
 * a caller choosing "good" is describing the number.
 */
export default function StatCard({
  label,
  value,
  icon,
  tone = "primary",
  hint,
  testId,
}: {
  label: ReactNode;
  value: ReactNode;
  /** Font Awesome name, e.g. "fa-wallet". */
  icon?: string;
  tone?: "primary" | "good" | "warn" | "bad";
  /** A line under the number: what it is measured over, or what it excludes. */
  hint?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="ds-stat" data-testid={testId}>
      {icon && (
        <span className={`ds-stat-icon is-${tone}`} aria-hidden>
          <i className={`fas ${icon}`} />
        </span>
      )}
      <div className="ds-stat-body">
        <p className="ds-stat-label">{label}</p>
        <p className="ds-stat-value">{value}</p>
        {hint && <p className="ds-stat-hint">{hint}</p>}
      </div>
    </div>
  );
}
