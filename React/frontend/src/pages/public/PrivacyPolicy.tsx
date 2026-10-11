import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/store/authStore";

/**
 * FuelMart's privacy policy.
 *
 * WRITTEN FROM THE CODE, NOT FROM A TEMPLATE
 *
 * Every statement here was checked against what the project actually does.
 * A policy that promises more than the software delivers is worse than no
 * policy: it is a false claim about someone's personal data. So where the
 * honest answer is "we do not do that", it says so -- and where a protection
 * depends on how the app is deployed rather than on its code, it says that
 * too, instead of claiming a guarantee the code cannot make.
 *
 * The specific things this page refuses to pretend about:
 *
 *   - location is NOT stored in the database (backend has no coordinate field
 *     on a booking; only the check-in DISTANCE in metres is kept)
 *   - no card, bank or UPI-PIN details are ever collected, because payment is
 *     taken at the pump (backend config/payments.js)
 *   - there is no self-service account deletion yet, so it does not offer one
 *   - there is no analytics, advertising or tracking of any kind, so it does
 *     not have a "we may share with partners" clause
 *   - map tiles are fetched by the BROWSER, which does expose the viewer's IP
 *     to OpenStreetMap -- said plainly rather than hidden
 *
 * Reachable signed out (sign-in, sign-up, the landing page) and signed in
 * (customer, vendor and admin), so it renders on its own rather than inside
 * any one console's shell.
 */

/** Last reviewed against the code. Shown so a reader knows how current it is. */
const LAST_UPDATED = "3 October 2026";

interface Section {
  id: string;
  title: string;
  body: React.ReactNode;
}

