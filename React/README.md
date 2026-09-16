# FuelMart — Smart Fuel & CNG Booking Platform

## 1. Project overview

FuelMart lets customers book a time slot to fuel up at a nearby petrol, diesel
or CNG station, so they skip the queue. Three roles use the app:

- **Customer**: finds nearby stations, books a slot and a quantity, pays online
  or at the station, and sees their place in the live queue.
- **Vendor** (station owner or attendant): manages stations, prices and stock,
  checks cars in with a PIN, and sees the live queue at the pump.
- **Admin**: approves vendors and stations, verifies documents, and watches
  bookings and system health.

Everything updates live over Socket.IO: queue positions, slot availability,
booking status and stock.

## 2. Technology stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite 6, Tailwind CSS, Zustand, React Router, Leaflet maps, Axios, Socket.IO client |
| Backend | Node.js 20+ (tested on 24), Express 5, Mongoose 9, Socket.IO 4, JWT auth, Multer uploads, Nodemailer |
| Database | MongoDB |
| Cache / locks | Redis (optional — falls back to in-process locks and rate limits) |
| Payments | Razorpay, UPI intent, pay at station |
| Tests | `node:test` against a separate `fuelmart_test` database |

## 3. Folder structure

```
React/
├── backend/
│   ├── src/
│   │   ├── app.js              Express app: middleware, routes, error handling
│   │   ├── server.js           Entry point: MongoDB, HTTP + Socket.IO, background jobs
│   │   ├── config/             Business constants (slots, fuels, durations, CORS, proxy)
│   │   ├── controllers/        Request handlers
│   │   ├── middleware/         auth, role checks, uploads
│   │   ├── models/             Mongoose schemas
│   │   ├── routes/             Express routers (one per API area)
│   │   └── services/
│   │       ├── algorithms/     geo (nearest stations), queue maths, demand forecast
│   │       ├── booking/        create, transitions, completion, sweeps
│   │       ├── queue/          live station queue, nozzle scheduler/lock, service timers, waitlist
│   │       ├── station/        discovery, station finder, smart recommender, metrics
│   │       ├── inventory/      stock ledger, thresholds, lead time, demand history
│   │       ├── payment/        pay methods, UPI
│   │       ├── notification/   Socket.IO realtime, in-app notifications, email
│   │       ├── security/       rate limiter, booking risk engine
│   │       ├── vendor/         vendor identity, scoring, secret codes
│   │       └── core/           distributed lock, Redis connection, metrics
│   ├── scripts/
│   │   ├── migrations/         one-off schema/data migrations (dry run by default where supported)
│   │   ├── import/             station import and geocoding
│   │   └── maintenance/        audits, risk replay, temp password, in-memory MongoDB
│   ├── test/                   *.test.js suites; test/helpers/ holds the test DB guard and test server
│   ├── data/                   geocode cache used by the import scripts
│   ├── uploads/                user-uploaded files (not committed)
│   └── .env.example
├── frontend/
│   ├── public/                 static files served from /
│   ├── scripts/devTestDb.mjs   dev server pointed at the test API
│   └── src/
│       ├── pages/              screens by audience: public, auth, customer, vendor, admin
│       ├── components/         reusable UI by domain
│       ├── routes/             route table and guards (ProtectedRoute, RoleRoute)
│       ├── services/           api/ (Axios per backend area), socket/, payment/, qr/
│       ├── store/              Zustand stores
│       ├── hooks/ utils/ constants/ types/ styles/
│       └── main.tsx
├── database/                   export.js / import.js; dump/ (local snapshot, not committed)
├── _archive/                   quarantined scripts and retired files (not used by the app)
└── package.json                convenience scripts for the whole project
```

Frontend imports use the `@/` alias for `frontend/src/`.

## 4. Installation

```bash
npm run install:all
cp backend/.env.example backend/.env
```

Then fill in `backend/.env` (next section).

## 5. Environment variables

