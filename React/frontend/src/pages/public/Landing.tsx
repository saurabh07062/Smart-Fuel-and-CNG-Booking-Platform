import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useStationStore } from "@/store/stationStore";
import { useWatchStations } from "@/hooks/useSocket";
import { useUiStore } from "@/store/uiStore";

/**
 * Port of renderLanding() in js/pages/landing.js -- same sections, copy,
 * icons, colours and animations. The only behavioural difference: the Vanilla
 * "Find Stations" button set `state.isLoggedIn = true` without signing in; here
 * it goes to /stations and the route guard asks a guest to log in first.
 */
const STATS: Array<[string, string, string]> = [
  ["50K+", "Active Users", "fa-users"],
  ["1.2K+", "Fuel Stations", "fa-gas-pump"],
  ["2M+", "Bookings Done", "fa-calendar-check"],
];

const FEATURES: Array<[string, string, string, string]> = [
  ["fa-location-crosshairs", "Find Stations", "Real-time geolocation detection shows all nearby petrol pumps and CNG stations with live queue status.", "#2563EB"],
  ["fa-calendar-check", "Book Slots", "Reserve your time slot, choose fuel type and quantity. No more waiting in long queues at the pump.", "#10B981"],
  ["fa-qrcode", "QR Pass", "Get a digital QR booking pass. Scan at the station for instant verification and fueling.", "#F97316"],
  ["fa-wallet", "Digital Payments", "Pay via wallet, UPI, or cards. Track every transaction with detailed payment history.", "#8B5CF6"],
  ["fa-bell", "Smart Alerts", "Get notified about slot reminders, queue updates, price changes, and exclusive offers.", "#EC4899"],
  ["fa-shield-halved", "Secure & Fast", "JWT authentication, encrypted data, and OTP verification keep your account safe.", "#06B6D4"],
];

const STEPS: Array<[string, string, string]> = [
  ["fa-search", "Find Station", "Locate nearby stations on the map with live data."],
  ["fa-hand-pointer", "Select & Book", "Choose fuel type, slot, and quantity."],
  ["fa-credit-card", "Pay Digitally", "Complete payment via wallet or UPI."],
  ["fa-qrcode", "Scan QR & Fuel", "Show QR pass at the station and fuel up."],
];

const SOCIALS = [
  { icon: "fa-instagram", url: "https://instagram.com/yadav_saurabh_709" },
  { icon: "fa-linkedin", url: "https://www.linkedin.com/in/saurabh-yadav-8758882b3/" },
  { icon: "fa-github", url: "https://github.com/saurabh07062" },
];

/** utils.js getQueueColor(), unchanged. */
const queueColor = (q: number) => (q <= 2 ? "var(--secondary)" : q <= 5 ? "var(--accent)" : "var(--danger)");

