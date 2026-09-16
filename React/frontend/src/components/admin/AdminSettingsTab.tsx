import { useEffect, useState } from "react";
import * as api from "@/services/api/adminApi";
import { useAdminStore } from "@/store/adminStore";
import { pushToast } from "@/store/toastStore";
import { toApiError } from "@/services/api/apiClient";
import { ConsoleLoading } from "@/components/console/ConsoleBits";

/**
 * Port of the Settings panel and saveAdminSettings().
 *
 * Worth being explicit about what this screen actually does, because its
 * heading ("Edit Station Details (Live Sync)") does not say so: it edits
 * ONE station -- `STATIONS[0]`, the first station in the list -- not any
 * platform-wide setting. That is preserved, and the station's name is now
 * shown so the admin can see which one they are about to change; the Vanilla
 * version gave no indication at all.
 */
export default function AdminSettingsTab() {
  const stations = useAdminStore((s) => s.stations);
  const loadStations = useAdminStore((s) => s.loadStations);

  const [address, setAddress] = useState("");
  const [petrol, setPetrol] = useState("");
  const [diesel, setDiesel] = useState("");
  const [cng, setCng] = useState("");
  const [saving, setSaving] = useState(false);

  // The Settings tab does not fetch stations itself in the original either;
  // it reads the already-loaded list. Loading it here means opening Settings
  // first no longer shows an empty form.
  useEffect(() => {
    if (stations === null) void loadStations();
  }, [stations, loadStations]);

  const station = stations?.[0];

  useEffect(() => {
    if (!station) return;
    const prices = (station.prices ?? {}) as Record<string, number | undefined>;
    setAddress(station.address ?? "");
    setPetrol(String(prices.petrol ?? 96.72));
    setDiesel(String(prices.diesel ?? 89.62));
    setCng(String(prices.cng ?? 75.5));
  }, [station]);

  if (stations === null) return <ConsoleLoading label="Loading station..." />;

  if (!station) {
    return (
      <div className="vm-bg-surface p-6 rounded-2xl border vm-border">
        <h3 className="text-lg font-bold mb-2">Edit Station Details (Live Sync)</h3>
        <p className="vm-text-muted text-sm">No station to update. Add a station first.</p>
      </div>
    );
  }

  const save = async () => {
    const p = parseFloat(petrol);
    const d = parseFloat(diesel);
    const c = parseFloat(cng);
    if (!address.trim() || Number.isNaN(p) || Number.isNaN(d) || Number.isNaN(c)) {
      pushToast("Please enter valid details", "error");
      return;
    }
    setSaving(true);
    try {
      await api.updateStationAdmin(String(station._id), {
        address: address.trim(),
        prices: { petrol: p, diesel: d, cng: c },
      });
      pushToast("Station details synchronized across network", "success");
      await loadStations();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setSaving(false);
    }
  };

  const inputCls = "w-full vm-input px-4 py-3 text-sm vm-text";

  const fields: Array<[string, string, (v: string) => void, string]> = [
    ["Station Location", address, setAddress, "text"],
    ["Petrol Price (₹/L)", petrol, setPetrol, "number"],
    ["Diesel Price (₹/L)", diesel, setDiesel, "number"],
    ["CNG Price (₹/Kg)", cng, setCng, "number"],
  ];

  return (
    <div className="grid grid-cols-1">
      <div className="vm-bg-surface p-6 rounded-2xl border vm-border">
        <h3 className="text-lg font-bold mb-1">Edit Station Details (Live Sync)</h3>
        <p className="vm-text-muted text-sm mb-4">
          Editing <span className="vm-text font-bold">{station.name}</span>. Use Manage Stations to
          edit any other station.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
          {fields.map(([label, value, setter, type]) => (
            <div key={label}>
              <label className="block text-xs font-bold vm-text-muted mb-2">{label}</label>
              <input
                type={type}
                step={type === "number" ? "0.01" : undefined}
                className={inputCls}
                value={value}
                onChange={(e) => setter(e.target.value)}
              />
            </div>
          ))}
        </div>
        <div className="mt-6 flex justify-end">
          <button
            onClick={save}
            disabled={saving}
            className="vm-accent vm-accent-hover vm-text font-bold py-2.5 px-6 rounded-lg transition-colors flex items-center gap-2"
          >
            <i className="fas fa-save" aria-hidden /> {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
