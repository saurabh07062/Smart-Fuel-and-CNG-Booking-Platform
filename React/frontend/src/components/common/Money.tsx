import { useState, type ReactNode } from "react";

/** What a masked amount looks like. */
export const MASK = "₹ ••••••";

/**
 * One income figure with its own eye: masked by default, shown when that eye
 * is tapped and masked again on the next tap. Each amount is independent --
 * revealing this month's revenue must not reveal today's.
 *
 * Nothing here changes a number: the caller passes the value it already
 * formatted, and the server's figures are untouched.
 */
export default function Money({
  children,
  label,
  className = "",
  startShown = false,
}: {
  children: ReactNode;
  /** Names the amount for screen readers, e.g. "Today's Revenue". */
  label?: string;
  className?: string;
  /**
   * Start revealed. For the one headline figure a panel exists to show --
   * masking it leaves a panel titled "Revenue" with no revenue in it. Its eye
   * still hides it, and every other amount on the page stays masked.
   */
  startShown?: boolean;
}) {
  const [shown, setShown] = useState(startShown);
  const what = label ? ` ${label}` : " amount";

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`} data-testid="money">
      <span data-testid={shown ? "money-shown" : "money-hidden"}>{shown ? children : MASK}</span>
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        aria-label={`${shown ? "Hide" : "Show"}${what}`}
        aria-pressed={shown}
        title={`${shown ? "Hide" : "Show"}${what}`}
        className="opacity-70 hover:opacity-100 transition-opacity"
        style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", padding: 0, lineHeight: 1 }}
      >
        <i className={`fas ${shown ? "fa-eye-slash" : "fa-eye"} text-[0.75em]`} aria-hidden />
      </button>
    </span>
  );
}
