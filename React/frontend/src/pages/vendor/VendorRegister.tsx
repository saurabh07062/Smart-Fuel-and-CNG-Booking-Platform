import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  addressProblem,
  collectProblems,
  confirmProblem,
  emailProblem,
  gstProblem,
  nameProblem,
  passwordProblem,
  phoneProblem,
} from "@/utils/accountFields";
import { useNavigate } from "react-router-dom";
import L from "leaflet";
import { useLeafletMap, PUNE } from "@/hooks/useLeafletMap";
import { registerVendor } from "@/services/api/vendorApi";
import { pushToast } from "@/store/toastStore";

/**
 * Port of renderVendorRegister() + vendorRegisterAttach() in
 * js/pages/vendorRegister.js. Same four steps, sidebar, stepper, map picker,
 * field names and multipart payload sent to POST /api/vendors/register.
 */
type Step = 1 | 2 | 3 | 4;

const STEP_COPY: Record<Step, [string, string]> = {
  1: ["Step 1: Business Profile", "Establish your business presence. Fill in details accurately for faster verification."],
  2: ["Step 2: Service Details", "Tell us what you sell and how many pumps you run."],
  3: ["Step 3: Documents", "Upload your licence and registration documents for verification."],
  4: ["Step 4: Review & Submit", "Check everything over, then send your application for approval."],
};
const STEP_LABELS = ["PROFILE", "SERVICES", "DOCUMENTS", "REVIEW"];
import { FUEL_REQUIRED_MSG, toVendorFuels } from "@/utils/vendorFuels";

const FUELS: Array<[string, string]> =[["petrol", "Petrol"], ["diesel", "Diesel"], ["cng", "CNG"], ["ev_charging", "EV Charging"]];

const inputCls = "w-full bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-2";

