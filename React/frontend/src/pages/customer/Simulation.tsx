import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import BackendStatus from "@/components/common/BackendStatus";

/**
 * A demonstration of how a FuelMart booking travels, start to finish:
 *
 *   Booking -> Backend -> Pump -> Queue -> Serving -> Completed
 *
 * WHAT THIS IS NOT: it is not connected to anything. Every number on this
 * screen is written below, in this file. It creates no booking, touches no
 * station, and sends not one request -- which is what makes it safe to run
 * in front of an audience on a live system.
 *
 * It exists because the real thing is invisible: a booking that works looks
 * like a slot label and a PIN, and the queue arithmetic behind it (vehicles
 * ahead, expected wait, when the nozzle frees) happens on a server nobody
 * can see. This plays that out at a speed a person can follow.
 *
 * The chip at the top is the one real thing on the page: it reports the
 * actual backend connection, so nobody mistakes the demo for live data.
 */

interface Stage {
  key: string;
  title: string;
  icon: string;
  tint: string;
  /** What is happening, in the demo's own words. */
  detail: string;
  /** How long this stage runs in the demo. */
  ms: number;
}

const STAGES: Stage[] = [
  {
    key: "booking",
    title: "Booking placed",
    icon: "fa-mobile-screen",
    tint: "var(--chart-1)",
    detail: "Rahul books 20 L of Petrol at the station above, for the 7:30 PM slot, from his phone.",
    ms: 2600,
  },
  {
    key: "backend",
    title: "Backend checks and reserves",
    icon: "fa-server",
    tint: "var(--chart-4)",
    detail: "The server prices the fill, checks stock and the nozzle's free windows, and locks the slot so nobody else takes it.",
    ms: 3000,
  },
  {
    key: "pump",
    title: "Nozzle assigned",
    icon: "fa-gas-pump",
    tint: "var(--chart-3)",
    detail: "Petrol nozzle #2 is given the booking. Its queue is recalculated for every car already waiting on it.",
    ms: 2800,
  },
  {
    key: "queue",
    title: "In the queue",
    icon: "fa-list-ol",
    tint: "var(--chart-6)",
    detail: "Rahul is 3rd in line. The wait updates by itself as the cars ahead finish.",
    ms: 6000,
  },
  {
    key: "serving",
    title: "Serving",
    icon: "fa-fire-flame-simple",
    tint: "var(--status-good)",
    detail: "He shows the 4-digit PIN at the pump, the attendant checks him in, and fuelling starts.",
    ms: 4000,
  },
  {
    key: "completed",
    title: "Completed",
    icon: "fa-circle-check",
    tint: "var(--status-good)",
    detail: "20 L dispensed. Paid at the pump by UPI; the station's stock and the day's revenue both move.",
    ms: 3000,
  },
];

/** The demo's live figures, per stage. All invented, all in this file. */
const FIGURES: Record<string, { ahead: number; position: number; waitMin: number; nozzle: string; status: string }> = {
  booking: { ahead: 0, position: 0, waitMin: 0, nozzle: "Not assigned", status: "Sending…" },
  backend: { ahead: 0, position: 0, waitMin: 0, nozzle: "Choosing…", status: "Reserving slot" },
  pump: { ahead: 3, position: 4, waitMin: 9, nozzle: "Petrol #2", status: "Assigned" },
  queue: { ahead: 2, position: 3, waitMin: 6, nozzle: "Petrol #2", status: "Waiting" },
  serving: { ahead: 0, position: 1, waitMin: 0, nozzle: "Petrol #2", status: "Fuelling" },
  completed: { ahead: 0, position: 0, waitMin: 0, nozzle: "Petrol #2", status: "Done" },
};

/**
 * The pump the demo books at. A made-up station, named so plainly that
 * nobody mistakes it for one of the real ones on the platform.
 */
const DEMO_STATION = {
  name: "Demo Fuel Station (sample)",
  address: "Nagar Road, Wagholi, Pune 412207",
  hours: "Open 24 hours",
  prices: [
    { fuel: "Petrol", rate: "₹104.20/L", tint: "var(--fuel-petrol)" },
    { fuel: "Diesel", rate: "₹92.80/L", tint: "var(--fuel-diesel)" },
    { fuel: "CNG", rate: "₹86.00/kg", tint: "var(--fuel-cng)" },
  ],
};

