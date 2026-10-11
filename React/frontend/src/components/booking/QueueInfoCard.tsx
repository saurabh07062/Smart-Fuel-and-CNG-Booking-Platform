/**
 * Vehicles ahead, queue position, expected wait and estimated service time --
 * exactly as the server computed them (backend services/queue/queueInfo.js,
 * and the booking preview's `you`). Nothing is worked out here.
 *
 * Used on the slot step, the confirm step, the booking page, the booking
 * cards and (compact) in the vendor's bookings list, so every screen shows
 * the same figures.
 */
export interface QueueInfo {
  vehicleCountAhead: number;
  queuePosition: number;
  expectedWaitingSeconds: number;
  expectedWaitingTime: string;
  estimatedStartTime: string | null;
}

export const vehiclesAheadText = (n: number) => (n === 0 ? "No vehicles ahead" : `${n} vehicle${n === 1 ? "" : "s"} ahead`);

export default function QueueInfoCard({
  info,
  compact = false,
  className = "",
}: {
  info: QueueInfo | null | undefined;
  compact?: boolean;
  className?: string;
}) {
  if (!info) return null;

  const rows: [string, string, string][] = [
    ["fa-car-side", vehiclesAheadText(info.vehicleCountAhead), "Vehicles ahead"],
    ["fa-hashtag", `#${info.queuePosition}`, "Queue position"],
    ["fa-stopwatch", info.expectedWaitingTime, "Expected waiting"],
    ["fa-clock", info.estimatedStartTime ?? "—", "Estimated service"],
  ];

  if (compact) {
    return (
      <span className={`text-[11px] inline-flex flex-wrap gap-x-1.5 ${className}`} data-testid="queue-info">
        <span>#{info.queuePosition}</span>
        <span>· {vehiclesAheadText(info.vehicleCountAhead)}</span>
        <span>· wait {info.expectedWaitingTime}</span>
        {info.estimatedStartTime && <span>· ~{info.estimatedStartTime}</span>}
      </span>
    );
  }

  return (
    <div
      className="grid grid-cols-2 gap-2"
      data-testid="queue-info"
      role="group"
      aria-label="Your place in the queue"
    >
      {rows.map(([icon, value, label]) => (
        <div
          key={label}
          className="rounded-xl p-3"
          style={{ background: "var(--primary-light)", border: "1px solid var(--border)" }}
        >
          <p className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: "var(--muted)" }}>
            <i className={`fas ${icon}`} style={{ color: "var(--primary)" }} aria-hidden /> {label}
          </p>
          <p className="text-[15px] font-bold mt-0.5" style={{ color: "var(--text)" }}>
            {value}
          </p>
        </div>
      ))}
    </div>
  );
}
