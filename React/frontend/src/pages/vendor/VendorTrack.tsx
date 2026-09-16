import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import * as api from "@/services/api/vendorApi";
import type { VendorApplication } from "@/services/api/vendorApi";
import { useAuthStore } from "@/store/authStore";
import { pushToast } from "@/store/toastStore";
import { toApiError } from "@/services/api/apiClient";
import { useSocketEvent } from "@/hooks/useSocket";
import { SOCKET_EVENTS } from "@/services/socket/socketEvents";

/** vendorStatusVisual(). Same labels, colours and icons. */
function statusVisual(status?: string, activated?: boolean) {
  if (status === "active" && activated) {
    return { label: "Active", color: "var(--status-good)", bg: "var(--status-good-bg)", icon: "fa-circle-check" };
  }
  if (status === "active") {
    return { label: "Approved — activation needed", color: "var(--primary)", bg: "var(--primary-light)", icon: "fa-key" };
  }
  if (status === "rejected") {
    return { label: "Not approved", color: "var(--status-bad)", bg: "var(--status-bad-bg)", icon: "fa-circle-xmark" };
  }
  if (status === "suspended") {
    return { label: "Suspended", color: "var(--status-bad)", bg: "var(--status-bad-bg)", icon: "fa-ban" };
  }
  if (status === "under_review") {
    return { label: "Under review", color: "var(--status-warn)", bg: "var(--status-warn-bg)", icon: "fa-magnifying-glass" };
  }
  return { label: "Pending review", color: "var(--status-warn)", bg: "var(--status-warn-bg)", icon: "fa-hourglass-half" };
}

const fmtDate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "—";

interface AppWithDates extends VendorApplication {
  appliedAt?: string;
  approvedAt?: string;
  rejectedAt?: string;
}

/**
 * Port of renderVendorTrack() -- an applicant's status page.
 *
 * The vendor id comes from ?id= or, when they are signed in, from their own
 * session. The Vanilla page read it from state and rendered a "No application
 * found" card when it was missing; both paths are preserved.
 *
 * REAL-TIME: this page listens for vendor:approved, which is exactly the flip
 * the applicant is sitting here waiting for -- it moves from "Pending review"
 * to "Approved — activation needed" without a refresh.
 */
