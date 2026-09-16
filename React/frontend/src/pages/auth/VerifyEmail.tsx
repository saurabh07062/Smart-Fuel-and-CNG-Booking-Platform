import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { verifyEmail } from "@/services/api/authApi";

/**
 * Port of renderVerifyEmail() in js/pages/auth.js plus the `?verify=` branch
 * of app.js init(). Same three states (verifying / verified / failed), same copy.
 */
export default function VerifyEmail({ token }: { token: string }) {
  const navigate = useNavigate();
  const [state, setState] = useState<"loading" | "success" | "error">("loading");
  const [msg, setMsg] = useState("Invalid or expired token.");
  // The token is single-use: StrictMode's double effect would verify it, then
  // report the second call's "invalid token" as the result.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void verifyEmail(token).then((r) => {
      if (r.ok) setState("success");
      else {
        setMsg(r.msg);
        setState("error");
      }
    });
  }, [token]);

  const icon = (bg: string, cls: string, color: string) => (
    <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6" style={{ background: bg }}>
      <i className={`fas ${cls} text-2xl`} style={{ color }} aria-hidden />
    </div>
  );

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: "var(--bg)" }}>
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          style={{
            position: "absolute", width: 350, height: 350, borderRadius: "50%",
            background: "radial-gradient(circle,rgba(37,99,235,.12),transparent 70%)",
            bottom: "5%", right: "-5%", animation: "blob2 18s ease-in-out infinite",
          }}
        />
      </div>
      <div className="w-full max-w-sm relative z-10 text-center card p-8 shadow-xl">
        {state === "loading" && (
          <div>
            {icon("var(--primary-light)", "fa-spinner fa-spin", "var(--primary)")}
            <h1 className="text-2xl font-bold mb-2" style={{ fontFamily: "'Space Grotesk'" }}>Verifying Email...</h1>
            <p className="text-sm text-[var(--muted)]">Please wait while we verify your secure token.</p>
          </div>
        )}
        {state === "success" && (
          <div>
            {icon("var(--secondary-light)", "fa-check-circle", "var(--secondary)")}
            <h1 className="text-2xl font-bold mb-2" style={{ fontFamily: "'Space Grotesk'" }}>Email Verified!</h1>
            <p className="text-sm mb-6 text-[var(--muted)]">Your account has been successfully verified.</p>
            <button onClick={() => navigate("/login", { replace: true })} className="btn btn-primary btn-block">
              Go to Login
            </button>
          </div>
        )}
        {state === "error" && (
          <div>
            {icon("var(--danger-light)", "fa-times-circle", "var(--danger)")}
            <h1 className="text-2xl font-bold mb-2" style={{ fontFamily: "'Space Grotesk'" }}>Verification Failed</h1>
            <p className="text-sm mb-6 text-[var(--muted)]">{msg}</p>
            <button onClick={() => navigate("/login", { replace: true })} className="btn btn-outline btn-block">
              Back to Login
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
