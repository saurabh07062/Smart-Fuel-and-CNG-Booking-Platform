import { useRef, useState } from "react";
import * as api from "@/services/api/adminApi";
import { pushToast } from "@/store/toastStore";
import { toApiError } from "@/services/api/apiClient";

/**
 * Support check-in: the admin enters a customer's 4-digit code and the server
 * checks them in at the pump, exactly as the station's own vendor would
 * (POST /api/bookings/verify). The difference is reach -- an admin is not
 * limited to one owner's stations, so this is the fallback when a vendor
 * cannot use their own panel.
 *
 * Day-to-day check-in belongs to the vendor; nothing here is a separate
 * booking path. The camera scanner this page used to carry is gone: an admin
 * is not standing at a pump with a customer's phone, and it held the camera
 * open for a job the 4-digit code already does.
 *
 * THE CODE IS CHECKED AGAINST THE SCHEMA THE SERVER ENFORCES: exactly four
 * digits and nothing else (backend controllers/bookingController.js refuses
 * anything that does not match /^\d{4}$/). That rule is applied while it is
 * typed -- a non-digit never enters the field, the button stays disabled
 * until there are four, and the reason is written under the box instead of
 * flashed in a toast that is gone before it is read.
 */

/** The one rule, shared by the field, the button and the submit handler. */
const CODE_LENGTH = 4;

function codeProblem(code: string): string | null {
  if (code.length === 0) return "Enter the 4-digit code from the customer's booking.";
  if (!/^\d+$/.test(code)) return "The code is digits only.";
  if (code.length < CODE_LENGTH) {
    const left = CODE_LENGTH - code.length;
    return `${left} more digit${left === 1 ? "" : "s"} to go.`;
  }
  if (code.length > CODE_LENGTH) return `The code is exactly ${CODE_LENGTH} digits.`;
  return null;
}

interface Outcome {
  tone: "good" | "info";
  title: string;
  detail: string;
}

