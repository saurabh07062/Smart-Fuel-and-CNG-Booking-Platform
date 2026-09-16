import { useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { requestPasswordReset } from "@/services/api/authApi";
import AuthShell from "@/components/auth/AuthShell";
import Button from "@/components/common/Button";

/**
 * Ask for a password reset link (POST /api/auth/forgot-password).
 *
 * After a request the server accepted, the page shows one generic message --
 * the same for a registered and an unregistered address -- so it cannot be used
 * to find out who has an account. The email typed on the login page arrives in
 * router state, never in the URL.
 */
export default function ForgotPassword() {
  const location = useLocation();
  const initialEmail = (location.state as { email?: string } | null)?.email ?? "";

  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentMsg, setSentMsg] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const address = email.trim();
    if (!address) {
      setError("Please enter your email address.");
      return;
    }

    setBusy(true);
    const res = await requestPasswordReset(address);
    setBusy(false);

    if (res.ok) setSentMsg(res.msg);
    else setError(res.msg);
  }

  return (
    <AuthShell title="Forgot password?" subtitle="We'll email you a link to choose a new one">
      <div className="card p-6 md:p-8 shadow-2xl">
        {sentMsg ? (
          <div role="status">
            <div className="flex items-start gap-3 mb-6">
              <i className="fas fa-envelope-circle-check text-2xl" style={{ color: "var(--primary)" }} aria-hidden />
              <p className="text-[15px]" style={{ color: "var(--text2)" }}>
                {sentMsg}
              </p>
            </div>
            <p className="text-[13px] mb-6" style={{ color: "var(--muted)" }}>
              Check your spam folder if nothing arrives in a few minutes.
            </p>
            <Link to="/login" className="btn btn-primary btn-lg btn-block">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            <p className="text-[14px] mb-5" style={{ color: "var(--text2)" }}>
              Enter the email address you sign in with.
            </p>

            <label htmlFor="forgot-email" className="block text-[14px] font-semibold mb-2" style={{ color: "var(--text2)" }}>
              Email Address
            </label>
            <div className="input-group mb-2">
              <span className="input-icon">
                <i className="far fa-envelope text-lg" aria-hidden />
              </span>
              <input
                id="forgot-email"
                type="email"
                className="input-field"
                placeholder="name@company.com"
                value={email}
                autoComplete="email"
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <p role="alert" className="text-[13px] min-h-[20px] mb-4" style={{ color: "var(--danger, #ef4444)" }}>
              {error}
            </p>

            <Button type="submit" block size="lg" loading={busy}>
              {busy ? "Sending link…" : "Send reset link"}
            </Button>

            <p className="text-center text-[14px] mt-6" style={{ color: "var(--muted)" }}>
              Remembered it?{" "}
              <Link to="/login" className="font-bold" style={{ color: "var(--primary)" }}>
                Sign in
              </Link>
            </p>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