export default function VendorRegister() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    businessName: "", ownerName: "", email: "", pass: "", passConfirm: "",
    gst: "", type: "Fuel Station Operator", address: "", mobile: "", pumps: "", hours: "",
  });
  const [fuels, setFuels] = useState<string[]>([]);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const logoRef = useRef<HTMLInputElement>(null);
  const licenseRef = useRef<HTMLInputElement>(null);
  const gstRef = useRef<HTMLInputElement>(null);

  const { containerRef, mapRef, ready } = useLeafletMap({ center: PUNE, zoom: 12 });
  const markerRef = useRef<L.Marker | null>(null);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    const value = e.target.value;
    setF((p) => ({ ...p, [k]: value }));
    // Once a field has been corrected, stop showing the old complaint.
    setErrors((p) => (p[k] ? { ...p, [k]: "" } : p));
  };
  const blur = (k: keyof typeof f) => () => setTouched((p) => ({ ...p, [k]: true }));

  /**
   * Every rule the server will apply (utils/accountFields.ts), checked here
   * so the applicant is told before they upload documents and press Submit.
   * The server checks all of it again -- this only decides what to show.
   */
  const problems = (): Record<string, string> =>
    collectProblems({
      businessName: nameProblem(f.businessName, { label: "Business name" }),
      ownerName: nameProblem(f.ownerName, { label: "Owner name" }),
      email: emailProblem(f.email),
      pass: passwordProblem(f.pass),
      passConfirm: confirmProblem(f.pass, f.passConfirm),
      gst: gstProblem(f.gst),
      address: addressProblem(f.address),
      mobile: phoneProblem(f.mobile),
    });

  /** The fields each step owns, so Next only blocks on what is on screen. */
  const STEP_FIELDS: Record<number, string[]> = {
    1: ["businessName", "ownerName", "email", "pass", "passConfirm", "gst", "address", "mobile"],
    2: [],
    3: [],
    4: [],
  };

  /** True when this step is clean; otherwise it marks and shows the problems. */
  const stepIsValid = (which: number): boolean => {
    const found = problems();
    const mine = (STEP_FIELDS[which] ?? []).filter((k) => found[k]);
    if (mine.length === 0) return true;
    setErrors(found);
    setTouched((p) => ({ ...p, ...Object.fromEntries(mine.map((k) => [k, true])) }));
    pushToast(found[mine[0]], "error");
    return false;
  };

  /** The message under a field: only after it has been touched. */
  const fieldError = (k: string): string | null => (touched[k] ? errors[k] || null : null);
  const errText = (k: string) => {
    const msg = fieldError(k);
    return msg ? (
      <p role="alert" className="text-xs mt-1" style={{ color: "var(--danger, #dc2626)" }}>
        {msg}
      </p>
    ) : null;
  };

  function setMarker(lat: number, lng: number) {
    const map = mapRef.current;
    if (!map) return;
    if (markerRef.current) markerRef.current.setLatLng([lat, lng]);
    else {
      const m = L.marker([lat, lng], { draggable: true }).addTo(map);
      m.on("dragend", (ev) => {
        const p = (ev.target as L.Marker).getLatLng();
        setMarker(p.lat, p.lng);
      });
      markerRef.current = m;
    }
    setCoords({ lat, lng });
  }

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const onClick = (e: L.LeafletMouseEvent) => setMarker(e.latlng.lat, e.latlng.lng);
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // At least one of Petrol, Diesel, CNG -- the vendor panel shows only the fuels chosen here.
  const [fuelError, setFuelError] = useState<string | null>(null);
  /** Field -> what is wrong with it, shown under that field once touched. */
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const fuelsChosen = toVendorFuels(fuels).length > 0;

  function showStep(n: Step) {
    if (n > 2 && !fuelsChosen) {
      setFuelError(FUEL_REQUIRED_MSG);
      setStep(2);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setStep(n);
    // Leaflet mis-measures a container that was hidden; re-measure when step 1 returns.
    if (n === 1) window.setTimeout(() => mapRef.current?.invalidateSize(), 60);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const setPune = () => {
    setMarker(PUNE[0], PUNE[1]);
    mapRef.current?.setView(PUNE, 14);
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) return pushToast("Geolocation not available", "error");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setMarker(pos.coords.latitude, pos.coords.longitude);
        mapRef.current?.setView([pos.coords.latitude, pos.coords.longitude], 15);
      },
      (err) => {
        console.error(err);
        pushToast("Unable to get your location", "error");
      },
    );
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (step !== 4) {
      // Enter in a field before the last step advances, as before -- but a
      // step with a problem in it stays put and says what it is.
      if (!stepIsValid(step)) return;
      showStep((step + 1) as Step);
      return;
    }
    if (!fuelsChosen) {
      showStep(4); // sends them back to step 2 with the message
      return;
    }
    // The last gate before the upload: every field, not just this step's.
    const found = problems();
    if (Object.keys(found).length > 0) {
      setErrors(found);
      setTouched((p) => ({ ...p, ...Object.fromEntries(Object.keys(found).map((k) => [k, true])) }));
      pushToast(found[Object.keys(found)[0]], "error");
      showStep(1);
      return;
    }
    // Guard a second press while the first is in flight.
    if (busy) return;
    setBusy(true);
    const data = new FormData();
    data.append("businessName", f.businessName);
    data.append("name", f.ownerName);
    data.append("email", f.email);
    data.append("phone", f.mobile);
    data.append("vendorAddress", f.address);
    // The Vanilla form had no inputs for these, so it always sent them empty.
    data.append("city", "");
    data.append("state", "");
    data.append("pincode", "");
    data.append("gstNumber", f.gst);
    data.append("licenseNo", "");
    data.append("products", fuels.join(","));
    data.append("pumps", f.pumps);
    data.append("openingHours", f.hours);
    data.append("bankDetails", "");
    data.append("password", f.pass);
    data.append("confirmPassword", f.passConfirm);
    data.append("terms", "false");
    data.append("vendorDescription", "");
    if (coords) {
      data.append("latitude", String(coords.lat));
      data.append("longitude", String(coords.lng));
    }
    const license = licenseRef.current?.files?.[0];
    const gstFile = gstRef.current?.files?.[0];
    const logo = logoRef.current?.files?.[0];
    if (license) data.append("licenseFile", license);
    if (gstFile) data.append("gstFile", gstFile);
    if (logo) data.append("logoFile", logo);

    const r = await registerVendor(data);
    setBusy(false);
    if (!r.ok) {
      // The API names the field it refused; put the message under it rather
      // than leaving the applicant to guess which box was wrong.
      const FIELD_TO_INPUT: Record<string, string> = {
        name: "ownerName",
        businessName: "businessName",
        email: "email",
        password: "pass",
        confirmPassword: "passConfirm",
        phone: "mobile",
        gstNumber: "gst",
        vendorAddress: "address",
      };
      const input = r.field ? FIELD_TO_INPUT[r.field] : undefined;
      if (input) {
        setErrors((p) => ({ ...p, [input]: r.msg }));
        setTouched((p) => ({ ...p, [input]: true }));
        showStep(1);
      }
      pushToast(r.msg, "error");
      return;
    }
    pushToast(
      r.msg || "Thank you for registering. Your application is pending admin approval — we will notify you when it is reviewed.",
      "success",
    );
    if (r.vendorId) {
      try {
        localStorage.setItem("fm_vendor_application_id", r.vendorId);
      } catch {
        /* storage blocked -- the tracker still gets the id from the URL */
      }
    }
    window.setTimeout(() => navigate(r.vendorId ? `/vendor/track?id=${r.vendorId}` : "/vendor/track"), 600);
  }

  const [title, subtitle] = STEP_COPY[step];
  const navBtn = (target: Step | "tracker", label: string) => {
    const active = target === step;
    return (
      <button
        type="button"
        key={label}
        className={`vr-nav w-full text-left px-3 py-2 rounded-md ${active ? "bg-[var(--primary)] text-white font-semibold" : "hover:bg-[var(--bg)]"}`}
        onClick={() => (target === "tracker" ? navigate("/vendor/track") : showStep(target))}
      >
        {label}
      </button>
    );
  };
  const stepButtons = (prev: Step | null, next: Step | null, nextLabel?: string) => (
    <div className="flex items-center gap-3 mt-4">
      {prev && (
        <button type="button" className="px-6 py-2 border rounded-md" onClick={() => showStep(prev)}>← BACK</button>
      )}
      {next && (
        <button
          type="button"
          className="ml-auto bg-black text-white px-6 py-2 rounded-md"
          onClick={() => {
            if (next > step && !stepIsValid(step)) return;
            showStep(next);
          }}
        >
          {nextLabel}
        </button>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-[var(--bg)] py-8 px-4 md:px-6">
      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
        <aside className="lg:col-span-3 bg-[var(--card)] rounded-lg p-6 border border-[var(--border)]">
          <div className="mb-6 flex items-center gap-3">
            <div className="w-12 h-12 rounded-md bg-[var(--primary)] flex items-center justify-center text-white font-bold">V</div>
            <div>
              <h3 className="font-bold">Vendor Onboarding</h3>
              <p className="text-xs text-[var(--muted)]">CNG / Fuel Services</p>
            </div>
          </div>
          <nav className="space-y-3 text-sm">
            {navBtn(1, "Business Profile")}
            {navBtn(2, "Service Details")}
            {navBtn(3, "Documents")}
            {navBtn("tracker", "Status Tracker")}
          </nav>
          <div className="mt-6">
            <button
              type="button"
              className="w-full bg-black text-white py-2 rounded-md"
              onClick={() => {
                window.location.href = "mailto:saurabh07062@gmail.com?subject=FuelMart%20vendor%20onboarding%20help";
              }}
            >
              Contact Specialist
            </button>
          </div>
        </aside>

        <main className="lg:col-span-9">
          <div className="mb-6">
            <div className="flex items-center gap-6">
              {STEP_LABELS.map((label, idx) => {
                const active = idx + 1 === step;
                return (
                  <div key={label} className="flex-1 text-center">
                    <div className={`w-10 h-10 mx-auto rounded-full ${active ? "bg-black text-white" : "bg-[var(--muted-bg)] text-[var(--muted)]"} flex items-center justify-center font-bold`}>
                      {idx + 1}
                    </div>
                    <div className="text-xs mt-2">{label}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-[var(--card)] rounded-lg border border-[var(--border)] p-8">
            <h1 className="text-3xl font-bold mb-2">{title}</h1>
            <p className="text-sm text-[var(--muted)] mb-6">{subtitle}</p>

            <form onSubmit={onSubmit}>
              {/* Hidden rather than unmounted, so the map and the chosen files survive step changes. */}
              <div className={`grid grid-cols-1 lg:grid-cols-2 gap-6 ${step === 1 ? "" : "hidden"}`}>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold mb-2">Legal Business Name *</label>
                    <input
                      className="w-full bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-3 text-lg"
                      required
                      value={f.businessName}
                      onChange={set("businessName")}
                      onBlur={blur("businessName")}
                      aria-invalid={Boolean(fieldError("businessName"))}
                    />
                    {errText("businessName")}
                    <p className="text-xs text-[var(--muted)] mt-1">Must exactly match GST/VAT documentation.</p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold mb-2">Owner / Contact Name *</label>
                      <input className={inputCls} required value={f.ownerName} onChange={set("ownerName")} onBlur={blur("ownerName")} aria-invalid={Boolean(fieldError("ownerName"))} />
                      {errText("ownerName")}
                    </div>
                    <div>
                      <label className="block text-xs font-bold mb-2">Email Address *</label>
                      <input type="email" className={inputCls} required value={f.email} onChange={set("email")} onBlur={blur("email")} aria-invalid={Boolean(fieldError("email"))} />
                      {errText("email")}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold mb-2">Password *</label>
                      <input type="password" className={inputCls} required value={f.pass} onChange={set("pass")} onBlur={blur("pass")} autoComplete="new-password" aria-invalid={Boolean(fieldError("pass"))} />
                      {errText("pass")}
                      <p className="text-xs text-[var(--muted)] mt-1">At least 8 characters.</p>
                    </div>
                    <div>
                      <label className="block text-xs font-bold mb-2">Confirm Password *</label>
                      <input type="password" className={inputCls} required value={f.passConfirm} onChange={set("passConfirm")} onBlur={blur("passConfirm")} autoComplete="new-password" aria-invalid={Boolean(fieldError("passConfirm"))} />
                      {errText("passConfirm")}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold mb-2">GSTIN / Tax ID</label>
                      <input className={inputCls} value={f.gst} onChange={set("gst")} onBlur={blur("gst")} placeholder="27ABCDE1234F1Z5" aria-invalid={Boolean(fieldError("gst"))} />
                      {errText("gst")}
                    </div>
                    <div>
                      <label className="block text-xs font-bold mb-2">Business Type</label>
                      <select className={inputCls} value={f.type} onChange={set("type")}>
                        <option>Fuel Station Operator</option>
                        <option>Distributor</option>
                        <option>Retailer</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-bold mb-2">Full Postal Address</label>
                    <textarea rows={4} className={inputCls} value={f.address} onChange={set("address")} onBlur={blur("address")} aria-invalid={Boolean(fieldError("address"))} />
                    {errText("address")}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold mb-2">Primary Contact Number</label>
                      <div className="flex">
                        <input value="+91" className="w-20 bg-[var(--muted-bg)] border border-[var(--border)] rounded-l-lg px-3 py-2" disabled />
                        <input
                          className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded-r-lg px-3 py-2"
                          value={f.mobile}
                          onChange={set("mobile")}
                          onBlur={blur("mobile")}
                          inputMode="numeric"
                          maxLength={10}
                          placeholder="10-digit mobile"
                          aria-invalid={Boolean(fieldError("mobile"))}
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-bold mb-2">Station Geolocation</label>
                      <div className="w-full bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-3 text-sm flex items-center justify-between">
                        <div>
                          Selected:{" "}
                          <span className="font-bold">
                            {coords ? `${coords.lat.toFixed(6)}°, ${coords.lng.toFixed(6)}°` : "Not selected"}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button type="button" className="ml-2 text-xs px-2 py-1 border rounded" onClick={() => containerRef.current?.scrollIntoView({ behavior: "smooth" })}>
                            Pick on map
                          </button>
                          <button type="button" className="ml-2 text-xs px-2 py-1 border rounded" onClick={setPune}>
                            Set to Pune
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 mt-4">
                    {/* Vanilla rendered this with no handler; kept inert for parity. */}
                    <button type="button" className="px-6 py-2 border rounded-md">Save for Later</button>
                    <button type="button" className="ml-auto bg-black text-white px-6 py-2 rounded-md" onClick={() => showStep(2)}>
                      CONTINUE TO STEP 2 →
                    </button>
                  </div>
                </div>

                <div className="space-y-4">
                  <div ref={containerRef} className="h-64 bg-[var(--muted-bg)] border border-[var(--border)] rounded-lg" />
                  <div className="flex justify-between text-xs text-[var(--muted)]">
                    <div>Tip: Click on map to set station location.</div>
                    <button type="button" className="text-xs px-2 py-1 border rounded" onClick={useMyLocation}>
                      Use my location
                    </button>
                  </div>
                </div>
              </div>

              <div className={`space-y-4 ${step === 2 ? "" : "hidden"}`}>
                <div>
                  <label className="block text-xs font-bold mb-2">Provided Products * (select all that apply)</label>
                  <div className="flex gap-3" role="group" aria-label="Provided Products">
                    {FUELS.map(([value, label]) => (
                      <label key={value}>
                        <input
                          type="checkbox"
                          value={value}
                          checked={fuels.includes(value)}
                          onChange={(e) => {
                            setFuelError(null);
                            setFuels((p) => (e.target.checked ? [...p, value] : p.filter((x) => x !== value)));
                          }}
                        />{" "}
                        {label}
                      </label>
                    ))}
                  </div>
                  {fuelError ? (
                    <p role="alert" className="text-xs mt-2 text-red-600">
                      {fuelError}
                    </p>
                  ) : (
                    <p className="text-xs mt-2 text-[var(--muted)]">
                      Your vendor panel will show only the fuels you select here.
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold mb-2">Number of Pumps</label>
                    <input type="number" min={0} className={inputCls} value={f.pumps} onChange={set("pumps")} />
                  </div>
                  <div>
                    <label className="block text-xs font-bold mb-2">Opening Hours</label>
                    <input placeholder="e.g. 24 Hours or 06:00-22:00" className={inputCls} value={f.hours} onChange={set("hours")} />
                  </div>
                </div>
                {stepButtons(1, 3, "CONTINUE TO STEP 3 →")}
              </div>

              <div className={`space-y-4 ${step === 3 ? "" : "hidden"}`}>
                <div className="grid grid-cols-1 gap-3">
                  <label className="block text-xs font-bold">Upload Company Logo *</label>
                  <input ref={logoRef} type="file" accept="image/*" />
                  <label className="block text-xs font-bold">Upload Business License *</label>
                  <input ref={licenseRef} type="file" accept="image/*,.pdf" />
                  <label className="block text-xs font-bold">Upload GST Certificate (Optional)</label>
                  <input ref={gstRef} type="file" accept="image/*,.pdf" />
                </div>
                {stepButtons(2, 4, "CONTINUE TO STEP 4 →")}
              </div>

              <div className={`space-y-4 ${step === 4 ? "" : "hidden"}`}>
                <div className="text-sm text-[var(--muted)]">
                  <div><strong>Business:</strong> {f.businessName || "—"}</div>
                  <div><strong>Owner:</strong> {f.ownerName || "—"}</div>
                  <div><strong>Email:</strong> {f.email || "—"}</div>
                  <div><strong>Products:</strong> {fuels.join(", ") || "—"}</div>
                  <div><strong>Pumps:</strong> {f.pumps || "—"}</div>
                  <div><strong>Hours:</strong> {f.hours || "—"}</div>
                </div>
                <div className="flex items-center gap-3 mt-4">
                  <button type="button" className="px-6 py-2 border rounded-md" onClick={() => showStep(3)}>← BACK</button>
                  <button type="submit" disabled={busy} className="ml-auto bg-green-600 text-white px-6 py-2 rounded-md">
                    SUBMIT APPLICATION
                  </button>
                </div>
              </div>
            </form>
          </div>
        </main>
      </div>
    </div>
  );
}
