import { useEffect, useState } from "react";
import { fetchRewards, type RewardEntry, type RewardStatement } from "@/services/api/rewardApi";
import { toApiError } from "@/services/api/apiClient";
import { formatCurrency } from "@/utils/format";

/**
 * "Where did my points come from?" — the statement.
 *
 * Every row is a movement the server recorded (backend models/RewardLedger.js):
 * the welcome credit, points earned on a fill, points spent as a discount,
 * points returned when a booking was cancelled. The balance at the top is the
 * sum of them, which is the point of showing them at all — a number with no
 * history behind it is something a customer has to take on trust.
 *
 * Nothing is computed here. Even the rules in the footer ("2 points per ₹100")
 * are read from the server, so the panel cannot describe a scheme the business
 * has changed.
 */

/** How each kind of movement reads to the customer. */
const LOOK: Record<RewardEntry["type"], { label: string; icon: string; tone: string }> = {
  welcome: { label: "Welcome bonus", icon: "fa-gift", tone: "is-credit" },
  earned: { label: "Earned", icon: "fa-star", tone: "is-credit" },
  redeemed: { label: "Used as discount", icon: "fa-tag", tone: "is-debit" },
  redeem_reversed: { label: "Returned", icon: "fa-rotate-left", tone: "is-credit" },
  earn_reversed: { label: "Reversed", icon: "fa-rotate-left", tone: "is-debit" },
  adjustment: { label: "Adjustment", icon: "fa-pen", tone: "is-credit" },
};

const when = (at: string) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? at
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};

export default function RewardsSheet({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<RewardStatement | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchRewards({ limit: 50 })
      .then((res) => {
        if (!live) return;
        setData(res);
        setState("ready");
      })
      .catch((err) => {
        if (!live) return;
        setError(toApiError(err).msg || "Could not load your reward points.");
        setState("error");
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="cx-sheet-backdrop" role="presentation" onClick={onClose}>
      <div
        className="cx-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rewards-title"
        data-testid="rewards-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cx-sheet-head">
          <h3 id="rewards-title" className="cx-sheet-title">
            <i className="fas fa-star" style={{ color: "var(--status-warn)" }} aria-hidden /> Reward points
          </h3>
          <button type="button" className="cx-sheet-close" onClick={onClose} aria-label="Close">
            <i className="fas fa-xmark" aria-hidden />
          </button>
        </div>

        {state === "loading" && (
          <p className="cx-sheet-note">
            <i className="fas fa-spinner fa-spin" aria-hidden /> Loading your points…
          </p>
        )}

        {state === "error" && (
          <p className="cx-sheet-note is-error" role="alert">
            <i className="fas fa-triangle-exclamation" aria-hidden /> {error}
          </p>
        )}

        {state === "ready" && data && (
          <>
            <div className="cx-reward-balance" data-testid="rewards-balance">
              <span className="cx-reward-balance-points">{data.balance.toLocaleString("en-IN")}</span>
              <span className="cx-reward-balance-worth">points · worth {formatCurrency(data.worth)}</span>
            </div>

            {data.entries.length === 0 ? (
              <p className="cx-sheet-note" data-testid="rewards-empty">
                No points yet. You earn {data.rules.earnPer100} point
                {data.rules.earnPer100 === 1 ? "" : "s"} for every ₹100 you spend on a completed booking.
              </p>
            ) : (
              <ul className="cx-reward-list">
                {data.entries.map((entry) => {
                  const look = LOOK[entry.type];
                  return (
                    <li key={entry.id} className="cx-reward-row">
                      <span className={`cx-reward-row-icon ${look.tone}`} aria-hidden>
                        <i className={`fas ${look.icon}`} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="cx-reward-row-title">{look.label}</span>
                        <span className="cx-reward-row-sub">
                          {when(entry.at)}
                          {entry.booking?.orderId ? ` · ${entry.booking.orderId}` : ""}
                          {entry.note ? ` · ${entry.note}` : ""}
                        </span>
                      </span>
                      <span className={`cx-reward-row-points ${entry.points > 0 ? "is-credit" : "is-debit"}`}>
                        {entry.points > 0 ? "+" : "−"}
                        {Math.abs(entry.points).toLocaleString("en-IN")}
                        {entry.rupees > 0 && <small>{formatCurrency(entry.rupees)}</small>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            <p className="cx-sheet-foot">
              {data.rules.earnPer100} point{data.rules.earnPer100 === 1 ? "" : "s"} per ₹100 spent ·{" "}
              {data.rules.minRedeem} points minimum · 1 point = {formatCurrency(data.rules.pointValue)} · points may
              cover up to {data.rules.maxDiscountPercent}% of a booking
            </p>
          </>
        )}
      </div>
    </div>
  );
}