All backend settings live in `backend/.env`. That file holds secrets and is
git-ignored. `backend/.env.example` lists every variable with no real values.

| Variable | Purpose |
|---|---|
| `NODE_ENV`, `PORT`, `CLIENT_URL` | Environment, API port (5000), frontend URL used in emails and CORS |
| `CORS_ORIGINS`, `TRUST_PROXY` | Extra allowed browser origins; number of proxies in front of the API |
| `MONGO_URI` | MongoDB connection string |
| `REDIS_URL`, `LOCK_REQUIRE_DISTRIBUTED` | Redis for locks and rate limits; require Redis (default on in production) |
| `JWT_SECRET` | Signs login tokens. Use a long random value |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `UPI_ID`, `UPI_PAYEE_NAME` | Payments |
| `SMTP_*` (or legacy `EMAIL_USER` / `EMAIL_PASS`) | Verification and approval emails; email is off when empty |
| `API_RATE_LIMIT_PER_MINUTE`, `VENDOR_ACCESS_ATTEMPTS_PER_IP`, `RATE_LIMIT_REDIS_TIMEOUT_MS` | Rate limits |
| `SECURITY_EVENT_RETENTION_DAYS`, `RT_LOG` | Security log retention; realtime console logging |
| `TEST_MONGO_URI`, `TEST_API_URL`, `TEST_REDIS_URL` | Tests only |

## 6. Frontend setup

```bash
cd frontend
npm install
npm run dev        # http://localhost:3001, proxies /api, /uploads and /socket.io to :5000
```

To click through against the test API instead of the real database, start
`npm run test:server` and then `node frontend/scripts/devTestDb.mjs` (port 3002 → API 5055).

## 7. Backend setup

```bash
cd backend
npm install
npm start          # node src/server.js on http://localhost:5000
```

Check that it is up at `GET http://localhost:5000/api/health`. The response
reports the MongoDB, lock and rate-limiter modes.

## 8. MongoDB setup

1. Install MongoDB Community Server and start it. The Windows "MongoDB"
   service listens on `127.0.0.1:27017`.
2. Set `MONGO_URI=mongodb://127.0.0.1:27017/fuelmart` in `backend/.env`.
3. Indexes are built automatically when the server starts. To build them all by
   hand, run `node backend/scripts/migrations/createIndexes.js`.
4. Optional: back up or restore a database snapshot.
   - `npm run db:export` writes `database/dump/`. It is read-only.
   - `npm run db:import` loads a snapshot into an empty database. Add
     `-- --drop` to replace existing collections.

Tests never use `fuelmart`. They use `fuelmart_test`, and the test helper
refuses any database whose name does not contain "test".

## 9. Development commands

Run these from `React/`:

| Command | What it does |
|---|---|
| `npm run backend` | Start the API (port 5000) |
| `npm run frontend` | Start the Vite dev server (port 3001) |
| `npm run typecheck` | TypeScript check of the frontend |
| `npm run test:server` | Start the API on the test database (port 5055). Leave it running |
| `npm test` | Run all backend test suites (needs `test:server` running) |
| `npm run test:realtime` | Socket.IO tests only |
| `npm run db:export` / `npm run db:import` | Database snapshot export / import |

## 10. Production build commands

```bash
npm run build                        # type-check + build frontend into frontend/dist
npm run preview                      # serve the built frontend locally
NODE_ENV=production npm --prefix backend start
```

In production:
- set a strong `JWT_SECRET`;
- set `CLIENT_URL` / `CORS_ORIGINS` to the real site;
- set `TRUST_PROXY` when running behind Nginx or a load balancer;
- configure `REDIS_URL`, which is required when `NODE_ENV=production`.

## 11. Main modules

