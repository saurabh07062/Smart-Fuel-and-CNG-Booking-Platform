# FuelMart — how it works, and what the UI audit found

Written 3 October 2026, from the code rather than from memory. Every number in
here was measured; where something is an opinion it says so.

Two documents in one:

- **Part A** — how the system actually works, file by file, and how the
  frontend and backend meet.
- **Part B** — the Phase 1 UI/UX audit: what is good, what is not, and what is
  worth changing. No code has been changed for the audit.

---

# Part A — How FuelMart works

## A1. Shape of the system

```
React/
  backend/     Express 5 + Mongoose 9 + Socket.IO   136 files, ~29,600 lines
  frontend/    React 18 + Vite + TypeScript         196 files, ~33,900 lines
  mobile/      Capacitor shell -> FuelMart-customer.apk
  database/    notes and seed material
```

Three audiences share one backend: **customer**, **vendor**, **admin**. The
website serves all three; the Android app is the customer half only, built
from the same source with `VITE_APP_MODE=customer` so the vendor and admin
pages are compiled out.

## A2. The request path

```
Browser / APK
   |
   |  axios (services/api/apiClient.ts)
   |    web  : relative "/api/..."   same origin, cookies just work
   |    APK  : absolute "http://<server>/api/..." through Capacitor's native
   |           HTTP, so Android's cookie jar holds the session and no CORS
   |           preflight happens (services/api/nativeTransport.ts)
   v
Express (backend/src/app.js)
   helmet -> CORS allowlist -> express.json -> cookies -> rate limit -> routes
   |
   v
Controller  -> Service (the business logic)  -> Mongoose model -> MongoDB
                        |
                        +-> services/notification/realtime.js -> Socket.IO
```

**The rule the backend holds to:** write first, announce second. Nothing is
emitted over a socket that has not already been stored, so a client that
reloads never loses something it was told.

## A3. Authentication and sessions

| Piece | File | What it does |
|---|---|---|
| Login / register / refresh | `controllers/authController.js` | Issues the session; `sessionUserView()` is the single shape every auth response returns |
| Session cookies | `services/security/session.js` | `fm_access` (short) + `fm_refresh` (long), both httpOnly + SameSite=Strict. Per-tab variants `fm_access_<tab>` let one browser hold a vendor in one tab and a customer in another |
| Tab identity | `frontend/src/utils/tabId.ts` | Sends `X-FM-Tab`. On the web it lives in sessionStorage (one per tab); **in the APK it lives in localStorage**, because the app is one "tab" whose cookies survive a restart |
| Boot | `frontend/src/hooks/useAuthBoot.ts` | Re-validates the persisted profile against `GET /api/auth/me`, bounded to 2.5 s so a dead network never holds the splash |
| Route gates | `routes/ProtectedRoute.tsx`, `routes/RoleRoute.tsx` | UX gates only. The real check is server-side on every request |
| App allowlist | `utils/nativeApp.ts` | In the APK, any path not on this list is sent to `/login`. **Add a customer page here or it is invisible in the app** |

Passwords are bcrypt hashes. The server refuses to start with a weak
`JWT_SECRET`, with `COOKIE_SECURE=false` in production, or with
`CHECKIN_DEMO_MODE=true` in production (`config/auth.js`).

## A4. The customer journey, end to end

| Step | Frontend | Backend | Notes |
|---|---|---|---|
| Sign in | `pages/auth/Login.tsx` | `POST /api/auth/login` | |
| Post-login location | `components/location/PostLoginFlow.tsx` | `GET /api/stations/nearby` | Asks for real GPS after a pause; a refusal falls back to typed place search (`GET /api/v1/discovery/search-place`). **Coordinates are never stored** |
| Find a station | `pages/customer/Stations.tsx`, `NearestPump.tsx` | `services/station/discovery.js`, `smartRecommender.js` | Distance is straight-line, or road distance via OSRM when configured |
| Choose how much | `components/booking/QuantityStep.tsx` | `services/booking/fuelAmount.js` | Litres/kg **or** rupees; the server divides by the station's own price |
| Pick a slot | `components/booking/DateSlotStep.tsx` | `services/queue/nozzleScheduler.js` | Slots are allocated per nozzle inside a 30-minute window |
| Reward discount | `components/booking/RewardRedeemCard.tsx` | `GET /api/v1/rewards/quote` | The server caps it; the UI only displays the answer |
| Confirm | `pages/customer/Booking.tsx` | `POST /api/bookings` -> `services/booking/bookingCreate.js` | Under a per-customer lock *and* the fuel's nozzle lock; stock is reserved by conditional update |
| Fleet (2+ vehicles) | `pages/customer/FleetBooking.tsx` | `POST /api/bookings/fleet` -> `fleetBooking.js` | One booking per vehicle, grouped, **one PIN for the group** |
| Arrive | `components/booking/StationCheckInCard.tsx` | `services/booking/stationArrival.js` | Stores the **distance in metres**, not the location |
| Attendant verifies | vendor console | `POST /api/bookings/verify` | PIN or QR; a fleet PIN checks the whole group in |
| Fuelling | — | `services/queue/serviceTimer.js` | Auto-completes after the fuel's own duration (40 s petrol/diesel, 300 s CNG) |
| Completion | — | `services/booking/bookingCompletion.js` | The single place a booking completes: deducts stock, issues the invoice, **earns reward points**, **accrues commission** |
| Invoice | `pages/customer/Confirmation.tsx` | `GET /api/invoices/:bookingId` | Server-rendered A4 HTML, frozen at issue |

