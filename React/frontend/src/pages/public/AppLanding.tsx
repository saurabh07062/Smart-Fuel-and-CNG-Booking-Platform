import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

/**
 * The first screen of the Android app.
 *
 * A phone opening screen, not a web page scaled down: one picture that says
 * what this is, and one thing to do. The website's landing page (with its
 * feature sections, stats and vendor doors) is a poor fit here -- a customer
 * who tapped the app icon has already decided; they need a way in.
 *
 * The shape is the one every Indian consumer app has taught them: artwork
 * and a line above, a sheet at the bottom with the sign-in action, the
 * smaller choices under it, and the legal line last. Nothing scrolls unless
 * the keyboard is up.
 */
/**
 * The app's own green -- the launcher icon's colour. Not the theme accent:
 * that is a preference a signed-in customer changes later, and the opening
 * screen should look the same as the icon they just tapped.
 */
const BRAND = "#1a8f4a";
/** The screen's one background: the sheet matches the photo's dark wash. */
const SURFACE = "#0e1419";
const HAIRLINE = "rgba(255,255,255,.16)";
const FAINT = "rgba(255,255,255,.62)";

/**
 * What FuelMart actually does, one promise per slide.
 *
 * Only things the app really delivers: the slot booking, the live queue
 * figures the server computes, the check-in PIN and pay-at-the-pump. An
 * opening carousel that promises anything else is a lie the first screen
 * tells before the customer has even signed in.
 */
const SLIDES: Array<{ icon: string; title: React.ReactNode; body: string }> = [
  {
    icon: "fa-bolt",
    title: (
      <>
        Skip the queue.
        <br />
        <span style={{ color: "#4ade80" }}>Book fuel</span> in seconds.
      </>
    ),
    body: "Reserve a 30-minute slot at a pump near you. Arrive, fill, leave — no standing in line.",
  },
  {
    icon: "fa-clock",
    title: (
      <>
        Know the wait
        <br />
        <span style={{ color: "#4ade80" }}>before</span> you drive.
      </>
    ),
    body: "Vehicles ahead, your queue position and the expected waiting time — live from the pump, not a guess.",
  },
  {
    icon: "fa-indian-rupee-sign",
    title: (
      <>
        Live prices.
        <br />
        <span style={{ color: "#4ade80" }}>Petrol, Diesel, CNG.</span>
      </>
    ),
    body: "Each pump publishes its own rates, so you compare what you will actually pay before booking.",
  },
  {
    icon: "fa-shield-halved",
    title: (
      <>
        Check in with
        <br />
        a <span style={{ color: "#4ade80" }}>4-digit PIN</span>.
      </>
    ),
    body: "Show your PIN at the station, fill up, then pay the attendant in cash or by UPI. Nothing is charged in advance.",
  },
];

const SLIDE_MS = 4500;

