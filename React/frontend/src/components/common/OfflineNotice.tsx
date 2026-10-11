import { useEffect, useState } from "react";
import { useBackendHealth } from "@/hooks/useBackendHealth";
import { applyServerBase } from "@/services/api/apiClient";
import {
  IS_NATIVE_BUILD,
  normaliseServerBase,
  savedServerBase,
  serverBase,
  setServerBase,
} from "@/services/api/serverAddress";

/**
 * The bar that appears when the app cannot reach FuelMart.
 *
 * The app itself always opens -- its screens live on the device -- so this
 * is about data, and it says which of the two things is wrong:
 *
 *   the phone has no network at all        -> wait for it to come back
 *   the phone is online but FuelMart is not -> the server may be off, or its
 *                                              address may have changed
 *
 * The second case is the one that used to leave people stuck, because the
 * address is a machine on their own Wi-Fi and it changes. So the bar opens
 * onto the field that fixes it, and nothing here is hidden behind a settings
 * page nobody would find.
 *
 * It never blocks the screen: whatever was already loaded stays readable.
 */
export default function OfflineNotice() {
  const { online, reachable, checking, check } = useBackendHealth();
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState(() => savedServerBase() ?? serverBase());
  const [addressError, setAddressError] = useState<string | null>(null);
  /** Hidden until the next time the check fails, so it cannot sit over a button. */
  const [dismissed, setDismissed] = useState(false);

  // A fresh failure is worth saying again, even if the last one was hidden.
  const down = !online || !reachable;
  useEffect(() => {
    if (down) setDismissed(false);
  }, [down]);

  if ((online && reachable) || dismissed) return null;

  const saveAddress = () => {
    const base = normaliseServerBase(address);
    if (!base) {
      setAddressError("Enter an address like 192.168.1.20 or 192.168.1.20:5000");
      return;
    }
    setAddressError(null);
    setServerBase(base);
    applyServerBase();
    setAddress(base);
    setEditing(false);
    void check();
  };

  return (
    <div
      role="status"
      aria-live="polite"
      // At the top, like a system banner: at the bottom it sat over the
      // sheet's own buttons ("Create an account"), which is the worst place
      // to put a message about something not working.
      className="fixed left-0 right-0 z-[1100] px-3"
      style={{ top: "calc(env(safe-area-inset-top) + 10px)" }}
      data-testid="offline-notice"
    >
      <div
        className="mx-auto rounded-2xl border px-4 py-3"
        style={{
          maxWidth: 520,
          background: "var(--card, #111827)",
          borderColor: "var(--border, rgba(255,255,255,.18))",
          boxShadow: "0 12px 30px rgba(0,0,0,.35)",
          animation: "slideUp .25s ease both",
        }}
      >
        <div className="flex items-start gap-3">
          <i
            className={`fas ${online ? "fa-plug-circle-xmark" : "fa-wifi"}`}
            style={{ color: "var(--warning, #f59e0b)", marginTop: 2 }}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-bold" style={{ color: "var(--text)" }}>
              {online ? "Can't reach FuelMart" : "You're offline"}
            </p>
            <p className="text-[11.5px] mt-0.5" style={{ color: "var(--muted)" }}>
              {online
                ? "The app is open, but the server is not answering. Anything already loaded still works."
                : "Bookings and live prices need a connection. They'll update by themselves when it's back."}
            </p>

            {online && IS_NATIVE_BUILD && !editing && (
              <p className="text-[11px] mt-1 truncate" style={{ color: "var(--muted)" }}>
                Server: {serverBase()}
              </p>
            )}

            {editing && (
              <div className="mt-2">
                <label className="block text-[11px] font-semibold mb-1" htmlFor="server-address" style={{ color: "var(--muted)" }}>
                  FuelMart server address
                </label>
                <input
                  id="server-address"
                  className="input-field"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="192.168.1.20:5000"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                />
                {addressError && (
                  <p role="alert" className="text-[11px] mt-1" style={{ color: "var(--danger, #dc2626)" }}>
                    {addressError}
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2 mt-2.5">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => (editing ? saveAddress() : void check())}
                disabled={checking}
              >
                {editing ? "Save & retry" : checking ? "Checking…" : "Retry"}
              </button>
              {online && IS_NATIVE_BUILD && (
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setEditing((v) => !v)}>
                  {editing ? "Cancel" : "Change server"}
                </button>
              )}
              <button
                type="button"
                className="btn btn-outline btn-sm ml-auto"
                onClick={() => setDismissed(true)}
                aria-label="Hide this message"
              >
                Hide
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