## A5. Money

Payment is **at the pump** — no card, bank or UPI-PIN data exists anywhere.

- **Revenue** (`services/payment/revenue.js`) is the one definition every
  dashboard uses: completed **and** paid **and**, for a pump booking,
  collected. It counts `payableAmount` (the bill less any points discount).
- **Reward points** (`services/rewards/rewardService.js` + `RewardLedger`):
  earned on completion, redeemed at checkout, reversed on cancellation. The
  balance is the sum of the ledger; a unique index per `(booking, type)` makes
  every movement happen once.
- **Commission** (`services/commission/commissionService.js` + `CommissionEntry`,
  `Settlement`): accrues per sale as *pending*, gathered nightly by
  `settlementJob.js` into one settlement per vendor per day. Nothing is marked
  settled until a transfer is **confirmed** — with no payout gateway, an admin
  records receipt.

## A6. Realtime

`services/notification/realtime.js` emits to **addressed rooms** — `user:<id>`,
`vendor:<id>`, `admin`, `station:<id>` — never broadcast, because a booking
payload carries a customer's name and plate. 22 events; the client subscribes
in `hooks/useRealtimeSync.ts` and a dropped connection triggers a full resync
over HTTP rather than trusting stale screens.

## A7. Data model (20 collections)

`User`, `Station`, `Booking`, `BookingAttempt`, `WalkIn`, `FleetBooking`,
`Employee`, `Conversation`, `Message`, `Invoice`, `Counter`,
`InventoryMovement`, `PriceHistory`, `Notification`, `RefreshToken`,
`SecurityEvent`, `WebhookEvent`, `RewardLedger`, `CommissionEntry`,
`Settlement`.

`models/index.js` registers them all plus a `RELATIONS` map; `schemaIndexes.js`
builds every index at boot and reports conflicts instead of failing silently.

## A8. Frontend structure

- **15 Zustand stores** — `authStore`, `bookingStore`, `bookingDraftStore`,
  `stationStore`, `locationStore`, `notificationStore`, `chatStore`,
  `fleetStore`, `vendorStore`, `adminStore`, and others.
- **14 API modules** under `services/api/`, all sharing one axios instance.
- **24 pages** across customer / vendor / admin / auth / public.
- **23 routes**, lazy-loaded except the first screens.

---

# Part B — Phase 1 audit findings

Measured, not guessed. Each finding has the number behind it.

## B1. What is genuinely good — leave it alone

1. **The business logic.** Locks, conditional updates, unique indexes, one
   definition of revenue, exactly-once ledgers. This is the strongest part of
   the project and no UI work should touch it.
2. **Design tokens exist and are real.** `styles/variables.css` defines 80
   tokens — colour, spacing, radius, shadow — with a dark theme, and the
   customer app re-themes by overriding `--primary` in one place.
3. **The chart primitives are decent.** `components/admin/charts/Charts.tsx`
   (468 lines) has `ChartCard`, `LineChart`, `BarChart`, `DonutChart`,
   `MoneyColumns` — SVG, `viewBox` + `width="100%"`, so they already resize,
   and they carry `role="img"` with a text label.
4. **Mobile behaviour is deliberate.** `.is-app` rules cover safe areas, tap
   targets, momentum scrolling and no-select chrome.
5. **Loading/empty/error components exist**: `Loader`, `EmptyState`,
   `ErrorMessage`, `ErrorBoundary`, `ToastHost`, `Modal`, `StatusBadge`.

## B2. What is actually wrong

### Finding 1 — Five parallel class systems *(high)*

| Prefix | Distinct classes | Used by |
|---|---|---|
| `cx-` | 192 | customer app |
| `vm-` | 138 | vendor + admin consoles |
| `fm-chat` | 65 | chat widget |
| `fm-fleet` | 48 | fleet booking |
| `pp-` | 21 | privacy policy |

