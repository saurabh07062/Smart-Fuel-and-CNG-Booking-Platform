
## 7. Complete End-to-End Workflow

### A. Customer Workflow (The Driver)
1. **Onboarding:** The customer downloads the app (or visits the web portal), registers, and logs in.
2. **Location & Discovery:** The app requests GPS access. It scans the database for nearby stations, calculating distance and current queue times.
3. **Station Selection:** The customer views a list (or map) of stations, checking fuel availability (Petrol, Diesel, CNG) and the Live ETA.
4. **Slot Booking:** The customer selects a station, chooses their fuel type and quantity (e.g., 20 Liters of Petrol), and picks an available time slot.
5. **Payment & Confirmation:** The customer pays via Razorpay/UPI (or selects 'Pay at Station'). The system deducts the fuel from the station's virtual inventory and generates a unique **4-digit Check-in PIN**.
6. **Live Tracking:** As the customer drives to the station, they can track their live position in the virtual queue from their phone.
7. **Arrival & Check-in:** The customer arrives, skips the regular queue, and gives their PIN to the attendant.
8. **Completion:** The attendant enters the PIN, the system locks the nozzle, fuels the car, and automatically completes the session, moving the queue forward.

### B. Vendor Workflow (Station Owner/Attendant)
1. **Registration:** A pump owner registers their station details (address, number of nozzles, fuel types, tank capacities).
2. **Admin Approval Wait:** The station remains 'inactive' until a Super Admin verifies their documents.
3. **Live Dashboard:** Once approved, the vendor logs in and opens the Live Queue Dashboard on a tablet or computer.
4. **Queue Management:** The dashboard displays all upcoming bookings. The vendor can see exactly who is arriving and at what time.
5. **Customer Check-in:** When a customer arrives, the vendor types their 4-digit PIN into the dashboard. The system verifies it and assigns them to an open pump.
6. **Inventory Tracking:** The vendor receives automated alerts if the station's fuel reserves fall below the critical threshold, allowing them to reorder fuel before they run out.

### C. Super Admin Workflow (System Manager)
1. **Dashboard Overview:** The admin logs into the master control panel to view system-wide metrics (total bookings, active stations, total revenue).
2. **Vendor Verification:** The admin reviews newly registered vendors, checks their credentials, and clicks 'Approve' to activate their station on the map.
3. **System Health:** The admin monitors the live system, tracks any rate-limiting alerts (security), and has the power to ban or suspend abusive user accounts.
