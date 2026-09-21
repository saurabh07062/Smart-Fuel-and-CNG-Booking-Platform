import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { login, resendVerification } from "@/services/api/authApi";
import { authDestination } from "@/utils/authDestination";
import { useAuthStore } from "@/store/authStore";
import { pushToast } from "@/store/toastStore";
import Button from "@/components/common/Button";

/**
 * Sign in. Visually a direct port of renderLogin() in js/pages/login.js --
 * same background treatment, same logo block, same card, same input groups.
 *
 * WHAT IS DELIBERATELY NOT PORTED
 *
 * The Vanilla handler began with two hardcoded credential checks:
 *
 *   if (email === "Saurabh07062@gmail.com" && pass === "PCJQQV90Q") { ... }
 *   if (email === "superadmin@fuelmart.com" && pass === "superadmin") {
 *     localStorage.setItem("fm-superadmin", "true");   // <- that WAS the auth
 *     state.isSuperAdmin = true;
 *   }
 *
 * The first shipped a real admin password inside the JavaScript bundle. The
 * second never contacted the server at all: setting one localStorage key was
 * the entire authentication, so anyone who opened devtools could become super
 * admin. Neither is reproduced. Every sign-in here goes through
 * POST /api/auth/login and the role comes from the server's response.
 */
export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);

  const setSession = useAuthStore((s) => s.login);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email || !password) {
      pushToast("Please fill all fields", "error");
      return;
    }

    setBusy(true);
    setNeedsVerification(false);

    const res = await login(email.trim(), password);
    setBusy(false);

    if (!res.ok || !res.data) {
      if (res.needsVerification) {
        setNeedsVerification(true);
        pushToast(res.msg ?? "Please verify your email", "warning");
      } else {
        pushToast(res.msg ?? "Invalid credentials", "error");
      }
      return;
    }

    // The server set the session cookies on this response.
    const { user } = res.data;
    setSession(user);

    // Same messages the Vanilla app showed, so nothing feels different. The
    // vendor ones are left out of the customer app build.
    const website = import.meta.env.VITE_APP_MODE !== "customer";
    if (website && user.role === "vendor" && user.vendorStatus !== "active") {
      pushToast(`Your vendor application is ${user.vendorStatus}.`, "warning");
    } else if (website && user.role === "vendor" && user.activated === false) {
      pushToast("Enter your secret code to open your dashboard", "info");
    } else {
      pushToast(`Welcome back, ${user.name.split(" ")[0]}!`, "success");
    }

    navigate(authDestination(user, from && from !== "/login" ? from : "/dashboard"), {
      replace: true,
    });
  }

  async function handleResend() {
    setBusy(true);
    const res = await resendVerification(email.trim());
    setBusy(false);
    pushToast(res.ok ? (res.msg ?? "Verification email sent") : res.msg, res.ok ? "success" : "error");
  }

  return (
    <div
      className="min-h-screen flex flex-col justify-between"
      style={{ background: `url('${import.meta.env.BASE_URL}bg-image.png') center/cover`, position: "relative" }}
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
          FuelMart
        </h1>
        <p className="text-[15px] font-medium text-gray-200 mt-1 drop-shadow">
          Premium Logistics &amp; Secure Energy Management
        </p>
      </div>

      <div className="w-full max-w-md relative z-10 mx-auto mt-8 mb-auto px-4 pb-12">
        <form className="card p-6 md:p-8 shadow-2xl" onSubmit={handleSubmit}>
          <label className="block text-[14px] font-semibold mb-2" style={{ color: "var(--text2)" }}>
            Email Address
          </label>
          <div className="input-group mb-5">
            <span className="input-icon">
              <i className="far fa-envelope text-lg" aria-hidden />
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

          <label className="block text-[14px] font-semibold mb-2" style={{ color: "var(--text2)" }}>
            Password
          </label>
          <div className="input-group mb-5">
            <span className="input-icon">
              <i className="fas fa-lock" aria-hidden />
            </span>
            <input
              type={showPassword ? "text" : "password"}
              className="input-field tracking-widest"
              placeholder="••••••••"
              value={password}
              autoComplete="current-password"
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

          <div className="flex items-center justify-between mb-7">
            <label
              className="flex items-center gap-2 cursor-pointer text-[14px] font-medium"
              style={{ color: "var(--text2)" }}
            >
              <input type="checkbox" defaultChecked className="w-4 h-4 rounded" /> Remember me
            </label>
            {/* The typed email travels in router state, never in the URL. */}
            <Link
              to="/forgot-password"
              state={{ email: email.trim() }}
              className="text-[14px] font-bold"
              style={{ color: "var(--primary)" }}
            >
              Forgot password?
            </Link>
          </div>

          <Button type="submit" block size="lg" loading={busy}>
            {busy ? "Signing in…" : "Sign In"}
          </Button>

          {needsVerification && (
            <Button
              type="button"
              variant="outline"
              block
              className="mt-3"
              loading={busy}
              onClick={handleResend}
            >
              Resend Verification Email
            </Button>
          )}

          <p className="text-center text-[14px] mt-6" style={{ color: "var(--muted)" }}>
            New to FuelMart?{" "}
            <Link to="/register" className="font-bold" style={{ color: "var(--primary)" }}>
              Create an account
            </Link>
          </p>
          {import.meta.env.VITE_APP_MODE !== "customer" && (
          <p className="text-center text-[13px] mt-2" style={{ color: "var(--muted)" }}>
            Approved vendor?{" "}
            <Link to="/vendor/secret-code" className="font-bold" style={{ color: "var(--primary)" }}>
              Vendor Secret Code
            </Link>
          </p>
          )}
        </form>
      </div>
    </div>
  );
}