8,125 lines of CSS across 10 files. The same concept — a card, a badge, a
table, an empty state — is written up to five times. **This is the single
biggest reason the app reads as assembled rather than designed.**

### Finding 2 — The token system is bypassed *(high)*

**126 hardcoded hex colours** in `.tsx` files. The top offenders (`#22c55e` ×16,
`#f59e0b` ×10, `#3b82f6` ×8) are semantic colours that already exist as tokens.
Consequence: those elements do not follow dark mode or the customer theme.

### Finding 3 — No typographic scale *(medium)*

**17 distinct arbitrary font sizes** in JSX (`text-[11px]` ×92, `text-[10px]`
×42, `text-[11.5px]` ×16, `text-[12.5px]` ×11 …) plus **37 distinct
`font-size` values** in CSS. 10px and 11px body text is also below comfortable
reading size on a phone.

### Finding 4 — Components are duplicated, not reused *(high)*

| Shared component | Files importing it | Hand-rolled instead |
|---|---|---|
| `Button` | 4 | **343** raw `<button>` |
| `Modal` | 2 | **17** bespoke overlays |
| `Loader` | 4 | **25** bespoke `fa-spinner` blocks |
| `EmptyState` | 5 | 10 bespoke empties |
| Table | **does not exist** | **14** hand-rolled tables |

### Finding 5 — The vendor console has no charts at all *(high)*

Confirmed by search: zero chart imports under `components/vendor/`. Yet the
data is already there and already aggregated:

- `RevenueTab` shows four stat cards and a bar list — no trend over time.
- `ReportsTab` renders **monthly revenue as a table** and the **demand
  forecast as a table**.
- `revenueWeeksThisMonth()` already returns week-by-week buckets, server-side,
  and nothing plots it.

The admin console, by contrast, uses the charts in six places. Same product,
two standards.

### Finding 6 — Analytics that exist but are not visualised *(medium)*

Real data with no visual form today:

| Available now | Natural chart | Where |
|---|---|---|
| `revenueWeeksThisMonth()` | line | vendor Revenue |
| `fuelSales` per fuel | donut or bar | vendor Revenue |
| `getForecast` per station | line | vendor Reports |
| Booking status counts | donut | vendor + admin |
| `CommissionEntry` by day | line | commission tabs |

Genuinely **missing** aggregations (would need new backend work):
booking-hour heatmap, waiting-time distribution, fuel-quantity histogram.

### Finding 7 — Tables are the weakest surface *(medium)*

14 hand-rolled tables, each with its own header casing, padding and empty
state. 14 `overflow-x-auto` wrappers for 12 table files suggests horizontal
scroll is the only mobile strategy — usable, but it is why the consoles feel
like an admin template.

## B3. What is *not* worth changing

- The chart SVG primitives — they work and they resize. Extend, don't rewrite.
- The customer booking flow — recently reworked and visually consistent.
- The chat widget — just rebuilt to a support-app standard.
- The invoice — just redesigned against the app's tokens.
- The privacy policy — new, and already token-driven.
- Anything in `services/` on the backend.

## B4. Recommended plan — smallest change, biggest effect

Ordered by value per unit of risk.

**Step 1 — One shared primitive layer** *(no visual redesign)*
Extend `variables.css` with a real type scale and a semantic chart palette;
add `Table`, `StatCard` and `Section` to `components/common/`, built from
tokens. Nothing changes visually yet; the vocabulary now exists.

**Step 2 — Replace the 126 hardcoded colours** with tokens. Pure find-and-fix.
Immediately fixes dark mode in those places.

**Step 3 — Give the vendor console its charts.** Revenue trend (line), fuel
split (donut), forecast (line) — all from aggregations that already exist.
This is the largest visible gain and needs no backend work.

**Step 4 — Adopt the shared `Table`** in the 14 table sites, highest-traffic
first (vendor Bookings, admin Orders).

**Step 5 — Loading / empty / error** — route the 25 bespoke spinners and 10
bespoke empties through the existing components.

**Step 6 — New backend aggregations**, only if wanted: hour-of-day heatmap,
waiting-time histogram, quantity histogram.

Deliberately **not** proposed: renaming `cx-`/`vm-`/`fm-` wholesale. It would
touch nearly every file for no user-visible gain and a high regression risk.
The prefixes can converge on shared tokens underneath while keeping their
names.

## B5. Baseline before any change

| Check | Result |
|---|---|
| Backend tests | 980 passed, 0 failed, 1 skipped |
| Frontend tests | 328 passed, 0 failed (48 files) |
| TypeScript | clean |
| ESLint | clean |
| Web + native builds | both succeed |
| Dependency audit | 0 vulnerabilities |

Any regression from UI work must be measured against this.

---

*Part A is updated when the architecture changes. Part B is a point-in-time
audit; each implementation phase appends its own section below.*

