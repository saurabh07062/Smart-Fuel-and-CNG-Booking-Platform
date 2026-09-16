import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { resetPassword } from "@/services/api/authApi";
import { MIN_PASSWORD_LENGTH, passwordProblem } from "@/constants/auth";
import { useAuthStore } from "@/store/authStore";
import { pushToast } from "@/store/toastStore";
import AuthShell from "@/components/auth/AuthShell";
import Button from "@/components/common/Button";

type Status = "form" | "submitting" | "success" | "invalid";

/**
 * Choose a new password from the emailed link: /reset-password?token=...
 * (POST /api/auth/reset-password).
 *
 * The token is read from the URL once, held only in this component's memory,
 * and the address bar is replaced with plain /reset-password straight away, so
 * the token is not left in history, a copied URL or a later screenshot. It is
 * never rendered, logged or written to storage.
 *
 * On success the server has signed the account out on every device; this
 * browser forgets any signed-in profile too, then goes to the sign-in page.
 */
export default function ResetPassword({ redirectDelayMs = 2500 }: { redirectDelayMs?: number }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();

  const [token] = useState(() => params.get("token")?.trim() ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState<Status>(token ? "form" : "invalid");
  const [error, setError] = useState<string | null>(null);

  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const logout = useAuthStore((s) => s.logout);

  // Drop ?token=... from the address bar once it has been read.
  useEffect(() => {
    if (params.has("token")) navigate(location.pathname, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status !== "success") return;
    const timer = window.setTimeout(() => navigate("/login", { replace: true }), redirectDelayMs);
    return () => window.clearTimeout(timer);
  }, [status, navigate, redirectDelayMs]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const problem = passwordProblem(password);
    if (problem) {
      setError(problem);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setStatus("submitting");
    const res = await resetPassword(token, password);

    if (res.ok) {
      setPassword("");
      setConfirm("");
      // The server already ended every session for this account.
      if (isAuthenticated) await logout();
      setStatus("success");
      pushToast("Password reset. Sign in with your new password.", "success");
      return;
    }
    if (res.reason === "INVALID_RESET_TOKEN") {
      setStatus("invalid");
      return;
    }
    setStatus("form");
    setError(res.msg);
  }

  return (
    <AuthShell title="Reset password" subtitle="Choose a new password for your account">
      <div className="card p-6 md:p-8 shadow-2xl">
        {status === "success" && (
          <div role="status">
            <div className="flex items-start gap-3 mb-6">
              <i className="fas fa-circle-check text-2xl" style={{ color: "var(--success, #10b981)" }} aria-hidden />
              <p className="text-[15px]" style={{ color: "var(--text2)" }}>
                Your password has been reset. Every device was signed out. Taking you to sign in…
              </p>
            </div>
            <Link to="/login" replace className="btn btn-primary btn-lg btn-block">
              Sign in now
            </Link>
          </div>
        )}

        {status === "invalid" && (
          <div role="alert">
            <div className="flex items-start gap-3 mb-6">
              <i className="fas fa-link-slash text-2xl" style={{ color: "var(--danger, #ef4444)" }} aria-hidden />
              <p className="text-[15px]" style={{ color: "var(--text2)" }}>
                This password reset link is invalid or has expired. Links work once and for 1 hour.
              </p>
            </div>
            <Link to="/forgot-password" className="btn btn-primary btn-lg btn-block">
              Request a new link
            </Link>
            <p className="text-center text-[14px] mt-6" style={{ color: "var(--muted)" }}>
              <Link to="/login" className="font-bold" style={{ color: "var(--primary)" }}>
                Back to sign in
              </Link>
            </p>
          </div>
        )}

        {(status === "form" || status === "submitting") && (
          <form onSubmit={handleSubmit} noValidate>
            <label htmlFor="reset-password" className="block text-[14px] font-semibold mb-2" style={{ color: "var(--text2)" }}>
              New Password
            </label>
            <div className="input-group mb-5">
              <span className="input-icon">
                <i className="fas fa-lock" aria-hidden />
              </span>
              <input
                id="reset-password"
                type={showPassword ? "text" : "password"}
                className="input-field"
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                value={password}
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="absolute right-4 top-1/2 -translate-y-1/2 text-lg"
                style={{ color: "var(--muted)", background: "none", border: "none" }}
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                <i className={`far ${showPassword ? "fa-eye-slash" : "fa-eye"}`} aria-hidden />
              </button>
            </div>

            <label htmlFor="reset-confirm" className="block text-[14px] font-semibold mb-2" style={{ color: "var(--text2)" }}>
              Confirm New Password
            </label>
            <div className="input-group mb-2">
              <span className="input-icon">
                <i className="fas fa-lock" aria-hidden />
              </span>
              <input
                id="reset-confirm"
                type={showPassword ? "text" : "password"}
                className="input-field"
                placeholder="Repeat the new password"
                value={confirm}
                autoComplete="new-password"
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>

            <p role="alert" className="text-[13px] min-h-[20px] mb-4" style={{ color: "var(--danger, #ef4444)" }}>
              {error}
            </p>

            <Button type="submit" block size="lg" loading={status === "submitting"}>
              {status === "submitting" ? "Resetting password…" : "Reset password"}
            </Button>

            <p className="text-center text-[14px] mt-6" style={{ color: "var(--muted)" }}>
              <Link to="/login" className="font-bold" style={{ color: "var(--primary)" }}>
                Back to sign in
              </Link>
            </p>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