/** What the station's petrol nozzles are doing, per stage of the demo. */
const NOZZLES: Record<string, Array<{ id: string; state: string; tint: string }>> = {
  booking: [
    { id: "Petrol #1", state: "Walk-in", tint: "var(--chart-3)" },
    { id: "Petrol #2", state: "Free", tint: "var(--status-good)" },
  ],
  backend: [
    { id: "Petrol #1", state: "Walk-in", tint: "var(--chart-3)" },
    { id: "Petrol #2", state: "Checking", tint: "var(--chart-4)" },
  ],
  pump: [
    { id: "Petrol #1", state: "Walk-in", tint: "var(--chart-3)" },
    { id: "Petrol #2", state: "3 in queue", tint: "var(--chart-6)" },
  ],
  queue: [
    { id: "Petrol #1", state: "Walk-in", tint: "var(--chart-3)" },
    { id: "Petrol #2", state: "2 in queue", tint: "var(--chart-6)" },
  ],
  serving: [
    { id: "Petrol #1", state: "Free", tint: "var(--status-good)" },
    { id: "Petrol #2", state: "Your fill", tint: "var(--status-good)" },
  ],
  completed: [
    { id: "Petrol #1", state: "Free", tint: "var(--status-good)" },
    { id: "Petrol #2", state: "Free", tint: "var(--status-good)" },
  ],
};