---

# Phase 3–4 implementation log — 4 October 2026

What was built, and what the audit's numbers look like afterwards.

## Shared vocabulary (Phase 3)

| Added | File | Status |
|---|---|---|
| Type scale (7 steps) + line heights | `styles/variables.css` | in use by all `ds-*` |
| Chart palette + fixed fuel colours | `styles/variables.css` | in use by 3 chart sites |
| `DataTable` | `components/common/DataTable.tsx` | adopted in 2 tables |
| `StatCard` | `components/common/StatCard.tsx` | **drives all 6 vendor cards + admin commission** |
| `Lightbox` | `components/common/Lightbox.tsx` | charts + images |
| `ZoomableImage` | `components/common/ZoomableImage.tsx` | station photo |

`VendorStatCard` was not deleted — forty call sites use it. It now *delegates*
to `StatCard`, translating its decorative colour names ("emerald", "cyan")
into the four semantic tones. One edit, every vendor figure consistent, no
call site touched.

## Analytics (Phases 5–6)

- **Vendor revenue trend** (line) and **fuel split** (donut) — the vendor
  console previously had no charts at all.
- The data needed no new aggregation: `revenueWeeksThisMonth()` already
  accepted a `stationIds` filter and was only ever called without one, by the
  admin route. One `Promise.all` in `vendorPanelController.getRevenue` exposed
  it to vendors.
- Every chart is now **expandable** — one optional prop on `ChartCard`,
  defaulting on, so all existing charts gained it at once.

## Colour consistency

Replaced 29 hardcoded colours with tokens in the three files where colour
carries *meaning*:

| File | Replaced |
|---|---|
| `AdminDashboardTab.tsx` | 12 → 0 |
| `StockDonut.tsx` | 8 → 0 |
| `AdminVendorsPanel.tsx` | 7 → 0 |

This fixed a real inconsistency: **Petrol was orange in the admin console,
green in the vendor donut and orange again in the stock ring** — three
mappings of the same three fuels. All now read `--fuel-petrol` etc.

It also fixed a latent bug: `` `${colour}55` `` appends an alpha suffix to a
hex, and silently breaks the moment the value becomes `var(--x)`. Converted to
`color-mix`.

The remaining 97 hex values are deliberate: SVG icon artwork, theme swatches
(where the hex *is* the choice being offered), `var(--x, #fallback)` defences,
and the self-contained Simulation and marketing pages.

## Numbers, before and after

| Measure | Audit | Now |
|---|---|---|
| Hardcoded hex in `.tsx` | 126 | **97** |
| Vendor console charts | 0 | **2** |
| Stat-card implementations | 3 | **1** |
| Hand-rolled tables | 14 | **13** |
| Bespoke spinners | 25 | 25 (not started) |

## Verification

| | |
|---|---|
| Backend | 980 passed, 0 failed, 1 skipped (981) |
| Frontend | 328 passed, 0 failed (48 files) |
| TypeScript / ESLint | clean |

One test needed updating rather than the code: `StockDonut.test.tsx` asserted
the literal `#34d399`. It now asserts `var(--status-good)` — the better
assertion, since the hex changes between light and dark but the *meaning* does
not.

## Still outstanding

1. `DataTable` in the remaining 13 tables
2. The 25 bespoke spinners and 10 empty states → shared components
3. New aggregations: hour-of-day heatmap, waiting-time histogram, fuel-quantity
   histogram
4. Phase 9: a full pass over every route and breakpoint

## Continued — adoption pass

| Change | Effect |
|---|---|
| `AdminOrdersTab` → `DataTable` | the platform's busiest table; 4 columns now drop out on a phone instead of forcing a long sideways scroll to reach the actions |
| `ConsoleLoading` → delegates to `Loader` | **8 console screens** in one edit. The console's copy also had no `role="status"`, so a screen reader was told nothing was happening |
| Both commission tabs → `Loader` | removed two more inline spinners |

### Numbers

| Measure | Audit | After phase 3–4 | Now |
|---|---|---|---|
| Hand-rolled tables | 14 | 13 | **11** |
| Bespoke spinners | 25 | 25 | **23** |
| Files importing `Loader` | 4 | 4 | **8** |
| Files importing `DataTable` | 0 | 2 | **3** |
| Hardcoded hex | 126 | 97 | 97 |

The spinner count falls by less than the screens fixed, because `ConsoleLoading`
is one file serving eight.

### Verified in the browser

- Admin **Orders** renders through the shared table with real rows
- Admin **Dashboard** revenue trend draws with the token palette, expand control present
- Vendor **Revenue** — 6 shared stat cards, 0 of the old implementation
- Vendor **Inventory** — stock rings correct on the status tokens
- Vendor/Admin **Commission** — shared tables and empty states

