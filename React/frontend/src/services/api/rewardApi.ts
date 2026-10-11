import { apiClient } from "./apiClient";

/**
 * Reward points, from the server.
 *
 * Nothing here calculates anything. The balance, what a point is worth, the
 * minimum redemption, the share of a bill points may cover and the resulting
 * discount are all the backend's answers (backend services/rewards/rewardService.js
 * and config/rewards.js). The UI shows them; it never works them out, because a
 * discount computed in the browser is a discount the customer can change.
 */

/** How the business has set the scheme up. Read, never assumed. */
export interface RewardRules {
  /** Points earned per ₹100 actually paid. */
  earnPer100: number;
  /** Rupees one point is worth. */
  pointValue: number;
  /** The smallest redemption allowed. */
  minRedeem: number;
  /** The most of a bill points may pay for, as a percentage. */
  maxDiscountPercent: number;
}

/** One movement of points: what, when, and why. */
export interface RewardEntry {
  id: string;
  type: "welcome" | "earned" | "redeemed" | "redeem_reversed" | "earn_reversed" | "adjustment";
  /** Signed: a credit is positive, a spend negative. */
  points: number;
  balanceAfter: number;
  rupees: number;
  note: string | null;
  at: string;
  booking: {
    id: string;
    orderId: string | null;
    fuelType: string;
    quantity: number;
    amount: number;
    bookingDate: string;
    timeSlot: string | null;
  } | null;
}

export interface RewardStatement {
  success: boolean;
  balance: number;
  /** The balance in rupees, at today's rate. */
  worth: number;
  rules: RewardRules;
  entries: RewardEntry[];
  total: number;
}

/** What may be spent on one bill, and why not, when nothing may. */
export interface RewardQuote {
  success: boolean;
  balance: number;
  maxPoints: number;
  maxDiscount: number;
  minPoints: number;
  pointValue: number;
  maxPercent: number;
  eligible: boolean;
  reason: "BALANCE_BELOW_MINIMUM" | "BILL_TOO_SMALL" | null;
  rules: RewardRules;
}

/** The customer's balance, the rules and their statement. */
export async function fetchRewards(params: { limit?: number; skip?: number } = {}): Promise<RewardStatement> {
  const { data } = await apiClient.get<RewardStatement>("/v1/rewards", { params });
  return data;
}

/**
 * What this customer may spend on a bill of `amount`.
 *
 * Reserves nothing. The server checks the figure again when the booking is
 * created, so a quote that goes stale costs a discount rather than money.
 */
export async function fetchRewardQuote(amount: number): Promise<RewardQuote> {
  const { data } = await apiClient.get<RewardQuote>("/v1/rewards/quote", { params: { amount } });
  return data;
}