export default function Simulation() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [running, setRunning] = useState(true);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!running) return;
    if (step >= STAGES.length - 1) {
      setRunning(false);
      return;
    }
    timer.current = window.setTimeout(() => setStep((s) => s + 1), STAGES[step].ms);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [step, running]);

  const stage = STAGES[step];
  const figures = FIGURES[stage.key];
  const finished = step === STAGES.length - 1 && !running;

  const restart = () => {
    setStep(0);
    setRunning(true);
  };

  return (
    <div style={{ minHeight: "100dvh", background: "var(--bg)", color: "var(--text)" }}>
      <header
        className="flex items-center gap-3 px-4 py-3"
        style={{
          paddingTop: "calc(env(safe-area-inset-top) + 12px)",
          borderBottom: "1px solid var(--border)",
          background: "var(--card)",
        }}
      >
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="cx-icon-btn"
          aria-label="Back"
          style={{ flex: "0 0 auto" }}
        >
          <i className="fas fa-arrow-left" aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-bold leading-tight">Real-time simulation</h1>
          <p className="text-[11px]" style={{ color: "var(--muted)" }}>
            How a booking travels, from the phone to the pump
          </p>
        </div>
        <BackendStatus compact />
      </header>

      <div className="px-4 py-4" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 96px)" }}>
        {/* Said plainly, at the top, before any number is read. */}
        <div
          className="rounded-2xl px-3.5 py-3 mb-4 flex items-start gap-2.5"
          style={{ background: "rgba(245,158,11,.12)", border: "1px solid rgba(245,158,11,.35)" }}
          data-testid="demo-banner"
        >
          <i className="fas fa-flask" style={{ color: "var(--chart-3)", marginTop: 2 }} aria-hidden />
          <p className="text-[12px]" style={{ color: "var(--text)" }}>
            <b>Demo only.</b> Sample data, played out on a timer. Nothing here is booked, and no real booking,
            station or payment is touched.
          </p>
        </div>

        {/* The pump this demo books at, and what its nozzles are doing. */}
        <section
          className="rounded-2xl p-4 mb-4"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
          data-testid="sim-station"
        >
          <div className="flex items-start gap-3">
            <span
              className="flex items-center justify-center rounded-xl flex-shrink-0"
              style={{ width: 44, height: 44, background: "rgba(34,197,94,.14)", color: "var(--status-good)" }}
              aria-hidden
            >
              <i className="fas fa-gas-pump" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-[14.5px] font-bold">{DEMO_STATION.name}</h2>
                <span className="cx-tag is-green">Open</span>
              </div>
              <p className="text-[11.5px] mt-0.5" style={{ color: "var(--muted)" }}>
                <i className="fas fa-location-dot mr-1" aria-hidden />
                {DEMO_STATION.address}
              </p>
              <p className="text-[11px] mt-0.5" style={{ color: "var(--muted)" }}>
                <i className="fas fa-clock mr-1" aria-hidden />
                {DEMO_STATION.hours}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 mt-3">
            {DEMO_STATION.prices.map((p) => (
              <div
                key={p.fuel}
                className="rounded-xl px-2.5 py-2 text-center"
                style={{ background: "var(--bg)", border: "1px solid var(--border)" }}
              >
                <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
                  {p.fuel}
                </p>
                <p className="text-[12.5px] font-bold" style={{ color: p.tint }}>
                  {p.rate}
                </p>
              </div>
            ))}
          </div>

          {/* The nozzles, because the queue this demo explains is per nozzle. */}
          <p className="text-[10.5px] font-bold uppercase tracking-wide mt-3 mb-1.5" style={{ color: "var(--muted)" }}>
            Petrol nozzles
          </p>
          <div className="grid grid-cols-2 gap-2">
            {(NOZZLES[stage.key] ?? []).map((n) => (
              <div
                key={n.id}
                className="rounded-xl px-3 py-2 flex items-center justify-between gap-2"
                style={{ background: "var(--bg)", border: `1px solid color-mix(in srgb, ${n.tint} 33%, transparent)` }}
              >
                <span className="text-[12px] font-semibold">{n.id}</span>
                <span className="text-[11px] font-bold" style={{ color: n.tint }}>
                  {n.state}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* Where we are, as a line of stages. */}
        <ol className="flex items-center gap-1 mb-5" aria-label="Simulation stages">
          {STAGES.map((s, i) => {
            const done = i < step;
            const now = i === step;
            return (
              <li key={s.key} className="flex-1 flex flex-col items-center gap-1.5" title={s.title}>
                <span
                  className="flex items-center justify-center rounded-full"
                  style={{
                    width: now ? 30 : 24,
                    height: now ? 30 : 24,
                    fontSize: now ? 12 : 10,
                    color: done || now ? "#fff" : "var(--muted)",
                    background: done ? s.tint : now ? s.tint : "var(--border)",
                    boxShadow: now ? `0 0 0 4px color-mix(in srgb, ${s.tint} 20%, transparent)` : undefined,
                    transition: "all .3s ease",
                  }}
                  aria-hidden
                >
                  <i className={`fas ${done ? "fa-check" : s.icon}`} />
                </span>
                <span
                  className="h-[3px] w-full rounded-full"
                  style={{ background: done ? s.tint : "var(--border)", transition: "background .3s ease" }}
                  aria-hidden
                />
              </li>
            );
          })}
        </ol>

        {/* The stage itself. */}
        <section
          className="rounded-2xl p-4 mb-4"
          style={{ background: "var(--card)", border: `1px solid color-mix(in srgb, ${stage.tint} 33%, transparent)` }}
          aria-live="polite"
          data-testid="sim-stage"
        >
          <div className="flex items-center gap-3 mb-2">
            <span
              className="flex items-center justify-center rounded-xl"
              style={{ width: 42, height: 42, background: `color-mix(in srgb, ${stage.tint} 13%, transparent)`, color: stage.tint }}
              aria-hidden
            >
              <i className={`fas ${stage.icon}`} />
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
                Step {step + 1} of {STAGES.length}
              </p>
              <h2 className="text-[16px] font-bold">{stage.title}</h2>
            </div>
          </div>
          <p className="text-[12.5px]" style={{ color: "var(--muted)" }}>
            {stage.detail}
          </p>
        </section>

        {/* The figures a customer would be watching on their own screen. */}
        <div className="grid grid-cols-2 gap-3">
          <Figure label="Vehicles ahead" value={figures.ahead === 0 ? "None" : String(figures.ahead)} icon="fa-car" />
          <Figure
            label="Queue position"
            value={figures.position === 0 ? "—" : `#${figures.position}`}
            icon="fa-hashtag"
          />
          <Figure
            label="Expected waiting"
            value={figures.waitMin === 0 ? (stage.key === "serving" ? "Now" : "—") : `${figures.waitMin} min`}
            icon="fa-stopwatch"
          />
          <Figure label="Nozzle" value={figures.nozzle} icon="fa-gas-pump" />
        </div>

        <div
          className="rounded-2xl px-4 py-3 mt-3 flex items-center justify-between gap-3"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
        >
          <span className="text-[12px]" style={{ color: "var(--muted)" }}>
            Pump status
          </span>
          <span className="text-[13px] font-bold" style={{ color: stage.tint }}>
            {figures.status}
          </span>
        </div>

        <div className="flex gap-2 mt-4">
          <button
            type="button"
            className="btn btn-outline flex-1"
            onClick={() => (running ? setRunning(false) : setRunning(true))}
            disabled={finished}
          >
            <i className={`fas ${running ? "fa-pause" : "fa-play"}`} aria-hidden /> {running ? "Pause" : "Resume"}
          </button>
          <button type="button" className="btn btn-primary flex-1" onClick={restart}>
            <i className="fas fa-rotate-right" aria-hidden /> {finished ? "Run again" : "Restart"}
          </button>
        </div>

        {finished && (
          <p className="text-[12px] text-center mt-3" style={{ color: "var(--muted)" }}>
            That is the whole journey. In the real app every one of those steps is decided by the server, and the
            figures change on their own as other customers arrive.
          </p>
        )}
      </div>
    </div>
  );
}

function Figure({ label, value, icon }: { label: string; value: string; icon: string }) {
  return (
    <div className="rounded-2xl px-3.5 py-3" style={{ background: "var(--card)", border: "1px solid var(--border)" }}>
      <p className="text-[11px] flex items-center gap-1.5" style={{ color: "var(--muted)" }}>
        <i className={`fas ${icon}`} aria-hidden /> {label}
      </p>
      <p className="text-[17px] font-bold mt-0.5">{value}</p>
    </div>
  );
}
