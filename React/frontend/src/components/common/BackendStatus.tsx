import { useBackendHealth } from "@/hooks/useBackendHealth";
import { serverBase } from "@/services/api/serverAddress";

/**
 * "Backend Connected ✓" / "Backend Disconnected ✕".
 *
 * A demonstrator's chip: it says, at a glance and without opening anything,
 * whether the app is actually talking to the server. It reports the REAL
 * connection (hooks/useBackendHealth.ts pings /api/health and re-checks when
 * the network comes back) -- it is never set by hand and never faked, which
 * is the whole point of showing it.
 *
 * Tapping it checks again immediately.
 */
export default function BackendStatus({ compact = false }: { compact?: boolean }) {
  const { online, reachable, checking, checked, lastOkAt, check } = useBackendHealth();
  const connected = online && reachable;
  // Before the first answer the honest state is "asking", not "connected".
  const unknown = !checked;

  const title = unknown
    ? "Checking the connection to FuelMart…"
    : connected
    ? `Connected to ${serverBase() || "this server"}${lastOkAt ? ` · last reply ${lastOkAt.toLocaleTimeString("en-IN")}` : ""}`
    : online
      ? `No reply from ${serverBase() || "the server"}`
      : "This device has no network";

  return (
    <button
      type="button"
      onClick={() => void check()}
      title={title}
      aria-label={title}
      aria-live="polite"
      data-testid="backend-status"
      className="inline-flex items-center gap-1.5 rounded-full font-bold"
      style={{
        padding: compact ? "4px 9px" : "5px 11px",
        fontSize: compact ? 10.5 : 11.5,
        border: "1px solid",
        borderColor: unknown ? "var(--border)" : connected ? "var(--status-good, #10b981)" : "var(--status-bad, #ef4444)",
        color: unknown ? "var(--muted)" : connected ? "var(--status-good, #10b981)" : "var(--status-bad, #ef4444)",
        background: unknown ? "transparent" : connected ? "rgba(16,185,129,.12)" : "rgba(239,68,68,.12)",
        opacity: checking ? 0.65 : 1,
        whiteSpace: "nowrap",
      }}
    >
      <span
        className="rounded-full"
        style={{
          width: 7,
          height: 7,
          background: "currentColor",
          animation: connected || unknown ? "pulse 2s ease-in-out infinite" : undefined,
        }}
        aria-hidden
      />
      {unknown
        ? compact
          ? "Backend…"
          : "Checking backend…"
        : compact
          ? connected
            ? "Backend ✓"
            : "Backend ✕"
          : connected
            ? "Backend Connected ✓"
            : "Backend Disconnected ✕"}
    </button>
  );
}
