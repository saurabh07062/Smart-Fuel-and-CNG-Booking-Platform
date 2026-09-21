import { useState } from "react";
import * as api from "@/services/api/vendorApi";
import type { NozzleSetup, VendorStation } from "@/services/api/vendorApi";
import { pushToast } from "@/store/toastStore";
import { useVendorStore } from "@/store/vendorStore";
import { toApiError } from "@/services/api/apiClient";
import { VENDOR_FUELS, toVendorFuels, type VendorFuel } from "@/utils/vendorFuels";

const MAX_NOZZLES = 20;

/** What the setup means, in one line. */
export function nozzleSummary(setup: NozzleSetup | null | undefined): string {
  if (!setup) return "1 nozzle shared by app bookings and walk-ins";
  const offline = setup.total - setup.online;
  const n = (k: number) => `${k} nozzle${k === 1 ? "" : "s"}`;
  if (setup.online === 0) return `${setup.total} for walk-ins · no app booking`;
  if (offline === 0) return `${n(setup.total)} shared by app bookings and walk-ins`;
  return `${setup.online} for app bookings · ${offline} for walk-ins`;
}

/**
 * How many nozzles each fuel has, and how many of them take app bookings
 * (online, each a booking resource); the rest serve walk-ins. Backend: PATCH
 * /vendor-panel/stations/:id/nozzles (config/nozzleModes.js).
 */
export default function NozzleModes({ station }: { station: VendorStation }) {
  const loadStations = useVendorStore((s) => s.loadStations);
  const fuels = toVendorFuels(station.fuelTypes);
  const saved = (fuel: VendorFuel): NozzleSetup | null => station.nozzleConfig?.[fuel] ?? null;
  const [draft, setDraft] = useState<Partial<Record<VendorFuel, NozzleSetup>>>({});
  const [saving, setSaving] = useState<VendorFuel | null>(null);
  if (fuels.length === 0) return null;

  const value = (fuel: VendorFuel): NozzleSetup => draft[fuel] ?? saved(fuel) ?? { total: 1, online: 1 };
  const change = (fuel: VendorFuel, next: NozzleSetup) => setDraft((d) => ({ ...d, [fuel]: next }));
  const dirty = (fuel: VendorFuel) => {
    const d = draft[fuel];
    const s = saved(fuel);
    return !!d && (!s || d.total !== s.total || d.online !== s.online);
  };

  const save = async (fuel: VendorFuel) => {
    const v = value(fuel);
    if (!Number.isInteger(v.total) || v.total < 1 || v.total > MAX_NOZZLES) {
      pushToast(`Total nozzles must be 1 to ${MAX_NOZZLES}`, "error");
      return;
    }
    setSaving(fuel);
    try {
      await api.updateNozzleConfig(String(station._id), { [fuel]: v });
      const label = VENDOR_FUELS.find((f) => f.key === fuel)?.label ?? fuel;
      pushToast(`${label}: ${nozzleSummary(v)}`, "success");
      setDraft((d) => {
        const { [fuel]: _done, ...rest } = d;
        return rest;
      });
      await loadStations();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="vm-bg-ground rounded-lg border vm-border p-3 mb-4" data-testid="nozzle-modes">
      <p className="text-[10px] vm-text-muted uppercase font-bold mb-2">
        <i className="fas fa-gas-pump mr-1" aria-hidden /> Nozzle assignment
      </p>
      <div className="space-y-3">
        {fuels.map((fuel) => {
          const label = VENDOR_FUELS.find((f) => f.key === fuel)?.label ?? fuel;
          const v = value(fuel);
          return (
            <div key={fuel} data-testid={`nozzle-${fuel}`}>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-xs font-bold w-14">{label}</span>
                <label className="flex items-center gap-1 text-[11px] vm-text-muted">
                  Total
                  <input
                    type="number"
                    min={1}
                    max={MAX_NOZZLES}
                    step={1}
                    aria-label={`${label} total nozzles`}
                    value={Number.isFinite(v.total) ? v.total : ""}
                    onChange={(e) => {
                      const total = Math.floor(Number(e.target.value));
                      change(fuel, { total, online: Math.min(v.online, Math.max(total, 0)) });
                    }}
                    className="w-14 vm-bg-surface border vm-border rounded-md px-2 py-1 text-xs vm-text"
                  />
                </label>
                <label className="flex items-center gap-1 text-[11px] vm-text-muted">
                  Online
                  <input
                    type="number"
                    min={0}
                    max={Number.isFinite(v.total) ? v.total : MAX_NOZZLES}
                    step={1}
                    aria-label={`${label} online nozzles`}
                    title="Nozzles for app bookings; the rest serve walk-ins"
                    value={Number.isFinite(v.online) ? v.online : ""}
                    onChange={(e) => {
                      const online = Math.floor(Number(e.target.value));
                      change(fuel, { ...v, online: Math.max(0, Math.min(online, v.total)) });
                    }}
                    className="w-14 vm-bg-surface border vm-border rounded-md px-2 py-1 text-xs vm-text"
                  />
                </label>
                {dirty(fuel) && (
                  <button
                    type="button"
                    onClick={() => void save(fuel)}
                    disabled={saving !== null}
                    className="vm-accent vm-accent-hover vm-text font-bold px-2.5 py-1 rounded-md text-[11px] disabled:opacity-60"
                  >
                    {saving === fuel ? "Saving…" : "Save"}
                  </button>
                )}
              </div>
              <p className="text-[11px] vm-text-muted mt-1 ml-[68px]">{nozzleSummary(dirty(fuel) ? v : saved(fuel))}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