export default function AppLanding() {
  const navigate = useNavigate();
  const photo = `${import.meta.env.BASE_URL}bg-image.png`;

  const [slide, setSlide] = useState(0);
  /** Set once the customer swipes or taps a dot: their choice stops the timer. */
  const [held, setHeld] = useState(false);
  const touchX = useRef<number | null>(null);

  // Advance on its own until the customer takes over, and never for someone
  // who has asked the system for less motion.
  useEffect(() => {
    if (held) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setSlide((i) => (i + 1) % SLIDES.length), SLIDE_MS);
    return () => clearInterval(id);
  }, [held]);

  const go = (next: number) => {
    setHeld(true);
    setSlide((next + SLIDES.length) % SLIDES.length);
  };

  // A swipe is a horizontal drag of at least 40px; anything smaller is a tap
  // or a scroll, and stealing those makes a screen feel broken.
  const onTouchStart = (e: React.TouchEvent) => {
    touchX.current = e.touches[0].clientX;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const from = touchX.current;
    touchX.current = null;
    if (from == null) return;
    const dx = e.changedTouches[0].clientX - from;
    if (Math.abs(dx) < 40) return;
    go(slide + (dx < 0 ? 1 : -1));
  };

  return (
    <div
      className="flex flex-col"
      style={{ minHeight: "100dvh", background: SURFACE, color: "#fff" }}
      data-testid="app-landing"
    >
      {/* Top: the pump photo, darkened enough for white type to sit on it. */}
      <div
        className="relative flex flex-1 flex-col items-center justify-center px-6 text-center"
        style={{
          background: `linear-gradient(180deg, rgba(8,12,16,.82) 0%, rgba(8,12,16,.55) 45%, rgba(8,12,16,.92) 100%), url('${photo}') center/cover`,
          paddingTop: "calc(env(safe-area-inset-top) + 40px)",
          paddingBottom: 28,
          minHeight: "46dvh",
        }}
      >
        {/* The slides: swipe, tap a dot, or let them run. */}
        <div
          className="w-full"
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          role="group"
          aria-roledescription="carousel"
          aria-label="What FuelMart does"
          data-testid="landing-slides"
        >
          {SLIDES.map((s, i) => (
            <div
              key={i}
              aria-hidden={i !== slide}
              style={{
                display: i === slide ? "block" : "none",
                animation: "fadeIn .45s ease both",
              }}
            >
              <div
                className="mx-auto flex items-center justify-center rounded-2xl mb-5"
                style={{ width: 62, height: 62, background: BRAND, boxShadow: "0 10px 30px rgba(26,143,74,.45)" }}
                aria-hidden
              >
                <i className={`fas ${s.icon}`} style={{ fontSize: 26 }} />
              </div>

              <h1
                className="font-extrabold leading-tight"
                style={{
                  fontSize: 28,
                  letterSpacing: "-0.4px",
                  fontFamily: "'Space Grotesk', system-ui, sans-serif",
                  // The photo has bright patches; the shadow keeps the line
                  // readable over all of them.
                  textShadow: "0 2px 16px rgba(0,0,0,.7)",
                }}
              >
                {s.title}
              </h1>

              <p
                className="mt-3 text-[13.5px] mx-auto"
                style={{ color: "rgba(255,255,255,.75)", maxWidth: 320, textShadow: "0 1px 10px rgba(0,0,0,.6)" }}
              >
                {s.body}
              </p>
            </div>
          ))}
        </div>

      </div>

      {/* Bottom sheet: the one decision on the screen. */}
      <div
        style={{
          position: "relative", // over the photo, so the rounded top is visible
          zIndex: 1,
          // One palette down the whole screen: the sheet is the same dark
          // surface as the photo above it, not a white panel bolted on.
          background: SURFACE,
          color: "#fff",
          borderTopLeftRadius: 26,
          borderTopRightRadius: 26,
          marginTop: -24,
          padding: "20px 20px calc(env(safe-area-inset-bottom) + 20px)",
          boxShadow: "0 -14px 34px rgba(0,0,0,.45)",
        }}
      >
        {/* The grabber every phone sheet has: it says "this is the panel". */}
        <div
          className="mx-auto mb-3 rounded-full"
          style={{ width: 38, height: 4, background: HAIRLINE }}
          aria-hidden
        />

        {/*
          The slide dots live on the sheet, not on the artwork above it.
          Floating in the middle of the photo they read as decoration and sit
          where no thumb rests; here they are next to the buttons, which is
          where a hand already is.
        */}
        <div className="flex items-center justify-center gap-2 mb-4">
          {SLIDES.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => go(i)}
              aria-label={`Slide ${i + 1} of ${SLIDES.length}`}
              aria-current={i === slide}
              className="rounded-full"
              style={{
                width: i === slide ? 22 : 8,
                height: 8,
                background: i === slide ? "#4ade80" : "rgba(255,255,255,.28)",
                transition: "width .25s ease, background .25s ease",
              }}
            />
          ))}
        </div>

        <p className="text-center text-[15px] font-bold mb-4">Log in or sign up</p>

        <button
          type="button"
          onClick={() => navigate("/login")}
          className="w-full rounded-2xl font-bold"
          style={{
            background: BRAND,
            color: "#fff",
            // 52px tall: a thumb target, not a mouse target.
            padding: "16px",
            fontSize: 15.5,
            boxShadow: "0 8px 22px rgba(26,143,74,.32)",
          }}
        >
          Log in with email
        </button>

        <button
          type="button"
          onClick={() => navigate("/register")}
          className="mt-3 w-full rounded-2xl font-bold"
          style={{
            background: "transparent",
            color: "#fff",
            border: `1px solid ${HAIRLINE}`,
            padding: "15px 16px",
            fontSize: 15,
          }}
        >
          Create an account
        </button>

        {/* Looking around without an account is allowed: stations and prices
            are public, and being asked to sign up first is what makes people
            close an app. */}
        <button
          type="button"
          onClick={() => navigate("/stations")}
          className="mt-4 w-full text-center text-[13px] font-semibold"
          style={{ color: "#4ade80", background: "transparent", padding: "8px 0" }}
        >
          Browse pumps without signing in <i className="fas fa-arrow-right ml-1" aria-hidden />
        </button>

        {/*
          The demo lives here as well as on the dashboard, because the
          dashboard is behind sign-in -- and the one moment someone most
          wants to see how this works is before they have an account, or
          when the server is down and they cannot get past this screen.
        */}
        <button
          type="button"
          onClick={() => navigate("/simulation")}
          className="mt-1 w-full text-center text-[13px] font-semibold"
          style={{ color: FAINT, background: "transparent", padding: "8px 0" }}
          data-testid="landing-demo"
        >
          <i className="fas fa-flask mr-1.5" aria-hidden /> Real-time simulation (demo)
        </button>

        <p className="mt-4 text-center text-[11px]" style={{ color: FAINT }}>
          By continuing you agree to book fuel slots honestly and pay at the pump.
          <br />
          <button
            type="button"
            onClick={() => navigate("/privacy")}
            className="mt-1 underline"
            style={{ color: FAINT, background: "transparent" }}
            data-testid="landing-privacy"
          >
            Privacy Policy
          </button>
        </p>
      </div>
    </div>
  );
}
