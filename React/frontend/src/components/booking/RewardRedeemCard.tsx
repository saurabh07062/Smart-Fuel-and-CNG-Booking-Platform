import { useEffect, useState } from "react";
import { fetchRewardQuote, type RewardQuote } from "@/services/api/rewardApi";
import { formatCurrency } from "@/utils/format";

/**
 * "Use your reward points" — the checkout control.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not decide anything. The balance, the minimum, the share of a bill
 * points may cover and the discount they buy all come from the server for THIS
 * bill (GET /api/v1/rewards/quote). The points chosen here are a request sent
 * with the booking, and the server checks them again and works out the final
 * discount (backend services/booking/bookingCreate.js). So a customer editing
 * this number, or a quote going stale while they think, costs them a discount —
 * it can never charge less than the business agreed.
 *
 * It renders nothing at all when there is nothing to offer: no balance, too few
 * points, or a bill too small to use them on. An empty "0 points available"
 * panel at checkout is noise in front of a customer trying to buy fuel.
 */
/**
 * Points -> rupees, rounded DOWN to the paisa -- the same direction the server
 * rounds (backend config/rewards.js rupeesFor), so the figure shown here and
 * the figure charged agree to the paisa.
 */
const worthOf = (points: number, pointValue: number) => Math.floor(points * pointValue * 100) / 100;

export default function RewardRedeemCard({
  amount,
  points,
  onChange,
}: {
  /** The bill the discount applies to, in rupees. Null while it is unknown. */
  amount: number | null;
  /** Points currently chosen. */
  points: number;
  /**
   * The chosen points AND what the server said they are worth.
   *
   * The rupee figure is passed up rather than recomputed by the caller: the
   * rate is the server's (RewardQuote.pointValue), and a checkout summary that
   * works out the discount for itself is a second opinion waiting to disagree
   * with this card.
   */
  onChange: (points: number, discount: number) => void;
}) {
  const [quote, setQuote] = useState<RewardQuote | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    if (amount === null || amount <= 0) return;
    let live = true;
    setState("loading");
    fetchRewardQuote(amount)
      .then((q) => {
        if (!live) return;
        setQuote(q);
        setState("ready");
        // A quote that allows less than is already chosen (the bill shrank, or
        // points were spent elsewhere) is trimmed rather than left to be
        // refused at the end.
        if (points > q.maxPoints) {
          const trimmed = q.maxPoints >= q.minPoints ? q.maxPoints : 0;
          onChange(trimmed, worthOf(trimmed, q.pointValue));
        }
      })
      .catch(() => {
        if (!live) return;
        // Points are a bonus, not the booking. A failed quote hides the control
        // and the booking goes through at full price.
        setState("failed");
        if (points > 0) onChange(0, 0);
      });
    return () => {
      live = false;
    };
    // Re-quoted when the bill changes; `points` is deliberately not a dependency
    // (it would re-fetch on every keystroke of the slider).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount]);

  if (state === "failed" || amount === null) return null;
  if (state === "loading") {
    return (
      <p className="cx-reward-loading" data-testid="reward-loading">
        <i className="fas fa-spinner fa-spin" aria-hidden /> Checking your reward points…
      </p>
    );
  }
  if (!quote) return null;

  // Nothing worth showing: no points, or not enough for this bill.
  if (!quote.eligible || quote.maxPoints < quote.minPoints) {
    if (quote.balance <= 0) return null;
    return (
      <div className="cx-reward is-muted" data-testid="reward-card">
        <span className="cx-reward-icon" aria-hidden>
          <i className="fas fa-star" />
        </span>
        <p className="cx-reward-text">
          You have <b>{quote.balance.toLocaleString("en-IN")}</b> reward points.{" "}
          {quote.reason === "BILL_TOO_SMALL"
            ? `This booking is too small to use them on — points may cover up to ${quote.maxPercent}% of a bill.`
            : `You need at least ${quote.minPoints} to use them.`}
        </p>
      </div>
    );
  }

  const chosen = Math.min(points, quote.maxPoints);
  const discount = worthOf(chosen, quote.pointValue);
  const using = chosen >= quote.minPoints;

  return (
    <div className="cx-reward" data-testid="reward-card">
      <div className="cx-reward-head">
        <span className="cx-reward-icon" aria-hidden>
          <i className="fas fa-star" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="cx-reward-title">Use reward points</p>
          <p className="cx-reward-sub">
            {quote.balance.toLocaleString("en-IN")} points ({formatCurrency(
              Math.floor(quote.balance * quote.pointValue * 100) / 100,
            )}
            ) · up to {quote.maxPoints.toLocaleString("en-IN")} on this booking
          </p>
        </div>
        <button
          type="button"
          className={`cx-reward-toggle ${using ? "is-on" : ""}`}
          onClick={() => (using ? onChange(0, 0) : onChange(quote.maxPoints, worthOf(quote.maxPoints, quote.pointValue)))}
          aria-pressed={using}
          data-testid="reward-toggle"
        >
          {using ? "Remove" : `Use ${quote.maxPoints}`}
        </button>
      </div>

      {using && (
        <>
          <label className="cx-reward-label" htmlFor="reward-points-range">
            Points to use
          </label>
          <input
            id="reward-points-range"
            className="cx-reward-range"
            type="range"
            min={quote.minPoints}
            max={quote.maxPoints}
            step={1}
            value={chosen}
            onChange={(e) => onChange(Number(e.target.value), worthOf(Number(e.target.value), quote.pointValue))}
            data-testid="reward-range"
          />
          <p className="cx-reward-saving" data-testid="reward-saving">
            <b>{chosen.toLocaleString("en-IN")} points</b> — {formatCurrency(discount)} off. You pay{" "}
            <b>{formatCurrency(Math.round((amount - discount) * 100) / 100)}</b> at the pump.
          </p>
        </>
      )}
      <p className="cx-reward-note">
        Points are taken when the booking is confirmed, and returned in full if you cancel.
      </p>
    </div>
  );
}