Frontend 328 passed · backend 980 passed · tsc and ESLint clean.

---

# Phase 5–6 — distributions (new analytics)

The first charts in the product that needed **new backend work**. Everything
before this plotted aggregations that already existed.

## What was added

`backend/src/services/analytics/distributions.js` — three aggregations over
real `Booking` rows:

| Aggregation | Measures | Source fields |
|---|---|---|
| `waitingTimes` | how long people actually waited at a pump | `arrivalTime` → `fuelingStartTime` |
| `fuelQuantities` | how much people actually buy, per fuel | `quantity` on completed bookings |
| `demandByHour` | when people book, day × hour | `createdAt`, grouped in India time |

The wait is **measured, not estimated**: `arrivalTime` is written when the
customer checks in at the pump (`services/queue/nozzleService.js`) and
`fuelingStartTime` when the nozzle starts them. It is not the ETA shown
before booking.

`GET /api/v1/admin/distributions?days=30` serves all three.

## Honesty built into the data, not the chart

- Every block carries its own `total`, and `Histogram` **refuses to draw**
  below `minSample` (default 5), saying how many readings it has instead. A
  distribution of nine readings looks exactly as authoritative as one of nine
  thousand.
- Negative waits (clock skew, out-of-order writes) are dropped, not clamped.
- Bucket edges are fixed, not computed from the data — buckets that move
  cannot be compared between two weeks.
- Grouped in `Asia/Kolkata`: MongoDB would otherwise bucket by UTC and shift
  every peak by five and a half hours.

## New chart primitives

`Histogram` and `Heatmap` in `components/admin/charts/Charts.tsx`.

`Histogram` is deliberately separate from `BarChart`: a bar chart compares
named things, a histogram shows where a continuous measurement piles up. Its
bars touch, which is the convention that tells a reader the axis is
continuous.

`Heatmap` uses one hue at varying strength, never a rainbow — colour carries
*more* and *less*, not categories. An empty cell is the surface colour rather
than a pale hue, so "none" and "a few" cannot be confused.

## Verified with real rows

Seeded 25 bookings with genuine check-in → start gaps in the TEST database:

```
median 4 min · p90 14 min · longest 23 min
0–2:3  2–5:11  5–10:7  10–15:2  15–20:1  20–30:1  30+:0
```

Rendered: 4 histograms (wait + one per fuel, CNG in kg) and the day × hour
heatmap reading "Busiest: Mon 10a". The error state was also exercised — the
tab showed "No such endpoint" with a working *Try again* before the test
server was restarted.

Backend 980 passed · frontend 328 passed · tsc and ESLint clean.

## Still outstanding

1. The other **11 tables** → `DataTable`
2. The remaining **23 spinners** / empty states
3. Vendor-scoped distributions (the service already takes `stationIds`; only
   an endpoint is missing)
4. Phase 9: the full route-by-route audit

---

# Phase 7–9 — adoption, accessibility, final audit

## Phase 7 — employee photos (the last gap in the vendor panel)

A staff list is read at a glance when it shows faces and letter by letter when
it shows initials. The vendor panel had no way to add one.

Built on the customer's own photo logic rather than a second mechanism:

| Layer | What it does |
|---|---|
| `models/Employee.js` | `photo: String \| null` — a path under `/uploads`, never the image, exactly as `User.profileImage` |
| `routes/vendorPanelRoutes.js` | `uploadImage("profiles", "employeePhoto")` on POST and PUT |
| `controllers/vendorPanelController.js` | create stores the path; update replaces or clears it; delete unlinks it |
| `components/vendor/tabs/EmployeesTab.tsx` | picker with an object-URL preview, revoked on change; avatar in the list, falling back to the initial |

**Ordering that matters:** the previous file is deleted only *after* the new
path commits. Deleting first loses the picture if the save then fails.

### A real bug the tests found

`test/employeePhoto.test.js` (8 cases) was written against the finished
feature, and the cross-vendor case failed:

```
✖ another vendor cannot photograph this vendor's staff
  nothing was written for the rejected caller: 11 !== 10
```

The refusal itself was correct — a 404 — but multer writes the file to disk
*before* the handler runs, so every deliberate early return left an orphan
image that nothing would ever reference. The catch blocks cleaned up; the
`return res.status(...)` paths did not. One of those refusals is reachable by
guessing an employee id, which makes it a leak a stranger can drive.

Fixed with `refuseEmployee()`, which unlinks the upload and then refuses — now
used by all three early returns (bad field, station that is not yours,
employee that is not yours).

## Phase 8 — the collapsed rail had no accessible names

Found by reading the vendor console as an accessibility tree rather than
looking at it:

```
button [ref_3]   button [ref_4]   button [ref_5]  ... eleven of them
```