const SECTIONS: Section[] = [
  {
    id: "data-collected",
    title: "What we collect",
    body: (
      <>
        <p>Only what a fuel booking actually needs. Nothing is bought from anyone else.</p>
        <h3>Your account</h3>
        <ul>
          <li>Your name and email address.</li>
          <li>
            Your password, stored only as a bcrypt hash. We cannot read it, and nobody at FuelMart can tell you what
            it is.
          </li>
          <li>A profile photo, if you choose to upload one.</li>
        </ul>
        <h3>As a customer</h3>
        <ul>
          <li>
            Your vehicles: type, registration number, and optionally a nickname, make, model, colour, fuel type and a
            photo.
          </li>
          <li>Your bookings: station, fuel, quantity or amount, date and time slot, vehicle, and your 4-digit PIN.</li>
          <li>
            If you book a slot for somebody else, the name and phone number you give for the person who will arrive.
          </li>
          <li>Your reward-point balance and the entries explaining it.</li>
          <li>Messages you send through in-app chat, and your notifications.</li>
        </ul>
        <h3>As a vendor</h3>
        <ul>
          <li>Business name, GST number, phone number, address and a description.</li>
          <li>Your station details, fuel prices and stock figures.</li>
          <li>Documents you upload for approval: logo, licence and GST certificate.</li>
        </ul>
        <h3>Automatically</h3>
        <ul>
          <li>
            Server logs of requests, which include IP addresses, for keeping the service running and spotting abuse.
            Email addresses are masked in these logs.
          </li>
          <li>
            Security events — for example, an unusual number of booking attempts — recorded as a rule name and a
            score against your account.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "how-used",
    title: "How we use it",
    body: (
      <>
        <ul>
          <li>To create your account and keep you signed in.</li>
          <li>To find stations near you, book a slot, hold your place in the queue and estimate your wait.</li>
          <li>To let the station you booked at recognise you and serve the right fuel to the right vehicle.</li>
          <li>To produce your invoice and your booking history.</li>
          <li>To calculate reward points you earn and any discount you redeem.</li>
          <li>To send you the service emails listed in section 8.</li>
          <li>To protect the service from abuse.</li>
        </ul>
        <p className="pp-note">
          We do not profile you, we do not advertise to you, and we do not make automated decisions about you beyond
          the abuse checks described above.
        </p>
      </>
    ),
  },
  {
    id: "location",
    title: "Location",
    body: (
      <>
        <p>
          Location is the most sensitive thing this app touches, so here is exactly what happens to it.
        </p>
        <ul>
          <li>
            <b>You are asked, and you can refuse.</b> The app requests your device location after you sign in. If you
            refuse, you can type an area name instead, or pick a point on the map, and everything else still works.
          </li>
          <li>
            <b>It is used to answer one question:</b> which stations are near you, and how far away. Your coordinates
            are sent to our server to work that out.
          </li>
          <li>
            <b>We do not store your coordinates.</b> There is no location field on your account or on a booking. The
            answer is computed and the point is discarded.
          </li>
          <li>
            <b>Your last known point is kept on your own device</b> (in your browser or app storage) so the map opens
            where you were rather than at a default. Clearing your browser or app data removes it.
          </li>
          <li>
            <b>At check-in we record a distance, not a place.</b> When you check in at a pump, we store how many
            metres you were from the station — enough to confirm you had arrived, and not enough to say where you
            have been.
          </li>
          <li>
            <b>We never track you in the background.</b> Location is read only when you ask for nearby stations or
            check in.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "bookings",
    title: "Bookings and the station you visit",
    body: (
      <>
        <p>
          A booking exists so a specific station can serve a specific vehicle at a specific time, which means the
          station has to be told who is coming.
        </p>
        <p>The station you book at can see:</p>
        <ul>
          <li>Your name and a contact detail.</li>
          <li>Your vehicle and its registration number.</li>
          <li>The fuel, quantity, amount, slot and payment status.</li>
          <li>The name and phone number of whoever you said would arrive, if that is not you.</li>
        </ul>
        <p>
          Stations see only their own bookings. One station cannot see your bookings at another, and no customer can
          see another customer&apos;s bookings.
        </p>
      </>
    ),
  },
  {
    id: "payments",
    title: "Payments",
    body: (
      <>
        <p className="pp-strong">
          You pay at the petrol pump. FuelMart never collects or stores card numbers, bank details, UPI PINs or any
          other payment credentials.
        </p>
        <ul>
          <li>Online payment is switched off in this deployment; a booking is settled with the attendant.</li>
          <li>
            What we record is that a payment was taken, how (cash or UPI), by whom and when — not the instrument used
            to take it.
          </li>
          <li>
            If a station shows a UPI QR code, that is the station&apos;s own UPI ID. The money goes to them and the
            transaction happens in your UPI app, not in FuelMart.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "cookies",
    title: "Cookies and on-device storage",
    body: (
      <>
        <p className="pp-strong">
          We use no advertising cookies, no analytics and no third-party trackers of any kind.
        </p>
        <h3>Cookies</h3>
        <p>
          Two cookies keep you signed in: a short-lived access cookie and a longer-lived refresh cookie. Both are
          <code> httpOnly</code> — no script on the page can read them, including ours — and both are{" "}
          <code>SameSite=Strict</code>, so they are not sent from other sites. They exist only to prove the session is
          yours. Signing out removes them.
        </p>
        <h3>Stored on your device</h3>
        <ul>
          <li>Your signed-in profile, so the app can draw before the server answers.</li>
          <li>Your last known location, as described in section 3.</li>
          <li>Recent searches, a cached list of stations, and interface preferences such as light or dark mode.</li>
          <li>In the Android app, the server address you configured.</li>
        </ul>
        <p>All of it stays on your device. Clearing your browser or app data removes all of it.</p>
      </>
    ),
  },
  {
    id: "security",
    title: "How we protect it",
    body: (
      <>
        <ul>
          <li>Passwords are hashed with bcrypt and never stored or logged in readable form.</li>
          <li>Sessions live in httpOnly, SameSite=Strict cookies that scripts cannot read.</li>
          <li>Requests are checked for their origin, which blocks cross-site attempts to act as you.</li>
          <li>Sign-in, booking and other sensitive endpoints are rate limited per account.</li>
          <li>
            Every request is authorised by role on the server: being able to open a page is never what grants access
            to data.
          </li>
          <li>Uploads are restricted by file type and size, and stored under generated names.</li>
          <li>Your customer ID and phone number are masked on invoices, and email addresses are masked in logs.</li>
        </ul>
        <p className="pp-note">
          Being honest about the limits: encryption in transit depends on the server this is deployed to being
          configured with HTTPS, which is a deployment setting rather than something the application can guarantee by
          itself. No system is perfectly secure, and we do not claim otherwise.
        </p>
      </>
    ),
  },
  {
    id: "third-parties",
    title: "Third-party services",
    body: (
      <>
        <p>These are every outside service FuelMart touches, and what each one receives.</p>
        <ul>
          <li>
            <b>OpenStreetMap Nominatim</b> — turns a place name into coordinates, and coordinates into an area name.
            Called by <i>our server</i>, so your device and IP address are not exposed to it.
          </li>
          <li>
            <b>OSRM routing</b> — road distance between you and a station. Also called by our server, for the same
            reason.
          </li>
          <li>
            <b>OpenStreetMap tile servers</b> — the map images themselves, which your <i>browser</i> downloads
            directly. That means OpenStreetMap receives your IP address and the area you are looking at whenever a map
            is shown. This is unavoidable for any web map, and we are telling you rather than leaving it out.
          </li>
          <li>
            <b>Google Fonts and a public CDN</b> — fonts and icons on the website, also loaded by your browser. The
            Android app bundles these instead, so it makes no such request.
          </li>
          <li>
            <b>An email provider</b> — delivers account verification, password reset, booking confirmation and vendor
            status emails. It receives your email address and the content of those emails.
          </li>
        </ul>
        <p className="pp-strong">
          We do not sell your data. We do not share it for advertising. There is no analytics service, no tracking
          pixel and no social-media integration in this application.
        </p>
      </>
    ),
  },
  {
    id: "sharing",
    title: "Who else can see your data",
    body: (
      <>
        <ul>
          <li>
            <b>The station you book at</b> — the booking details in section 4, and nothing from your other bookings.
          </li>
          <li>
            <b>FuelMart administrators</b> — can see accounts, stations and bookings in order to run the service,
            approve vendors and help when something goes wrong.
          </li>
          <li>
            <b>Nobody else</b>, unless we are required to disclose something by law.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "retention",
    title: "How long we keep it",
    body: (
      <>
        <ul>
          <li>
            <b>Your account and vehicles</b> — for as long as the account exists.
          </li>
          <li>
            <b>Bookings and invoices</b> — kept as business and tax records. An issued invoice is deliberately frozen
            and never rewritten, so that it keeps saying what you were actually charged.
          </li>
          <li>
            <b>Sign-in sessions</b> — refresh tokens expire on their own and are deleted automatically by the
            database.
          </li>
          <li>
            <b>Security events</b> — 180 days by default, then removed automatically.
          </li>
          <li>
            <b>Your location</b> — not retained at all, as described in section 3.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "rights",
    title: "Your choices and rights",
    body: (
      <>
        <p>What you can do yourself, in the app, today:</p>
        <ul>
          <li>Refuse or revoke location permission, and use a typed area or the map instead.</li>
          <li>Add, edit and delete your vehicles.</li>
          <li>Upload or remove your profile photo.</li>
          <li>See all of your bookings, invoices and reward-point entries.</li>
          <li>Cancel a booking you no longer want.</li>
          <li>Clear everything stored on your device by clearing your browser or app data.</li>
        </ul>
        <p className="pp-note">
          Said plainly: there is <b>no self-service &ldquo;delete my account&rdquo; button yet</b>. To have your
          account and its data removed, or to ask for a copy of what we hold, contact us using section 13 and we will
          do it by hand. We would rather tell you that than put a button here that does not exist.
        </p>
      </>
    ),
  },
  {
    id: "children",
    title: "Children",
    body: (
      <p>
        FuelMart is for people who drive, and is not intended for children. We do not knowingly create accounts for
        anyone under 18. If you believe a child has an account, contact us and we will remove it.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <p>
        If what the application does with your data changes, this page changes with it, and the date at the top is
        updated. This policy describes the software as it actually behaves; it is reviewed against the code rather
        than written once and left.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <>
        <p>
          For anything about your data — a copy of it, a correction, or deletion of your account — contact us
          directly. We answer as a person, not a ticket queue.
        </p>
        <ul className="pp-contact">
          <li>
            <span className="pp-contact-k">Email</span>
            <a className="pp-contact-v" href="mailto:Saurabh07062@gmail.com">
              Saurabh07062@gmail.com
            </a>
          </li>
          <li>
            <span className="pp-contact-k">Phone</span>
            <a className="pp-contact-v" href="tel:+918169998305">
              +91 81699 98305
            </a>
          </li>
          <li>
            <span className="pp-contact-k">In the app</span>
            <span className="pp-contact-v">Support chat, from any screen</span>
          </li>
        </ul>
        <p className="pp-note">
          FuelMart is a student project built for a final-year submission. It is operated by its developer rather than
          by a registered company, and that is worth knowing when you decide what to put into it.
        </p>
      </>
    ),
  },
];

/**
 * Which section the reader is currently in.
 *
 * The index is long enough that "where am I?" is a real question, and the
 * honest answer comes from the document rather than from the last link
 * clicked -- a reader who scrolls past three sections should see the index
 * follow them. `rootMargin` pulls the detection line near the top of the
 * viewport so a heading counts as current once it reaches the header, not
 * when it is still halfway down the screen.
 */
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const sections = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;

    /**
     * The LAST section that has started above the reading line, not the
     * first one still touching it.
     *
     * Picking the topmost intersecting section looks right and is wrong: a
     * long section's tail stays in the band while the next heading is
     * already on screen, so the index sat one behind — it highlighted
     * "How we use it" while "Location" filled the page.
     */
    const LINE = 120; // just below the sticky bar

    /**
     * The LAST section that has started above the reading line.
     *
     * The obvious rule -- the topmost section still intersecting a band near
     * the top of the viewport -- looks right and is wrong: a long section's
     * tail stays in the band while the next heading already fills the page,
     * so the index sat one behind, saying "How we use it" under a screen of
     * "Location". This scans instead of trusting which entries happened to
     * fire.
     */
    const update = () => {
      let current = sections[0].id;
      for (const el of sections) {
        if (el.getBoundingClientRect().top <= LINE) current = el.id;
        else break;
      }
      setActive(current);
    };

    /*
     * IntersectionObserver is the trigger rather than the answer. It is used
     * because it still reports while the page is not being composited, where
     * scroll events and requestAnimationFrame both stop firing -- a frozen
     * index is a worse failure than a late one. The scroll listener is a
     * second trigger for movement too small to cross a section boundary.
     */
    const observer = new IntersectionObserver(update, {
      rootMargin: "-80px 0px -40% 0px",
      threshold: [0, 1],
    });
    sections.forEach((el) => observer.observe(el));

    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [ids]);

  return active;
}

export default function PrivacyPolicy() {
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const ids = useMemo(() => SECTIONS.map((s) => s.id), []);
  const active = useActiveSection(ids);

  /** The back-to-top button is noise until there is something to go back to. */
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 600);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  /** The index, shared by the desktop sidebar and the phone's disclosure. */
  const tocLinks = (
    <ol className="pp-toc-list">
      {SECTIONS.map((s, i) => (
        <li key={s.id}>
          <a
            href={`#${s.id}`}
            className={active === s.id ? "is-active" : undefined}
            aria-current={active === s.id ? "true" : undefined}
          >
            <span className="pp-toc-num" aria-hidden>
              {String(i + 1).padStart(2, "0")}
            </span>
            <span>{s.title}</span>
          </a>
        </li>
      ))}
    </ol>
  );

  return (
    <div className="pp-page">
      <a className="pp-skip" href="#pp-content">
        Skip to the policy
      </a>

      <header className="pp-head">
        <div className="pp-wrap pp-head-inner">
          <Link to="/" className="pp-brand" aria-label="FuelMart home">
            <span className="pp-brand-mark" aria-hidden>
              <i className="fas fa-gas-pump" />
            </span>
            <span>
              <b>FuelMart</b>
              <small>Smart Fuel Booking</small>
            </span>
          </Link>
          <button type="button" className="pp-back" onClick={() => navigate(-1)}>
            <i className="fas fa-arrow-left" aria-hidden /> Back
          </button>
        </div>
      </header>

      <main className="pp-wrap pp-main" id="pp-content">
        {/* The hero carries the one thing a reader checks first -- how current
            this is -- rather than burying it in small grey text. */}
        <div className="pp-hero">
          <p className="pp-eyebrow">
            <i className="fas fa-shield-halved" aria-hidden /> Legal
          </p>
          <h1 className="pp-title">Privacy Policy</h1>
          <p className="pp-lede">
            What FuelMart does with your information — checked against what the application actually does, not copied
            from a template. Where we do not do something, it says so.
          </p>
          <ul className="pp-meta" aria-label="About this document">
            <li>
              <i className="fas fa-clock-rotate-left" aria-hidden />
              Updated <time dateTime="2026-10-03">{LAST_UPDATED}</time>
            </li>
            <li>
              <i className="fas fa-list-ul" aria-hidden />
              {SECTIONS.length} sections
            </li>
            <li>
              <i className="fas fa-code" aria-hidden />
              Written from the source code
            </li>
          </ul>
        </div>

        <div className="pp-layout">
          {/* Fourteen sections is a lot to scroll blindly. On a wide screen the
              index stays beside the text; on a phone it folds away, because
              fourteen links above the first paragraph is its own obstacle. */}
          <nav className="pp-toc" aria-label="Sections of this policy">
            <p className="pp-toc-head" aria-hidden>
              On this page
            </p>
            {tocLinks}
          </nav>

          <details className="pp-toc-mobile">
            <summary>
              <i className="fas fa-list-ul" aria-hidden /> Jump to a section
              <span className="pp-toc-count">{SECTIONS.length}</span>
            </summary>
            {tocLinks}
          </details>

          <div className="pp-doc">
            {SECTIONS.map((s, i) => (
              <section key={s.id} id={s.id} className="pp-section" aria-labelledby={`${s.id}-h`}>
                <div className="pp-section-head">
                  <span className="pp-section-num" aria-hidden>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h2 id={`${s.id}-h`}>{s.title}</h2>
                </div>
                <div className="pp-section-body">{s.body}</div>
              </section>
            ))}
          </div>
        </div>

        <div className="pp-actions">
          <Link className="pp-btn pp-btn-primary" to={isAuthenticated ? "/dashboard" : "/login"}>
            {isAuthenticated ? "Back to dashboard" : "Back to sign in"}
          </Link>
          <a className="pp-btn pp-btn-ghost" href="#pp-content">
            Back to top
          </a>
        </div>
      </main>

      <footer className="pp-foot">
        <div className="pp-wrap pp-foot-inner">
          <p>FuelMart — Smart Fuel Booking</p>
          <p>
            Questions? <a href="mailto:Saurabh07062@gmail.com">Saurabh07062@gmail.com</a>
          </p>
        </div>
      </footer>

      <button
        type="button"
        className={`pp-totop ${scrolled ? "is-shown" : ""}`}
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        aria-label="Back to top"
        // Hidden from the tab order while invisible, or it is a button that
        // focuses something nobody can see.
        tabIndex={scrolled ? 0 : -1}
        aria-hidden={!scrolled}
      >
        <i className="fas fa-arrow-up" aria-hidden />
      </button>
    </div>
  );
}