| Module | Where | What it does |
|---|---|---|
| Authentication | `controllers/authController.js`, `middleware/auth.js`, `middleware/requireRole.js` | Register, email verification, login, JWT, role guards |
| Stations & discovery | `routes/stationRoutes.js`, `routes/discoveryRoutes.js`, `services/station/` | Station CRUD, nearby search, smart recommendation |
| Booking | `controllers/bookingController.js`, `routes/slotRoutes.js`, `services/booking/` | Slot availability, booking creation, cancellation, completion |
| Live queue | `routes/queueRoutes.js`, `services/queue/` | Queue per station, nozzle lock, automatic completion, waitlist |
| Inventory | `services/inventory/` | Stock ledger, low-stock thresholds, reorder lead time |
| Payments | `controllers/paymentController.js`, `services/payment/` | Razorpay orders/verification, UPI, pay at station |
| Vendor panel | `controllers/vendorPanelController.js`, `routes/vendorAccessRoutes.js`, `services/vendor/` | Vendor onboarding, station ops, attendant access codes |
| Admin | `routes/adminRoutes.js` | Approvals, verification, dashboards, metrics |
| Realtime | `services/notification/realtime.js`, `frontend/src/services/socket/` | Authenticated rooms per user, vendor, station and admin |
| Security | `services/security/`, `services/core/lock.js` | Rate limits, booking risk scoring, distributed locks |

## 12. API overview

All endpoints are under `/api`. JSON in, JSON out, and `Authorization: Bearer <JWT>` where login is required.

| Base path | Area |
|---|---|
| `/api/auth` | Register, login, verify email, password |
| `/api/stations` | Stations (public list, vendor management) |
| `/api/bookings` | Customer bookings, availability, check-in |
| `/api/razorpay` | Payment order and verification |
| `/api/vendors`, `/api/vendor-panel`, `/api/vendor-access` | Vendor onboarding, panel, attendant access |
| `/api/customer` | Customer profile, vehicles, history |
| `/api/activation` | Account/station activation |
| `/api/v1/discovery` | Nearby stations with live queue |
| `/api/v1/slots` | Slot booking, recommendations, waitlist |
| `/api/v1/queue` | Live queue per station |
| `/api/v1/admin` (also `/api/superadmin`) | Admin |
| `/api/health`, `/api/v1/metrics` | Health check; admin-only counters |
| `/uploads/*` | Uploaded images and documents (read-only) |

## 13. Algorithm overview

- **Nearest stations (KNN)**: `services/algorithms/geo.js` ranks stations by
  Haversine distance from the customer. `services/station/discovery.js` and
  `stationFinder.js` combine distance with the live wait.
- **Queue estimate**: `services/algorithms/queue.js` holds the queue maths
  (Erlang-C style wait estimates). `services/station/stationMetrics.js`
  recalibrates its inputs from real bookings every 15 minutes.
- **Live queue and ETA**: `services/queue/stationQueue.js` orders cars at the
  pump (arrived first, then booked slot) and pushes changes as time passes.
- **Nozzle scheduling and locking**: `services/queue/nozzleScheduler.js`
  reserves each nozzle's time at booking. `nozzleService.js` locks the nozzle
  while a car is fuelling, backed by a unique database index. Fill times are
  40 s for petrol/diesel and 300 s for CNG (`config/fuelDurations.js`).
- **Automatic completion**: `services/queue/serviceTimer.js` completes a fill
  at its release time and hands the nozzle to the next waiting car. A 5-second
  sweep (`services/booking/bookingSweep.js`) catches anything missed.
- **Smart recommender**: `services/station/smartRecommender.js` suggests a
  station that can serve the same booking sooner.
- **Waitlist**: `services/queue/waitlist.js` promotes the first waiting
  customer when a slot frees up.
- **Stock and forecasting**: `services/inventory/stockLedger.js` commits and
  deducts stock per booking. `services/algorithms/forecast.js` and
  `inventory/leadTime.js` predict demand and reorder time.
- **Booking risk**: `services/security/riskEngine.js` scores booking attempts
  to stop abuse.
- **Rate limiting**: `services/security/rateLimiter.js` runs a Redis
  sliding window, with an in-memory fallback.