Below the wide breakpoint the rail collapses to icons: the label `<span>`
goes `display:none` and the `<i>` is `aria-hidden`. Between them, every item
in the primary navigation had **no accessible name at all** — a screen reader
announced eleven buttons called "button", and so did the logo and Logout.

One file, `components/console/ConsoleShell.tsx`, serves all **8 console
screens** (vendor and admin), so one edit fixed every one:

- `aria-label` and `title` on each nav item, the logo and Logout
- the badge folded into the item's own label (`"Bookings, 3 waiting"`),
  because a name on a button replaces everything inside it — the badge's
  separate `aria-label` would simply have gone unread

**A correction the tests caught:** the first version used
`aria-label="Log out"` against visible text reading "Logout". That breaks
WCAG 2.5.3 *Label in Name* — voice control cannot act on a word the user can
read — and `authNavigation.test.tsx` failed on exactly that. The accessible
name now matches the visible text.

After: all 11 items named, 0 anonymous buttons left in the rail.

## Phase 9 — final audit

### Responsive

No horizontal overflow at 375×812 on the routes checked — measured
(`scrollWidth === clientWidth`, plus every element whose right edge exceeds
the viewport), not eyeballed.

### APK scope — customer booking only, verified at three layers

1. `utils/nativeApp.ts` — `isCustomerAppPath()` is an allowlist of 13
   customer paths; everything else goes to sign-in
2. `ProtectedRoute.tsx` / `Login.tsx` refuse the vendor and admin roles
3. the `dist-native` bundle contains **no** admin or vendor panel chunk at all
   (`vendorFuels-*.js` is only a petrol/diesel/CNG label map — a misleading
   name, not vendor code)

### Where the shared vocabulary actually got to

Counted with `grep -r` over `src`, excluding tests:

| Measure | Audit | Now |
|---|---|---|
| Hand-rolled tables | 14 | **12** |
| Files importing `DataTable` | 0 | **3** |
| Files importing `Loader` | 4 | **9** |
| Files importing `StatCard` | 0 | **3** |
| `animate-spin` spinners | — | **0** |
| Hardcoded hex (`.tsx`, non-test) | — | **109** |

The hex figure is **not** comparable with the "97" recorded in the phase 3–4
table: that one used a different pattern. Rather than present a regression or
an improvement that is really a change of ruler, the honest statement is that
109 is the count under the pattern above, and `Simulation.tsx` (24),
`AppLanding.tsx` (12) and `Landing.tsx` (9) hold two fifths of them.

### Verification

| | |
|---|---|
| Backend | 988 passed, 0 failed, 1 skipped (989) |
| Frontend | 328 passed, 48 files |
| TypeScript | clean |
| ESLint | clean, `--max-warnings=0` |
| Builds | web, customer and native all pass |

### The suite was not repeatable — fixed

Running the backend suite three times in a row produced 4 failures in
`hardening.test.js`: `429 !== 200`. Not the product. That file talks to the
long-lived test server on :5055, and `resend-verification` allows **5 per 15
minutes per IP**. Two calls per run meant the third run inside the window was
refused for being a test suite.

Two other files already carried hand-written notes about the same thing
(`authRoutes.test.js`, `passwordReset.test.js`), so this had been paid for
more than once. Their workaround — blanking `REDIS_URL` — cannot work here:
those files build the app in-process, while these counters live in the test
server, on the far side of an HTTP boundary.

The fix follows the pattern `testServer.js` already used for the global and
vendor-access ceilings. The six per-IP auth budgets now read an optional
`AUTH_RATE_LIMIT_<NAME>`, **with the production number as the default**, and
the test server raises them for itself:

| | login | register | refresh | forgot | reset | resend |
|---|---|---|---|---|---|---|
| Production (unchanged) | 10/5m | 5/60m | 30/5m | 5/15m | 10/15m | 5/15m |
| Test server only | 10000 | 10000 | 10000 | 10000 | 10000 | 10000 |

Checked with the variables unset: every limiter still constructs with exactly
its original number, so deploying this loosens nothing. Only the per-IP
budgets are adjustable — the limiter's own behaviour is proved directly in
`rateLimiter.test.js`, and the per-account lockouts, which are what actually
protect an individual's credentials, are keyed by account and untouched.

**Proof it is fixed**, which is repetition, not a single green run:

```
hardening.test.js  ×5 consecutive   5 pass / 0 fail each time   (used to fail on the 3rd)
full suite         ×2 consecutive   988 pass / 0 fail / 1 skipped, both
```

---

# Phase 10 — three more tables onto the shared one

| Table | Why it was worth doing |
|---|---|
| Vendor **Employees** | 7 columns and no phone handling at all — the delete button sat past the right edge on a 375px screen |
| Vendor **Bookings** | the busiest table in the product, 8 columns |
| Admin **Customers** | 8 columns, its own invented header casing and padding |

