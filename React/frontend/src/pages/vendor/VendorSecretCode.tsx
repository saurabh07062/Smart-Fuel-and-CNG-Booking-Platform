import { useState } from "react";
import { useNavigate } from "react-router-dom";
import * as api from "@/services/api/vendorApi";
import { useAuthStore } from "@/store/authStore";
import { pushToast } from "@/store/toastStore";
import { toApiError } from "@/services/api/apiClient";
import type { User } from "@/types";

/**
 * Port of js/pages/vendorSecretCode.js -- redeeming the emailed access code.
 *
 * Reached SIGNED OUT, from the approval email, which is why this route is
 * public and why the endpoint behind it is rate limited per IP and per email
 * (backend/routes/vendorAccessRoutes.js). A successful verify sets the
 * vendor's session cookies, so this page signs the vendor in and opens the
 * console.
 *
 * The markup mirrors the original element for element (.vsc-page > .vsc-card
 * > .vsc-back / .vsc-head / .vsc-field > .vsc-input-wrap …) so the existing
 * vendor-secret-code.css applies unchanged.
 */
export default function VendorSecretCode() {
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const goHome = () => navigate("/");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !code.trim()) {
      setError("Enter both your registered email and the secret code.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const r = await api.redeemVendorSecretCode(email.trim(), code.trim());
      if (r.user) {
        setSuccess(true);
        login(r.user as User);
        pushToast(r.msg || "Access granted", "success");
        // replace: the sign-in form is not a page to go Back to once signed in.
        navigate("/vendor", { replace: true });
        return;
      }
      // A 200 without a user means the server accepted the request but did
      // not grant a session; show its own message rather than inventing one.
      setError(r.msg || "That code was not accepted.");
    } catch (err) {
      setError(toApiError(err).msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="vsc-page">
      <div className="vsc-card">
        <button type="button" className="vsc-back" onClick={goHome}>
          <i className="fas fa-arrow-left" aria-hidden /> Back to Home
        </button>

        <div className="vsc-head">
          <div className="vsc-lock">
            <i className="fas fa-lock" aria-hidden />
          </div>
          <h1 className="vsc-title">Vendor Admin Access</h1>
          <p className="vsc-sub">
            Enter the registered email and the secret code from your approval email
          </p>
        </div>

        <form className="vsc-form" onSubmit={submit}>
          <div className="vsc-field">
            <label htmlFor="vsc-email">Registered Email</label>
            <div className="vsc-input-wrap">
              <i className="fas fa-envelope" aria-hidden />
              <input
                id="vsc-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@business.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading || success}
                required
              />
            </div>
          </div>

          <div className="vsc-field">
            <label htmlFor="vsc-code">Secret Code</label>
            <div className="vsc-input-wrap">
              <i className="fas fa-key" aria-hidden />
              <input
                id="vsc-code"
                name="code"
                type="text"
                autoComplete="one-time-code"
                placeholder="XXXX-XXXX-XXXX"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={loading || success}
                required
              />
            </div>
            <p className="vsc-hint">
              Use the same code every time you open your dashboard. It locks after 5 incorrect
              attempts in a row. Case does not matter and dashes are optional.
            </p>
          </div>

          {error && (
            <p
              className="vsc-hint"
              style={{ color: "var(--status-bad)" }}
              role="alert"
            >
              {error}
            </p>
          )}

          <button type="submit" className="vsc-btn vsc-btn-primary" disabled={loading || success}>
            {loading ? (
              <>
                <span className="vsc-spinner" aria-hidden /> Verifying…
              </>
            ) : (
              "Unlock Vendor Panel"
            )}
          </button>

          <button type="button" className="vsc-btn vsc-btn-ghost" onClick={goHome}>
            Back to Home
          </button>
        </form>
      </div>
    </div>
  );
}
