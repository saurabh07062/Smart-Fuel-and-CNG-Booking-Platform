import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { register } from "@/services/api/authApi";
import { useAuthStore } from "@/store/authStore";
import { pushToast } from "@/store/toastStore";
import Button from "@/components/common/Button";
import { MIN_PASSWORD_LENGTH, passwordProblem } from "@/constants/auth";

/**
 * Create a customer account. Same card treatment as Login.
 *
 * Client-side validation deliberately mirrors what the server enforces
 * (backend/controllers/authController.js + services/notification/emailValidation.js)
 * rather than inventing new rules -- the server stays the authority, this
 * just avoids a round-trip for an obvious mistake. The typo suggestion the
 * backend returns ("did you mean ...@gmail.com?") is surfaced as-is.
 */
export default function Register() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [emailHint, setEmailHint] = useState<string | null>(null);

  const setSession = useAuthStore((s) => s.login);
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setEmailHint(null);

    if (!name.trim() || !email.trim() || !password) {
      pushToast("Please fill all fields", "error");
      return;
    }
    // Same rule as a password reset (constants/auth.ts).
    const problem = passwordProblem(password);
    if (problem) {
      pushToast(problem, "error");
      return;
    }
    if (password !== confirm) {
      pushToast("Passwords do not match", "error");
      return;
    }

    setBusy(true);
    const res = await register({ name: name.trim(), email: email.trim(), password });
    setBusy(false);

    if (!res.ok) {
      // The backend suggests a correction for a mistyped mail domain
      // ("gmail.comt" -> "gmail.com"). Showing it saves a support ticket.
      if (res.suggestion) setEmailHint(`Did you mean ${res.suggestion}?`);
      pushToast(res.msg, "error");
      return;
    }

    // A new account is signed in straight away: the server set the session cookies.
    if (res.data?.user) {
      setSession(res.data.user);
      pushToast("Account created successfully", "success");
      navigate("/dashboard", { replace: true });
    } else {
      pushToast(res.data?.msg ?? "Account created — please sign in", "success");
      navigate("/login", { replace: true });
    }
  }

  return (
    <div
      className="min-h-screen flex flex-col justify-between"
      style={{ background: "url('/bg-image.png') center/cover", position: "relative" }}
    >
      <div className="absolute inset-0" style={{ background: "rgba(11,17,32,0.7)" }} />

      <div className="relative z-10 pt-12 flex flex-col items-center">
        <div
          className="w-20 h-20 rounded-[20px] flex items-center justify-center shadow-lg"
          style={{ background: "#2563eb" }}
        >
          <i className="fas fa-gas-pump text-white text-[32px]" aria-hidden />
        </div>
        <h1
          className="text-[28px] font-bold text-white mt-3 drop-shadow-md"
          style={{ fontFamily: "'Space Grotesk'" }}
        >
          Create your account
        </h1>
        <p className="text-[15px] font-medium text-gray-200 mt-1 drop-shadow">
          Book fuel in seconds, skip the queue
        </p>
      </div>

      <div className="w-full max-w-md relative z-10 mx-auto mt-8 mb-auto px-4 pb-12">
        <form className="card p-6 md:p-8 shadow-2xl" onSubmit={handleSubmit}>
          <div className="field mb-4">
            <label className="field-label">Full Name</label>
            <div className="input-group">
              <span className="input-icon">
                <i className="far fa-user" aria-hidden />
              </span>
              <input
                className="input-field"
                placeholder="Your name"
                value={name}
                autoComplete="name"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>

          <div className="field mb-4">
            <label className="field-label">Email Address</label>
            <div className="input-group">
              <span className="input-icon">
                <i className="far fa-envelope" aria-hidden />
              </span>
              <input
                type="email"
                className="input-field"
                placeholder="name@company.com"
                value={email}
                autoComplete="email"
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            {emailHint && (
              <span className="field-hint" style={{ color: "var(--accent)" }}>
                {emailHint}
              </span>
            )}
          </div>

          <div className="field mb-4">
            <label className="field-label">Password</label>
            <div className="input-group">
              <span className="input-icon">
                <i className="fas fa-lock" aria-hidden />
              </span>
              <input
                type="password"
                className="input-field"
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                value={password}
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          <div className="field mb-6">
            <label className="field-label">Confirm Password</label>
            <div className="input-group">
              <span className="input-icon">
                <i className="fas fa-lock" aria-hidden />
              </span>
              <input
                type="password"
                className="input-field"
                placeholder="Repeat your password"
                value={confirm}
                autoComplete="new-password"
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          </div>

          <Button type="submit" block size="lg" loading={busy}>
            {busy ? "Creating account…" : "Create Account"}
          </Button>

          <p className="text-center text-[14px] mt-6" style={{ color: "var(--muted)" }}>
            Already have an account?{" "}
            <Link to="/login" className="font-bold" style={{ color: "var(--primary)" }}>
              Sign in
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