Hand-rolled tables **12 → 9**; files importing `DataTable` **3 → 6**.

## `DataTable` gained one prop

Migrating Bookings broke 5 tests at once: every row had carried
`data-testid="booking-row-<id>"`, and the shared table had no way to express
that. The alternative was to weaken those tests into "find the text somewhere
on the page", which stops proving the values landed in the *right* row — the
one thing a table test is for. So `rowTestId` was added instead, and the
tests passed unchanged.

That is the general shape of this migration: where the shared component is
genuinely missing something, add it there once rather than bend the caller.

## Verified on a phone, not asserted

Signed in to the vendor console at 375×812 and read the computed styles:

```
Name ✓   Phone ✓   Role ✓   Shift ✗   Salary ✗   Station ✗   actions ✓
no horizontal overflow (scrollWidth === clientWidth === 375)
```

The three that drop are the ones a phone can live without; the delete button
is now reachable without a sideways scroll, which was the whole point.

A demo vendor now exists in **fuelmart_test only**
(`demo.vendor@fuelmart.test`, one station, four staff) so the consoles can be
opened and looked at without touching application data.

Frontend 328 passed · tsc and ESLint clean.

---

# Phase 11 — the rest of the tables

Seven more migrated: vendor **Customers**, vendor **Reports** (station
performance), vendor **Walk-ins**, admin **Vendors panel**, admin **Vendor
management**, admin **Forecast** (sales by fuel), and all three tables in
admin **Security** (rules, top accounts, events).

Files with a hand-rolled `<table>`: **12 → 4**. Files importing `DataTable`:
**6 → 13**.

## The four that are staying, and why

Not every `<table>` wants to be a `DataTable`. Forcing these in would have
been change for the sake of the number:

| File | Why it stays |
|---|---|
| `admin/charts/Charts.tsx` | the **Heatmap's own grid**. A table is the right element for day × hour, but it is a chart, not a data table |
| `booking/FuelQueuePreview.tsx` | **customer-facing**, styled to the `cx-` system. The console card shell would look wrong in the customer app, and its "Waiting #N" counter depends on render order |
| `admin/AdminForecastTab.tsx` | a **headerless** `<tbody>`-only list with an inline bar per row |
| `vendor/tabs/ReportsTab.tsx` | the same — a compact month list, no column headings |

`DataTable` always renders a `<thead>`. For the last two that would *add*
headings the design deliberately does not have.

## Verified by clicking every tab

Signed in to the vendor console against the test database and walked all 11
tabs, reading the DOM after each:

```
11 tabs · 0 crashes · 0 remaining hand-rolled tables · shared table on Employees and Reports
```

The other tabs show their empty states, which is correct for a fresh test
database rather than a failure to render.

The admin console was **not** swept visually — there is no admin account in
the test database — so those seven migrations rest on tsc, ESLint and the
suite rather than on having been looked at.

Frontend 328 passed · tsc and ESLint clean.

## Still outstanding

1. The 4 tables above are deliberate; no table work remains
2. The remaining bespoke empty states → shared components
3. The 109 hardcoded hex values, concentrated in three public pages
4. The APK has not been rebuilt since the chat redesign, the invoice
   redesign or these phases

---

# Phase 12 — hardcoded colour, and the APK

## The trap in this change

Every one of these files tinted a colour by **suffixing hex alpha**:

```jsx
style={{ background: `${color}18` }}          // #2563EB18 — fine
style={{ background: `var(--chart-1)18` }}    // not a colour — renders nothing
```

So the alpha suffixes had to become `color-mix()` in the *same* edit as the
token swap. Doing the swap alone would have silently emptied three borders, a
shadow and two backgrounds — the failure mode here is invisible, not a crash.
This had already bitten this project once, in the chart work.

Verified by resolving the exact expressions the edited files now emit against
the live stylesheet:

```
color-mix(in srgb, var(--chart-1) 9%, transparent)  →  color(srgb 0.145 0.388 0.922 / 0.09)   ✓
color-mix(in srgb, var(--chart-3) 33%, transparent) →  color(srgb 0.961 0.620 0.043 / 0.33)   ✓
color-mix(in srgb, var(--status-good) 20%, …)       →  color(srgb 0.063 0.725 0.506 / 0.20)   ✓
```

All seven resolve to a real colour with the right alpha; none fell back to
transparent.

## A real inconsistency, not just a count

`Simulation.tsx` coloured **Petrol amber, Diesel blue, CNG green** — the
reverse of `--fuel-petrol` / `--fuel-diesel` / `--fuel-cng` used everywhere
else. Tokenising it fixed a genuine contradiction between the demo
walkthrough and the product, which is the kind of thing the hex count was a
proxy for all along.

