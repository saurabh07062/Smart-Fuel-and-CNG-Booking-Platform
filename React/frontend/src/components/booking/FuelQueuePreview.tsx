import { useEffect, useMemo, useRef, useState } from "react";
import { fetchQueuePreview, type QueuePreview } from "@/services/api/bookingApi";
import { toApiError } from "@/services/api/apiClient";
import { useResync, useSocketEvent, useWatchStation } from "@/hooks/useSocket";
import { SOCKET_EVENTS } from "@/services/socket/socketEvents";
import { coalesce } from "@/utils/coalesce";
import { useStationStore } from "@/store/stationStore";

interface Props {
  stationId: string | null | undefined;
  fuelType: string | null;
  quantity: number;
  date?: string | null;
  timeSlot?: string | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * How this fuel's nozzles are shared, from the station's own setup:
 * "Diesel has a dedicated nozzle for online bookings and a separate nozzle for walk-in customers."
 */
export function nozzleNote(fuel: string, setup?: { total: number; online: number } | null): string {
  if (!setup || !(setup.total > 0)) return `${fuel} has its own nozzle, shared by online bookings and walk-in customers.`;
  const online = Math.max(0, Math.min(setup.online, setup.total));
  const walkIn = setup.total - online;
  if (online > 0 && walkIn > 0) {
    const a = online === 1 ? "a dedicated nozzle" : `${online} dedicated nozzles`;
    const b = walkIn === 1 ? "a separate nozzle" : `${walkIn} separate nozzles`;
    return `${fuel} has ${a} for online bookings and ${b} for walk-in customers.`;
  }
  if (online === 0) return `${fuel} nozzles currently serve walk-in customers only.`;
  return setup.total === 1
    ? `${fuel} has one nozzle, shared by online bookings and walk-in customers.`
    : `${fuel} has ${plural(setup.total, "nozzle")}, shared by online bookings and walk-in customers.`;
}

/** 72 -> "1 min 12 sec", 40 -> "40 sec". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r} sec`;
  return r === 0 ? `${m} min` : `${m} min ${r} sec`;
}

/** An instant as India time, "10:01:12". */
function clock(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

const STATION_KEYS = ["stationId", "_id", "id"] as const;
type StationPayload = Partial<Record<(typeof STATION_KEYS)[number], string>>;

/**
 * The real queue on one fuel's nozzle and where this booking would stand in
 * it, shown before booking.
 *
 * Every number is the server's (GET /api/v1/discovery/stations/:id/queue-preview):
 * the vehicle at the nozzle, the vehicles waiting -- bookings and walk-ins --
 * each with its own service time from its quantity, and this booking's wait,
 * start and completion. Petrol, Diesel and CNG have separate nozzles, so only
 * the chosen fuel's line is shown.
 *
 * Live without a refresh: it refetches when the station's queue or slots
 * change (Socket.IO queue:updated / slot:updated -- new booking, cancellation,
 * check-in, start, completion, walk-in in or out), after a reconnect, and when
 * a vehicle's fill is due to end. Between fetches only the countdowns move,
 * measured against the server's own clock.
 */
export default function FuelQueuePreview({ stationId, fuelType, quantity, date = null, timeSlot = null }: Props) {
  const [data, setData] = useState<QueuePreview | null>(null);
  // This fuel's nozzle setup (online / walk-in), from the station's public data.
  const nozzles = useStationStore((st) => {
    const station = st.stations.find((x) => x.id === String(stationId));
    const key = String(fuelType ?? "").toLowerCase() as "petrol" | "diesel" | "cng";
    return station?.nozzleConfig?.[key] ?? null;
  });
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  /** Server clock minus browser clock, from the last response. */
  const offset = useRef(0);
  const params = useRef({ stationId, fuelType, quantity, date, timeSlot });
  params.current = { stationId, fuelType, quantity, date, timeSlot };

  useWatchStation(stationId ?? null);

  const refresh = useMemo(
    () =>
      coalesce(async () => {
        const p = params.current;
        if (!p.stationId || !p.fuelType || !(p.quantity > 0)) return;
        try {
          const fresh = await fetchQueuePreview({
            stationId: p.stationId,
            fuelType: p.fuelType,
            quantity: p.quantity,
            date: p.date,
            timeSlot: p.timeSlot,
          });
          const now = params.current;
          // The selection changed while this was in flight: the next run fetches it.
          if (
            now.stationId !== p.stationId ||
            now.fuelType !== p.fuelType ||
            now.quantity !== p.quantity ||
            now.date !== p.date ||
            now.timeSlot !== p.timeSlot
          ) {
            return;
          }
          offset.current = new Date(fresh.asOf).getTime() - Date.now();
          setData(fresh);
          setError(null);
        } catch (err) {
          setError(toApiError(err).msg);
        }
      }),
    [],
  );

  // A new selection: fetch once the quantity stops changing.
  useEffect(() => {
    const id = window.setTimeout(refresh, 250);
    return () => window.clearTimeout(id);
  }, [stationId, fuelType, quantity, date, timeSlot, refresh]);

  const isThisStation = (p: StationPayload | undefined) =>
    Boolean(stationId) && STATION_KEYS.some((k) => p?.[k] && String(p[k]) === String(stationId));
  useSocketEvent<StationPayload>(SOCKET_EVENTS.QUEUE_UPDATED, (p) => isThisStation(p) && refresh(), [stationId, refresh]);
  useSocketEvent<StationPayload>(SOCKET_EVENTS.SLOT_UPDATED, (p) => isThisStation(p) && refresh(), [stationId, refresh]);
  useResync(refresh, [refresh]);

  // When the next fill in the line is due to start or end, fetch the line as
  // it then stands (the server also pushes, this covers a missed event).
  useEffect(() => {
    if (!data) return;
    const serverNow = Date.now() + offset.current;
    const due = [data.currentServing?.endsAt, ...data.queue.flatMap((q) => [q.startsAt, q.endsAt])]
      .filter((v): v is string => Boolean(v))
      .map((v) => new Date(v).getTime())
      .filter((ms) => ms > serverNow);
    const next = due.length ? Math.min(...due) : serverNow + 60_000;
    const id = window.setTimeout(refresh, Math.min(60_000, Math.max(1_000, next - serverNow + 750)));
    return () => window.clearTimeout(id);
  }, [data, refresh]);

  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  if (!stationId || !fuelType) return null;

  const matches =
    data &&
    String(data.stationId) === String(stationId) &&
    data.fuelType.toLowerCase() === fuelType.toLowerCase() &&
    data.you.quantity === quantity;

  const shell = (body: React.ReactNode) => (
    <section className="cx-subpanel" style={{ background: "var(--card)", animation: "none" }} aria-live="polite">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h4 className="cx-section-title">
          <i className="fas fa-gas-pump" style={{ color: "var(--primary)", fontSize: 13 }} aria-hidden />{" "}
          {fuelType.toUpperCase()} queue
        </h4>
        <span className="cx-tag is-green" title="Updates automatically">
          <i className="fas fa-circle" style={{ fontSize: 6 }} aria-hidden /> Live
        </span>
      </div>
      {body}
    </section>
  );

  if (!matches) {
    return shell(
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        {error ? `Could not load the queue: ${error}` : "Loading the live queue…"}
      </p>,
    );
  }

  const serverNow = tick + offset.current;
  const secondsUntil = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - serverNow) / 1000));
  const unit = data.unit;
  const current = data.currentServing;
  const you = data.you;
  const reserved = you.basis === "reserved-slot";
  const joined = new Date(you.joinAt).getTime() <= serverNow;
  // Waiting in line now: counts down to the turn. A later slot: the wait after it starts.
  const waitSeconds = reserved ? 0 : joined ? secondsUntil(you.estimatedStartAt) : you.estimatedWaitSeconds;
  const vehicleName = (v: string | null, kind: string) => v ?? (kind === "walkin" ? "Walk-in vehicle" : "Booked vehicle");

  const fact = (label: string, value: React.ReactNode, strong = false) => (
    <div className="cx-fact" key={label}>
      <dt>{label}</dt>
      <dd style={strong ? { fontWeight: 700, color: "var(--text)" } : undefined}>{value}</dd>
    </div>
  );

  let waitingNo = 0;
  const shown = data.queue.slice(0, 8);

  return shell(
    <>
      <dl className="cx-facts">
        {fact(
          "Currently serving",
          current
            ? `${vehicleName(current.vehicle, current.kind)} · ${current.quantity ?? "?"} ${unit} · ${formatDuration(secondsUntil(current.endsAt))} left`
            : "Nozzle free",
        )}
        {fact("Queue ahead", `${you.vehiclesAhead} vehicle${you.vehiclesAhead === 1 ? "" : "s"}`)}
        {data.schedule &&
          fact(
            "Places left in this slot",
            data.schedule.resourceAvailable
              ? `${data.schedule.availableCapacity} of ${data.schedule.totalCapacity}${data.schedule.resources > 1 ? ` · ${data.schedule.resources} nozzles` : ""}`
              : "Full: join the waitlist",
            true,
          )}
        {fact(
          "Estimated wait",
          reserved
            ? "Slot reserved (no live queue for that day yet)"
            : `${formatDuration(waitSeconds)}${!joined && waitSeconds > 0 ? " after your slot starts" : ""}`,
          true,
        )}
        {fact("Your quantity", `${you.quantity} ${unit}`)}
        {fact("Your service time", `~${formatDuration(you.serviceSeconds)}`)}
        {fact("Estimated start", clock(you.estimatedStartAt), true)}
        {fact("Estimated complete", clock(you.estimatedCompleteAt))}
      </dl>

      {shown.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs" style={{ color: "var(--text2)" }}>
            <thead>
              <tr style={{ color: "var(--muted)", textAlign: "left" }}>
                <th className="py-1 pr-2 font-medium">Vehicle</th>
                <th className="py-1 pr-2 font-medium">Quantity</th>
                <th className="py-1 pr-2 font-medium">Status</th>
                <th className="py-1 font-medium text-right">Service time</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((q) => {
                if (q.status === "waiting") waitingNo += 1;
                const tag =
                  q.status === "serving" ? (
                    <span className="cx-tag is-blue">Serving</span>
                  ) : q.status === "waiting" ? (
                    <span className="cx-tag is-amber">Waiting #{waitingNo}</span>
                  ) : (
                    <span className="cx-tag">Booked {clock(q.startsAt).slice(0, 5)}</span>
                  );
                return (
                  <tr key={`${q.kind}-${q.position}`} style={{ borderTop: "1px solid var(--border)" }}>
                    <td className="py-1.5 pr-2">{vehicleName(q.vehicle, q.kind)}</td>
                    <td className="py-1.5 pr-2">
                      {q.quantity ?? "?"} {unit}
                    </td>
                    <td className="py-1.5 pr-2">{tag}</td>
                    <td className="py-1.5 text-right">{formatDuration(q.serviceSeconds)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.queue.length > shown.length && (
            <p className="text-[11px] mt-1" style={{ color: "var(--muted)" }}>
              +{data.queue.length - shown.length} more later today
            </p>
          )}
        </div>
      )}

      <p className="text-[11px] mt-3" style={{ color: "var(--muted)" }}>
        {nozzleNote(data.fuelType, nozzles)} Wait times are based on each vehicle&apos;s fuel quantity, and the queue
        updates automatically in real time.
      </p>
    </>,
  );
}
