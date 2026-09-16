import { useCallback, useEffect, useState } from "react";
import * as api from "@/services/api/adminApi";
import type { SecurityReport } from "@/services/api/adminApi";
import { toApiError } from "@/services/api/apiClient";
import { ConsoleLoading } from "@/components/console/ConsoleBits";

const ACTION_STYLE: Record<string, string> = {
  blocked: "text-red-400 border-red-800 bg-red-900/30",
  flagged: "text-yellow-400 border-yellow-800 bg-yellow-900/30",
};

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function windowText(minutes: number): string {
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}

/**
 * The risk engine report (GET /api/v1/admin/security-events).
 *
 * Blocked requests were refused with a retry time; flagged ones tripped a
 * single rule and went through. Everything shown is what the server logged --
 * rule, reason, score -- never a request body.
 */
export default function AdminSecurityTab() {
  const [action, setAction] = useState<"" | "blocked" | "flagged">("");
  const [report, setReport] = useState<SecurityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await api.fetchSecurityReport({ action: action || undefined, limit: 100 }));
    } catch (err) {
      setError(toApiError(err).msg);
    } finally {
      setLoading(false);
    }
  }, [action]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !report) {
    return (
      <div className="vm-panel" style={{ padding: 22 }}>
        <p className="text-red-400 font-bold">Could not load the security report</p>
        <p className="vm-text-muted text-sm mt-1">{error}</p>
        <button type="button" className="vm-link mt-3" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }
  if (!report) return <ConsoleLoading label="Loading security report..." />;

  const stats: Array<[string, string, string, string]> = [
    ["Blocked (24 h)", String(report.last24h.blocked), "fa-ban", "text-red-400"],
    ["Flagged (24 h)", String(report.last24h.flagged), "fa-flag", "text-yellow-400"],
    ["Booking attempts (24 h)", String(report.attempts24h.total), "fa-arrow-right-to-bracket", "vm-accent-text"],
    [
      "Blocked share (24 h)",
      report.blockRate24h === null ? "—" : `${report.blockRate24h}%`,
      "fa-percent",
      "vm-text",
    ],
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(([label, value, icon, color]) => (
          <div key={label} className="vm-panel" style={{ padding: 18, marginBottom: 0 }}>
            <p className="vm-text-muted text-xs font-bold uppercase tracking-wider flex items-center gap-2">
              <i className={`fas ${icon} ${color}`} aria-hidden /> {label}
            </p>
            <p className={`text-2xl font-bold mt-2 ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="vm-panel" style={{ padding: 22, marginBottom: 0 }}>
          <h3 className="text-lg font-bold mb-1">Rules in force</h3>
          <p className="vm-text-muted text-xs mb-4">
            A booking is blocked at {report.rules.threshold} points. No single rule can reach that on its own.
            {report.rules.requestLimit && (
              <>
                {" "}
                Before any scoring, an account sending more than {report.rules.requestLimit.perMinute} booking requests
                a minute is refused outright ({report.rules.requestLimit.rule}).
              </>
            )}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="vm-text-muted text-left text-xs uppercase">
                  <th className="py-2 pr-3">Rule</th>
                  <th className="py-2 pr-3">Trips at</th>
                  <th className="py-2 pr-3">Window</th>
                  <th className="py-2">Points</th>
                </tr>
              </thead>
              <tbody>
                {report.rules.list.map((r) => (
                  <tr key={r.rule} className="border-t vm-border">
                    <td className="py-2 pr-3 font-bold">{r.rule}</td>
                    <td className="py-2 pr-3">more than {r.limit}</td>
                    <td className="py-2 pr-3">{windowText(r.windowMinutes)}</td>
                    <td className="py-2">{r.points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="vm-panel" style={{ padding: 22, marginBottom: 0 }}>
          <h3 className="text-lg font-bold mb-4">Most events (7 days)</h3>
          {report.topUsers7d.length === 0 ? (
            <p className="vm-text-muted text-sm">No account has triggered a rule in the last 7 days.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="vm-text-muted text-left text-xs uppercase">
                    <th className="py-2 pr-3">Account</th>
                    <th className="py-2 pr-3">Events</th>
                    <th className="py-2 pr-3">Blocked</th>
                    <th className="py-2">Last</th>
                  </tr>
                </thead>
                <tbody>
                  {report.topUsers7d.map((u) => (
                    <tr key={u.userId} className="border-t vm-border">
                      <td className="py-2 pr-3">
                        <p className="font-bold">{u.name || "Unknown account"}</p>
                        <p className="vm-text-muted text-xs">{u.email}</p>
                      </td>
                      <td className="py-2 pr-3">{u.events}</td>
                      <td className="py-2 pr-3">{u.blocked}</td>
                      <td className="py-2 text-xs vm-text-muted">{when(u.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <section className="vm-panel" style={{ padding: 22, marginBottom: 0 }}>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h3 className="text-lg font-bold">
            Recent events <span className="vm-text-muted text-sm font-normal">({report.total})</span>
          </h3>
          <div className="flex items-center gap-2">
            <select
              className="vm-input px-3 py-1.5 text-sm vm-text"
              value={action}
              onChange={(e) => setAction(e.target.value as "" | "blocked" | "flagged")}
              aria-label="Filter by action"
            >
              <option value="">All actions</option>
              <option value="blocked">Blocked</option>
              <option value="flagged">Flagged</option>
            </select>
            <button
              type="button"
              className="vm-bg-surface vm-hover border vm-border vm-text font-bold py-1.5 px-3 rounded-lg text-sm"
              onClick={() => void load()}
              disabled={loading}
            >
              <i className={`fas fa-rotate ${loading ? "fa-spin" : ""}`} aria-hidden /> Refresh
            </button>
          </div>
        </div>

        {report.events.length === 0 ? (
          <p className="vm-text-muted text-sm">
            No {action || "security"} events recorded. The risk engine logs an event whenever a booking request trips a
            rule.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="vm-text-muted text-left text-xs uppercase">
                  <th className="py-2 pr-3">When</th>
                  <th className="py-2 pr-3">Action</th>
                  <th className="py-2 pr-3">Why</th>
                  <th className="py-2 pr-3">Score</th>
                  <th className="py-2 pr-3">Account</th>
                  <th className="py-2">Station</th>
                </tr>
              </thead>
              <tbody>
                {report.events.map((e) => (
                  <tr key={e.id} className="border-t vm-border align-top">
                    <td className="py-2 pr-3 whitespace-nowrap text-xs vm-text-muted">{when(e.createdAt)}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={`px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase ${ACTION_STYLE[e.action] ?? ""}`}
                      >
                        {e.action}
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      <p className="font-bold">{e.rule}</p>
                      <p className="vm-text-muted text-xs">{e.reason}</p>
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {e.score} / {e.threshold}
                    </td>
                    <td className="py-2 pr-3">
                      {e.user ? (
                        <>
                          <p>{e.user.name}</p>
                          <p className="vm-text-muted text-xs">{e.user.email}</p>
                        </>
                      ) : (
                        <span className="vm-text-muted">—</span>
                      )}
                    </td>
                    <td className="py-2">{e.station?.name ?? <span className="vm-text-muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
