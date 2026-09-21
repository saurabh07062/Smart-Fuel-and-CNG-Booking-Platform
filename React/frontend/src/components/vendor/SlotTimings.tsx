import { useState } from "react";
import * as api from "@/services/api/vendorApi";
import type { DayHours, OperatingSchedule, ScheduleDay, VendorStation } from "@/services/api/vendorApi";
import { pushToast } from "@/store/toastStore";
import { useVendorStore } from "@/store/vendorStore";
import { toApiError } from "@/services/api/apiClient";

const SCHEDULE_DAYS: readonly ScheduleDay[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

type Mode = "24h" | "hours" | "closed";

const DEFAULT_DAY: DayHours = { open: "06:00", close: "22:00", is24h: true, isClosed: false };

const modeOf = (d: DayHours): Mode => (d.isClosed ? "closed" : d.is24h ? "24h" : "hours");

/** "6:00 AM" from "06:00". */
function clock12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** What customers will see for one day. */
export function daySummary(d: DayHours): string {
  if (d.isClosed) return "Closed · no slots";
  if (d.is24h) return "Open 24 hours · slots all day";
  return `Slots ${clock12(d.open)} – ${clock12(d.close)}`;
}

function fromStation(station: VendorStation): OperatingSchedule {
  const s = station.operatingSchedule ?? {};
  return Object.fromEntries(SCHEDULE_DAYS.map((day) => [day, { ...DEFAULT_DAY, ...(s[day] ?? {}) }])) as OperatingSchedule;
}

/**
 * The station's opening hours per day, which decide the booking slots
 * customers can pick: open 24 hours, set hours, or closed. Backend: PATCH
 * /vendor-panel/stations/:id/schedule (Station.scheduleAllowsSlot).
 */
export default function SlotTimings({ station }: { station: VendorStation }) {
  const loadStations = useVendorStore((s) => s.loadStations);
  const [draft, setDraft] = useState<OperatingSchedule | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? fromStation(station);

  const setDay = (day: ScheduleDay, next: Partial<DayHours>) =>
    setDraft({ ...value, [day]: { ...value[day], ...next } });
  const setMode = (day: ScheduleDay, mode: Mode) => setDay(day, { is24h: mode === "24h", isClosed: mode === "closed" });
  const applyToAll = (day: ScheduleDay) =>
    setDraft(Object.fromEntries(SCHEDULE_DAYS.map((d) => [d, { ...value[day] }])) as OperatingSchedule);

  const save = async () => {
    for (const day of SCHEDULE_DAYS) {
      const d = value[day];
      if (!d.is24h && !d.isClosed && d.open >= d.close) {
        pushToast(`${day[0].toUpperCase()}${day.slice(1)}: closing time must be after opening time`, "error");
        return;
      }
    }
    setSaving(true);
    try {
      const res = await api.updateStationSchedule(String(station._id), value);
      pushToast(`Slot timings saved (${res.openingHours ?? "updated"})`, "success");
      if (res.outsideHours) {
        pushToast(
          `${res.outsideHours} upcoming booking${res.outsideHours === 1 ? " is" : "s are"} outside the new hours. They are kept; contact or cancel them from Bookings.`,
          "warning",
        );
      }
      setDraft(null);
      await loadStations();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setSaving(false);
    }
  };

  const input = "vm-bg-surface border vm-border rounded-md px-2 py-1 text-xs vm-text";

  return (
    <div className="vm-bg-ground rounded-lg border vm-border p-3 mb-4" data-testid="slot-timings">
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-[10px] vm-text-muted uppercase font-bold">
          <i className="fas fa-clock mr-1" aria-hidden /> Slot timings
        </p>
        {draft && (
          <div className="flex gap-2">
            <button type="button" onClick={() => setDraft(null)} disabled={saving} className="text-[11px] vm-text-muted px-2 py-1">
              Reset
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="vm-accent vm-accent-hover vm-text font-bold px-2.5 py-1 rounded-md text-[11px] disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save timings"}
            </button>
          </div>
        )}
      </div>
      <p className="text-[11px] vm-text-muted mb-3">Customers can book 30-minute slots only while the station is open.</p>
      <div className="space-y-2">
        {SCHEDULE_DAYS.map((day) => {
          const d = value[day];
          const mode = modeOf(d);
          const label = `${day[0].toUpperCase()}${day.slice(1, 3)}`;
          return (
            <div key={day} data-testid={`slot-day-${day}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-bold w-10">{label}</span>
                <select
                  aria-label={`${day} hours`}
                  value={mode}
                  onChange={(e) => setMode(day, e.target.value as Mode)}
                  className={input}
                >
                  <option value="24h">24 hours</option>
                  <option value="hours">Set hours</option>
                  <option value="closed">Closed</option>
                </select>
                {mode === "hours" && (
                  <>
                    <input
                      type="time"
                      step={1800}
                      aria-label={`${day} opening time`}
                      value={d.open}
                      onChange={(e) => setDay(day, { open: e.target.value })}
                      className={input}
                    />
                    <span className="text-[11px] vm-text-muted">to</span>
                    <input
                      type="time"
                      step={1800}
                      aria-label={`${day} closing time`}
                      value={d.close}
                      onChange={(e) => setDay(day, { close: e.target.value })}
                      className={input}
                    />
                  </>
                )}
                <button
                  type="button"
                  onClick={() => applyToAll(day)}
                  className="text-[10px] vm-text-muted underline"
                  title="Use these hours for every day"
                >
                  Apply to all
                </button>
              </div>
              <p className="text-[11px] vm-text-muted mt-0.5 ml-12">{daySummary(d)}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
