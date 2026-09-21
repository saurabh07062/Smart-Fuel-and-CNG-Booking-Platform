# Customer app: feature changelog

No existing feature, route or API was removed. Every change adds to what was there.

## Stations
- New filter chips: **Diesel** (next to All / Petrol / CNG), **Open now** and **Low queue**. They combine with each other, with search and with sorting.
- Station cards show prices as `₹100.00/L`. A fuel the station has marked unavailable shows **Out of stock**.
- A closed or fully out-of-stock station is greyed out. Its dead "Book Now" button is replaced by **Try nearby**, which opens the nearest-pump finder.

## Search
- **Recent searches**: the last 5 searches (stored on this device only) appear under the empty search box, with **Clear**.

## Booking wizard
- The **earliest bookable slot is preselected** once the station's slots load. It can still be changed.
- The slot count is shown only when a slot is running low, as **Filling fast · x left** (20% of places or fewer, minimum 3).
- The **one-booking-at-a-time** screen is friendlier: it shows the current booking (station, date, slot, fuel, litres, status), with **View booking** and **Cancel & rebook**. Cancel & rebook cancels the current booking and continues into the new one. It is disabled while fueling is in progress.

## Booking confirmed / track
- **Leave by** reminder: slot start minus drive time minus 5 minutes spare. It says "Leave now" once that time has passed, and asks for location when there is no route.
- **Status timeline**: Booked → On the way → At pump → Completed, driven by the booking's live status.
- **Cancel with reasons**: the browser's "Are you sure?" pop-up is replaced by a confirmation panel with optional reason chips. The reason is saved with the booking (`cancelReason`); unknown values are ignored. Used on the track page, Home and the one-booking screen.

## QR Pass
- **Copy** button next to the PIN.
- **Save image**: downloads the QR with the PIN, station, date, slot and fuel as a PNG for offline use.
- **Retry** when the QR fails to draw. The PIN stays visible.
- Keeps the screen awake while the pass is open (where the browser supports it).
- **Scan to pay at pump** is now a collapsible section.

## Home
- **Quick actions** row: Book fuel, Nearest, My vehicles, History. History jumps to the full booking list.

## Vehicles
- The registration number is typed in capitals with spaces and dashes removed, and checked with the same rule the booking wizard uses. A vehicle saved earlier with an unusual plate can still be edited without changing its plate.

## Notifications (toasts)
- One toast at a time, 3 seconds each, then the next. Tap or swipe sideways to dismiss. At most 4 are queued.

## Not done, and why
- **"Only 5 L left" badge**: stock levels are private to the station (not in the public station data). Showing them would publish each pump's stock, so only the available / out-of-stock flag is used.
- **Screen brightness boost**: browsers cannot change brightness. The pass keeps the screen awake instead.

## Tests
- New: frontend `customerFeatures.test.tsx` and `Stations.test.tsx`; backend `cancelReason.test.js` (test database only).
- Frontend 156/156 passing; backend 612 passing, 0 failing.