export default function Landing() {
  const navigate = useNavigate();
  const stations = useStationStore((s) => s.stations);
  const loadStations = useStationStore((s) => s.load);
  const darkMode = useUiStore((s) => s.darkMode);
  const toggleTheme = useUiStore((s) => s.toggleTheme);

  useEffect(() => {
    // Vanilla init() fetched STATIONS before the first render; the hero card reads it.
    if (stations.length === 0) void loadStations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The hero card shows these three stations' live queue and wait; follow
  // their station rooms (public events) so it updates without a refresh.
  useWatchStations(useMemo(() => stations.slice(0, 3).map((s) => s.id), [stations]));

  const blob = (style: React.CSSProperties) => (
    <div style={{ position: "absolute", borderRadius: "50%", ...style }} />
  );

  return (
    <div className="min-h-screen relative overflow-hidden" style={{ background: "var(--bg)" }}>
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {blob({ width: 500, height: 500, background: "radial-gradient(circle,rgba(37,99,235,.15),transparent 70%)", top: "-10%", left: "-5%", animation: "blob1 18s ease-in-out infinite" })}
        {blob({ width: 400, height: 400, background: "radial-gradient(circle,rgba(16,185,129,.12),transparent 70%)", top: "40%", right: "-8%", animation: "blob2 22s ease-in-out infinite" })}
        {blob({ width: 350, height: 350, background: "radial-gradient(circle,rgba(249,115,22,.1),transparent 70%)", bottom: "-5%", left: "30%", animation: "blob1 20s ease-in-out infinite reverse" })}
      </div>

      <nav className="relative z-10 flex items-center justify-between px-6 py-4 max-w-7xl mx-auto">
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => navigate("/")}>
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "var(--primary)" }}>
            <i className="fas fa-gas-pump text-white text-lg" aria-hidden />
          </div>
          <span className="text-xl font-bold" style={{ fontFamily: "'Space Grotesk'" }}>FuelMart</span>
        </div>
        <div className="hidden md:flex items-center gap-8">
          <a href="#features" className="text-sm font-medium" style={{ color: "var(--muted)" }}>Features</a>
          <a href="#how" className="text-sm font-medium" style={{ color: "var(--muted)" }}>How It Works</a>
          <a href="#stats" className="text-sm font-medium" style={{ color: "var(--muted)" }}>Stats</a>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={toggleTheme} className="btn btn-ghost btn-sm" aria-label="Toggle theme">
            <i className={`fas fa-${darkMode ? "sun" : "moon"}`} aria-hidden />
          </button>
          <button onClick={() => navigate("/login")} className="btn btn-outline btn-sm">Log In</button>
          <button onClick={() => navigate("/register")} className="btn btn-primary btn-sm">Sign Up</button>
          <button onClick={() => navigate("/vendor-register")} className="btn btn-accent btn-sm">Vendor Sign Up</button>
          <button onClick={() => navigate("/vendor/secret-code")} className="btn btn-secret btn-sm">
            <i className="fas fa-lock" aria-hidden /> Vendor Secret Code
          </button>
        </div>
      </nav>

      <section className="relative z-10 max-w-7xl mx-auto px-6 pt-16 pb-24 md:pt-24 md:pb-32">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <div className="badge badge-blue mb-6" style={{ animation: "slideUp .5s ease both" }}>
              <i className="fas fa-bolt mr-1" aria-hidden /> Smart Fuel Booking Platform
            </div>
            <h1 className="text-4xl md:text-6xl font-bold leading-tight mb-6" style={{ animation: "slideUp .6s ease both", fontFamily: "'Space Grotesk'" }}>
              Skip the Queue.
              <br />
              <span style={{ color: "var(--primary)" }}>Book Fuel</span> Instantly.
            </h1>
            <p className="text-lg mb-8 max-w-md" style={{ color: "var(--muted)", animation: "slideUp .7s ease both" }}>
              Find nearby stations, book your fuel slot, pay digitally, and arrive to a zero-wait experience. Smart fueling for modern India.
            </p>
            <div className="flex flex-wrap gap-4" style={{ animation: "slideUp .8s ease both" }}>
              <button onClick={() => navigate("/register")} className="btn btn-primary btn-lg">
                <i className="fas fa-rocket" aria-hidden /> Get Started Free
              </button>
              <button onClick={() => navigate("/stations")} className="btn btn-outline btn-lg">
                <i className="fas fa-map-marked-alt" aria-hidden /> Find Stations
              </button>
            </div>
            <div className="flex items-center gap-6 mt-10" style={{ animation: "slideUp .9s ease both" }}>
              <div className="flex -space-x-3">
                {[101, 102, 103, 104].map((i) => (
                  <img key={i} src={`https://picsum.photos/seed/user${i}/40/40.jpg`} alt="" className="w-9 h-9 rounded-full border-2" style={{ borderColor: "var(--bg)" }} />
                ))}
              </div>
              <div>
                <p className="text-xs"style={{ color: "var(--muted)" }}>Trusted by 50,000+ users</p>
              </div>
            </div>
          </div>

          <div className="relative" style={{ animation: "fadeIn 1s ease .3s both" }}>
            <div className="card-glass p-6 rounded-2xl" style={{ animation: "float 6s ease-in-out infinite" }}>
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "var(--secondary-light)" }}>
                  <i className="fas fa-map-pin" style={{ color: "var(--secondary)" }} aria-hidden />
                </div>
                <div>
                  <p className="text-sm font-semibold">Nearby Stations</p>
                  <p className="text-xs" style={{ color: "var(--muted)" }}>3 stations within 2 km</p>
                </div>
              </div>
              {stations.slice(0, 3).map((s) => (
                <div key={String(s._id)} className="flex items-center gap-3 p-3 rounded-xl mb-2 cursor-pointer transition-all hover:scale-[1.02]" style={{ background: "var(--bg)" }}>
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: s.queue <= 2 ? "var(--secondary-light)" : "var(--accent-light)" }}>
                    <i className="fas fa-gas-pump text-sm" style={{ color: s.queue <= 2 ? "var(--secondary)" : "var(--accent)" }} aria-hidden />
                  </div>
                  <div className="flex-1 min-w-0">
                    {/* Vanilla printed name.split(" - ")[1]; falls back to the full name
                        rather than "undefined" for a name without " - ". */}
                    <p className="text-sm font-medium truncate">{s.name.split(" - ")[1] ?? s.name}</p>
                    <p className="text-xs" style={{ color: "var(--muted)" }}>{s.distance ?? "—"} km · Queue: {s.queue}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-bold" style={{ color: queueColor(s.queue) }}>{s.waitTime} min</p>
                  </div>
                </div>
              ))}
              <div className="mt-4 p-3 rounded-xl flex items-center gap-3" style={{ background: "var(--primary-light)" }}>
                <i className="fas fa-bolt" style={{ color: "var(--primary)" }} aria-hidden />
                <p className="text-sm font-medium" style={{ color: "var(--primary)" }}>Book now &amp; save 15 min wait time</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="stats" className="relative z-10 max-w-7xl mx-auto px-6 pb-20">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {STATS.map(([v, l, i], idx) => (
            <div key={l} className="card p-5 text-center" style={{ animation: `slideUp .5s ease ${idx * 0.1}s both` }}>
              <i className={`fas ${i} text-lg mb-3`} style={{ color: "var(--primary)" }} aria-hidden />
              <p className="text-2xl md:text-3xl font-bold" style={{ fontFamily: "'Space Grotesk'" }}>{v}</p>
              <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>{l}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="features" className="relative z-10 max-w-7xl mx-auto px-6 pb-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold mb-3" style={{ fontFamily: "'Space Grotesk'" }}>Everything You Need</h2>
          <p style={{ color: "var(--muted)" }} className="max-w-md mx-auto">
            A complete fuel booking ecosystem designed for speed, reliability, and convenience.
          </p>
        </div>
        <div className="grid md:grid-cols-3 gap-6">
          {FEATURES.map(([icon, title, desc, color], i) => (
            <div key={title} className="card p-6 group hover:-translate-y-1 transition-all" style={{ animation: `slideUp .5s ease ${i * 0.08}s both` }}>
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4 transition-transform group-hover:scale-110" style={{ background: `${color}18` }}>
                <i className={`fas ${icon} text-lg`} style={{ color }} aria-hidden />
              </div>
              <h3 className="text-lg font-bold mb-2" style={{ fontFamily: "'Space Grotesk'" }}>{title}</h3>
              <p className="text-sm leading-relaxed" style={{ color: "var(--muted)" }}>{desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how" className="relative z-10 max-w-7xl mx-auto px-6 pb-24">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold mb-3" style={{ fontFamily: "'Space Grotesk'" }}>How It Works</h2>
          <p style={{ color: "var(--muted)" }}>Book your fuel in four simple steps</p>
        </div>
        <div className="grid md:grid-cols-4 gap-6">
          {STEPS.map(([icon, t, d], i) => (
            <div key={t} className="text-center" style={{ animation: `slideUp .5s ease ${i * 0.12}s both` }}>
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 relative" style={{ background: "var(--primary-light)" }}>
                <i className={`fas ${icon} text-xl`} style={{ color: "var(--primary)" }} aria-hidden />
                <span className="absolute -top-2 -right-2 w-7 h-7 rounded-full text-white text-xs font-bold flex items-center justify-center" style={{ background: "var(--primary)" }}>
                  {i + 1}
                </span>
              </div>
              <h4 className="font-bold mb-1">{t}</h4>
              <p className="text-sm" style={{ color: "var(--muted)" }}>{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="relative z-10 max-w-4xl mx-auto px-6 pb-24">
        <div className="rounded-3xl p-10 md:p-16 text-center relative overflow-hidden" style={{ background: "linear-gradient(135deg,#2563EB,#1d4ed8,#1e40af)" }}>
          <div className="absolute inset-0 opacity-10" style={{ backgroundImage: "radial-gradient(circle at 20% 80%,#fff 1px,transparent 1px),radial-gradient(circle at 80% 20%,#fff 1px,transparent 1px)", backgroundSize: "60px 60px" }} />
          <div className="relative z-10">
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4" style={{ fontFamily: "'Space Grotesk'" }}>Ready to Skip the Queue?</h2>
            <p className="text-blue-200 mb-8 max-w-md mx-auto">Join thousands of smart drivers who never wait at the fuel station again.</p>
            <button onClick={() => navigate("/register")} className="btn btn-accent btn-lg">
              <i className="fas fa-rocket" aria-hidden /> Create Free Account
            </button>
          </div>
        </div>
      </section>

      <footer className="relative z-10 border-t py-10 px-6" style={{ borderColor: "var(--border)" }}>
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "var(--primary)" }}>
              <i className="fas fa-gas-pump text-white text-sm" aria-hidden />
            </div>
            <span className="font-bold" style={{ fontFamily: "'Space Grotesk'" }}>FuelMart</span>
          </div>
          <p className="text-sm" style={{ color: "var(--muted)" }}>2026 FuelMart. All rights reserved. Built for modern India.</p>
          <div className="flex gap-4">
            {SOCIALS.map((s) => (
              <a
                key={s.icon}
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="w-9 h-9 rounded-lg flex items-center justify-center transition-colors"
                style={{ background: "var(--bg2)", color: "var(--muted)" }}
                onMouseOver={(e) => { e.currentTarget.style.background = "var(--primary)"; e.currentTarget.style.color = "#fff"; }}
                onMouseOut={(e) => { e.currentTarget.style.background = "var(--bg2)"; e.currentTarget.style.color = "var(--muted)"; }}
              >
                <i className={`fab ${s.icon} text-sm`} aria-hidden />
              </a>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