export default function AdminVerifyTab() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  /** Shown under the field once they have tried, not while they first type. */
  const [touched, setTouched] = useState(false);
  /** What the last check-in did, kept on screen: a toast is gone too fast. */
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const problem = codeProblem(code);
  const ready = problem === null;
  const showProblem = touched && problem !== null;

  const verify = async () => {
    setTouched(true);
    if (!ready) {
      pushToast(problem ?? "Enter the customer's 4-digit code", "error");
      inputRef.current?.focus();
      return;
    }
    // A second press while the first is in flight would check the same
    // customer in twice.
    if (busy) return;

    setBusy(true);
    setOutcome(null);
    try {
      let data;
      try {
        data = await api.verifyBooking({ verificationCode: code });
      } catch (first) {
        // The customer has not tapped "Check In at Petrol Pump". That is the
        // rule, and a vendor cannot pass it -- but support exists precisely
        // for the customer whose phone cannot do it.
        const e = toApiError(first);
        if (e.reason !== "NOT_CHECKED_IN") throw first;
        if (!window.confirm(`${e.msg}\n\nCheck this customer in yourself anyway?`)) {
          pushToast("Not checked in. Ask the customer to check in at the pump.", "info");
          return;
        }
        data = await api.verifyBooking({ verificationCode: code, override: true });
      }
      const queued = Boolean(data.queued);
      pushToast(data.msg || "Checked in", queued ? "info" : "success");
      setOutcome({
        tone: queued ? "info" : "good",
        title: queued ? "Checked in — waiting for the nozzle" : "Checked in — fuelling started",
        detail:
          data.msg ||
          (queued
            ? "The car ahead is still on the nozzle. This fill starts by itself when it is released."
            : "The server has started the fill and will complete it automatically."),
      });
      setCode("");
      setTouched(false);
      inputRef.current?.focus();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setBusy(false);
    }
  };

  /** Digits only, at most four -- including a pasted code with spaces. */
  const onChange = (value: string) => {
    setCode(value.replace(/\D/g, "").slice(0, CODE_LENGTH));
    setOutcome(null);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] gap-4 items-start">
      {/* The tool: one field, one button, and what it will do. */}
      <section className="vm-panel" style={{ padding: 22, marginBottom: 0 }} data-testid="verify-panel">
        <h3 className="vm-eyebrow mb-1">Support check-in</h3>
        <p className="text-[15px] font-bold vm-text mb-1">Customer&apos;s 4-digit code</p>
        <p className="text-[11.5px] vm-text-muted mb-4">
          Ask the customer for the code on their booking, then start their fill.
        </p>

        {/* One input, drawn as four cells: a real field for the keyboard, a
            screen reader and paste, without four boxes to tab through. */}
        <input
          id="verify-code"
          ref={inputRef}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="Verification code"
          aria-invalid={showProblem}
          aria-describedby="verify-code-note"
          className="w-full text-center font-mono font-bold vm-text"
          style={{
            fontSize: 34,
            letterSpacing: "0.5em",
            textIndent: "0.5em",
            padding: "16px 10px",
            background: "var(--z-ground)",
            border: `1px solid ${showProblem ? "var(--z-red)" : ready ? "var(--z-accent)" : "var(--z-line)"}`,
            borderRadius: 14,
            outline: "none",
          }}
          placeholder="••••"
          value={code}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setTouched(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void verify();
          }}
        />

        <p
          id="verify-code-note"
          className="text-[11px] mt-2 text-center"
          role={showProblem ? "alert" : undefined}
          style={{ color: showProblem ? "var(--z-red)" : "var(--z-light)" }}
        >
          {showProblem
            ? problem
            : ready
              ? "Press Check In, or hit Enter."
              : "Four digits, from the customer's booking."}
        </p>

        <button
          onClick={() => void verify()}
          disabled={busy || !ready}
          className="vm-btn vm-btn-primary w-full mt-4"
          style={{ height: 46, opacity: busy || !ready ? 0.55 : 1 }}
        >
          {busy ? "Checking in…" : "Check In"}
        </button>

        {outcome && (
          <div
            className="mt-4 rounded-xl p-3"
            role="status"
            data-testid="verify-outcome"
            style={{
              background: outcome.tone === "good" ? "var(--z-green-tint)" : "var(--z-blue-tint)",
              border: `1px solid ${outcome.tone === "good" ? "var(--z-green)" : "var(--z-blue)"}`,
            }}
          >
            <p
              className="text-[12.5px] font-bold"
              style={{ color: outcome.tone === "good" ? "var(--z-green)" : "var(--z-blue)" }}
            >
              <i
                className={`fas ${outcome.tone === "good" ? "fa-circle-check" : "fa-hourglass-half"} mr-1.5`}
                aria-hidden
              />
              {outcome.title}
            </p>
            <p className="text-[11.5px] vm-text-muted mt-1">{outcome.detail}</p>
          </div>
        )}

        <p className="text-[11px] vm-text-muted mt-3 text-center">
          <i className="fas fa-indian-rupee-sign mr-1" aria-hidden />
          This starts the fill. The payment is recorded at the pump, in cash or by UPI.
        </p>
      </section>

      {/* When this page is the right tool -- and when it is not. */}
      <section className="vm-panel" style={{ padding: 22, marginBottom: 0 }}>
        <h3 className="vm-eyebrow mb-1">When to use this</h3>
        <p className="text-[15px] font-bold vm-text mb-4">Support, not the daily counter</p>

        <ul className="space-y-3" data-testid="verify-notes">
          {(
            [
              [
                "fa-user-gear",
                "The vendor checks customers in",
                "Day-to-day check-in happens in the vendor's own panel. Use this page when they cannot: locked out, suspended, or a device that will not open it.",
              ],
              [
                "fa-shield-halved",
                "An admin reaches every station",
                "A vendor can only check in at their own stations; from here, any station on the platform.",
              ],
              [
                "fa-location-dot",
                "The customer must be at the pump",
                "A code works once they have tapped “Check In at Petrol Pump” in their app. If their phone cannot, this page offers to check them in anyway — a vendor's panel does not.",
              ],
              [
                "fa-clock",
                "Today's live bookings only",
                "Another day's booking, or one already completed, is refused and says which.",
              ],
            ] as const
          ).map(([icon, title, body]) => (
            <li key={title} className="flex gap-3">
              <span
                className="inline-flex items-center justify-center rounded-lg flex-shrink-0"
                style={{ width: 28, height: 28, background: "var(--z-accent-soft)", color: "var(--z-accent)" }}
                aria-hidden
              >
                <i className={`fas ${icon}`} style={{ fontSize: 12 }} />
              </span>
              <span className="min-w-0">
                <span className="block text-[12.5px] font-bold vm-text">{title}</span>
                <span className="block text-[11.5px] vm-text-muted">{body}</span>
              </span>
            </li>
          ))}
        </ul>

        <p className="text-[11px] vm-text-muted mt-4 pt-3" style={{ borderTop: "1px solid var(--z-line)" }}>
          <i className="fas fa-clipboard-check mr-1.5" aria-hidden />
          Every check-in made here is recorded against this admin account, the same as a vendor&apos;s.
        </p>
      </section>
    </div>
  );
}