export default function VendorTrack() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const user = useAuthStore((s) => s.user);

  const vendorId = params.get("id") || user?.id || user?._id || "";

  const [app, setApp] = useState<AppWithDates | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [activating, setActivating] = useState(false);

  const load = useCallback(async () => {
    if (!vendorId) {
      setLoading(false);
      setError("NO_ID");
      return;
    }
    setLoading(true);
    try {
      setApp(await api.fetchVendorApplication(vendorId));
      setError(null);
    } catch (err) {
      setError(toApiError(err).msg);
    } finally {
      setLoading(false);
    }
  }, [vendorId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The event the applicant is waiting for. Refetching rather than patching
  // from the payload keeps this page's shape owned by one source.
  useSocketEvent(SOCKET_EVENTS.VENDOR_APPROVED, () => void load(), [load]);

  const activate = async () => {
    if (!code.trim()) {
      pushToast("Enter the activation code from your email", "error");
      return;
    }
    setActivating(true);
    try {
      const r = await api.activateVendor(vendorId, code.trim());
      pushToast(r.msg || "Activated! You can open your dashboard now.", "success");
      setCode("");
      await load();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setActivating(false);
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className="max-w-xl mx-auto px-4 py-10">
      <button
        className="flex items-center gap-3 mb-8 bg-transparent border-0 cursor-pointer"
        onClick={() => navigate("/")}
      >
        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "var(--primary)" }}>
          <i className="fas fa-gas-pump" style={{ color: "#fff" }} aria-hidden />
        </div>
        <span className="text-lg font-bold" style={{ fontFamily: "'Space Grotesk'", color: "var(--text)" }}>
          FuelMart
        </span>
      </button>
      {children}
    </div>
  );

  if (loading) {
    return shell(
      <div className="card p-8 text-center">
        <i className="fas fa-circle-notch fa-spin text-2xl mb-3" style={{ color: "var(--primary)" }} aria-hidden />
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Loading your application…
        </p>
      </div>,
    );
  }

  if (error === "NO_ID") {
    return shell(
      <div className="card p-8 text-center">
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
          style={{ background: "var(--bg2)", border: "1px solid var(--border)" }}
        >
          <i className="fas fa-file-circle-question text-2xl" style={{ color: "var(--muted)" }} aria-hidden />
        </div>
        <h1 className="text-xl font-bold mb-2" style={{ fontFamily: "'Space Grotesk'", color: "var(--text)" }}>
          No application found
        </h1>
        <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>
          We couldn&apos;t tell which application to show. Open the link from your confirmation email, or apply below.
        </p>
        <div className="flex gap-3 justify-center">
          <button className="btn btn-primary" onClick={() => navigate("/vendor-register")}>
            <i className="fas fa-store mr-2" aria-hidden />
            Apply as a vendor
          </button>
          <button className="btn btn-outline" onClick={() => navigate("/login")}>
            Sign in
          </button>
        </div>
      </div>,
    );
  }

  if (error || !app) {
    return shell(
      <div className="card p-8 text-center" style={{ borderColor: "var(--status-bad)" }}>
        <i className="fas fa-triangle-exclamation text-2xl mb-3" style={{ color: "var(--status-bad)" }} aria-hidden />
        <h1 className="text-xl font-bold mb-2" style={{ fontFamily: "'Space Grotesk'", color: "var(--text)" }}>
          Couldn&apos;t load your application
        </h1>
        <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>
          {error}
        </p>
        <button className="btn btn-primary" onClick={() => void load()}>
          <i className="fas fa-rotate-right mr-2" aria-hidden />
          Try again
        </button>
      </div>,
    );
  }

  const v = statusVisual(app.vendorStatus, app.activated);
  const isApproved = app.vendorStatus === "active";
  const needsActivation = isApproved && !app.activated;
  const fullyActive = isApproved && !!app.activated;

  const steps = [
    { label: "Application submitted", done: true, date: fmtDate(app.appliedAt) },
    {
      label: app.vendorStatus === "rejected" ? "Reviewed — not approved" : "Reviewed by admin",
      done: ["under_review", "active", "rejected", "suspended"].includes(app.vendorStatus ?? ""),
      date: app.vendorStatus === "rejected" ? fmtDate(app.rejectedAt) : app.approvedAt ? fmtDate(app.approvedAt) : "—",
    },
    { label: "Approved", done: isApproved, date: fmtDate(app.approvedAt) },
    { label: "Dashboard activated", done: !!app.activated, date: app.activated ? "Done" : "—" },
  ];

  return shell(
    <>
      <div className="card p-6 mb-5" style={{ animation: "slideUp .35s ease" }}>
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-widest mb-1" style={{ color: "var(--muted)" }}>
              Vendor application
            </p>
            <h1 className="text-2xl font-bold truncate" style={{ fontFamily: "'Space Grotesk'", color: "var(--text)" }}>
              {app.businessName || app.name || "Your application"}
            </h1>
          </div>
          <span
            className="px-3 py-1.5 rounded-full text-xs font-bold flex-shrink-0 flex items-center gap-1.5"
            style={{ background: v.bg, color: v.color, border: `1px solid ${v.color}` }}
          >
            <i className={`fas ${v.icon}`} aria-hidden /> {v.label}
          </span>
        </div>

        <ol className="space-y-3">
          {steps.map((s) => (
            <li key={s.label} className="flex items-center gap-3">
              <span
                className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-[10px]"
                style={{
                  background: s.done ? "var(--status-good-bg)" : "var(--bg2)",
                  color: s.done ? "var(--status-good)" : "var(--muted)",
                  border: `1px solid ${s.done ? "var(--status-good)" : "var(--border)"}`,
                }}
              >
                <i className={`fas ${s.done ? "fa-check" : "fa-minus"}`} aria-hidden />
              </span>
              <span className="text-sm flex-1" style={{ color: s.done ? "var(--text)" : "var(--muted)" }}>
                {s.label}
              </span>
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                {s.date}
              </span>
            </li>
          ))}
        </ol>

        {app.rejectionReason && (
          <p
            className="text-xs mt-4 p-3 rounded-xl"
            style={{ background: "var(--status-bad-bg)", color: "var(--status-bad)" }}
          >
            {app.rejectionReason}
          </p>
        )}
      </div>

      {needsActivation && (
        <div className="card p-6 mb-5">
          <h2 className="text-base font-bold mb-1" style={{ fontFamily: "'Space Grotesk'" }}>
            Activate your dashboard
          </h2>
          <p className="text-xs mb-4" style={{ color: "var(--muted)" }}>
            Enter the activation code from your approval email.
          </p>
          <div className="flex gap-2">
            <input
              className="input-field flex-1"
              placeholder="Activation code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button className="btn btn-primary" onClick={activate} disabled={activating}>
              {activating ? "…" : "Activate"}
            </button>
          </div>
        </div>
      )}

      {fullyActive && (
        <button className="btn btn-primary btn-block" onClick={() => navigate("/vendor")}>
          <i className="fas fa-arrow-right mr-2" aria-hidden />
          Open your dashboard
        </button>
      )}
    </>,
  );
}