| File | Hex before | After |
|---|---|---|
| `pages/customer/Simulation.tsx` | 24 | **1** |
| `pages/public/Landing.tsx` | 12 | **6** |

Total in `.tsx` (non-test): **109 → 80**.

## What is deliberately left

- `pages/public/AppLanding.tsx` — a **fixed dark brand splash**
  (`SURFACE #0e1419`, brand green). It is meant to look identical in light and
  dark; tokenising it would make it follow the theme and change the design.
- Landing's CTA block — a saturated blue gradient with white text and
  decorative white dots. Fixed on purpose.
- One `#fff` in `Simulation.tsx` — label text on a filled, saturated stage
  dot, correct in both themes.

## APK rebuilt

The default server address was stale (`10.251.231.160`, machine now on
`10.140.211.160`), so this was **asked rather than assumed** — the standing
rule is not to change that file unprompted. On the user's instruction it now
points at the current address.

```
app-debug.apk · 7.9 MB
baked-in server   http://10.140.211.160:5000  (plus 10.0.2.2, the emulator alias)
40 chunks · 0 source maps
admin/vendor panel chunks: none — customer booking only
```

Frontend 328 passed · tsc and ESLint clean.

---

# Phase 13 — the privacy policy, redesigned

The content was already the strongest thing about this page: every claim
checked against the code, and "we do not do that" written where that is the
honest answer. **Not one sentence of it changed.** What changed is that it
looked like a Word document pasted into a browser.

## What the page now does

| | Before | After |
|---|---|---|
| Opening | a plain `h1` and a grey "last updated" line | a hero: eyebrow, large title, lede, and three chips — updated, 14 sections, written from the source code |
| Index | one card of 14 links, above everything, on every screen | a **pinned rail** ≥1024px; on a phone a folded `<details>` so 14 links are not an obstacle before the first paragraph |
| Where am I? | nothing | the index follows the reader (IntersectionObserver), with `aria-current` on the live link |
| Sections | one unbroken column under underlined headings | 14 **cards**, each with a numbered badge |
| Getting back | one button at the very bottom | a floating back-to-top that appears after 600px, plus the original action |
| Numbering | baked into the strings (`"1. What we collect"`) | derived from position, so the index and the badge cannot disagree |

Typography and spacing now come from the design tokens (`--fs-*`,
`--space-*`, `--radius-*`) instead of the hardcoded `14.5px` / `12px` /
`22px` the file had been using, and the title and lede use `clamp()` so they
scale rather than stepping at one breakpoint.

## Accessibility

- 0 interactive elements without an accessible name (checked in the DOM)
- one `h1`, 14 `h2`, one `nav` landmark — no duplicate or skipped levels
- `aria-current="true"` on the active index link
- one consistent `:focus-visible` ring for every link, button and summary
- the back-to-top button leaves the tab order while invisible — otherwise it
  is a button that focuses something nobody can see
- `prefers-reduced-motion` honoured
- the skip link and the print stylesheet were kept and extended

## A mistake worth recording

Splicing the new stylesheet in by line number ate the opening of an unrelated
rule, leaving `object-fit: cover; display: block; }` with no selector. Vite's
PostCSS refused the whole file and **the page rendered as a stack trace** —
while `tsc`, ESLint and all 328 tests still passed, because none of them read
CSS. Only opening the page found it.

Fixed by restoring `.ds-zoomable` / `.ds-zoomable img`, and then checked
structurally rather than by eye: brace balance across the file is now
**242 / 242**, and no declaration follows a top-level `}`.

## Verified in the browser

| | |
|---|---|
| 1280px | two columns, index pinned, scroll-spy tracking section 06 at 2600px |
| 375px | index folded, cards full width, **no horizontal overflow** |
| Dark | every surface follows the tokens — page `#0b1324`, cards `#1e293b`, nothing light leaking |
| Anchor jump | `#payments` lands at y=101 against a header ending at y=65 — clears it |
| Routing | `/privacy` still allowlisted for the APK, console sidebar link intact, Back and the CTA both resolve |

Frontend 328 passed · tsc and ESLint clean.

## Follow-up: the masthead did not line up

On a wide screen the header sat on an 820px measure while the body had
widened to 1100px, so the FuelMart logo was about 140px inside the title
below it. A masthead that does not line up with its own page is the clearest
tell of a layout nobody looked at.

It only showed above 1024px, and the eye reads it as "slightly off" rather
than as a bug, which is how the earlier check at 1280px walked past it. It
took the user's own screenshot at full width to make it obvious.

The bar and the footer now widen with the body. Measured at 1600px: brand
left 263px, title left 263px, footer content 263px.
