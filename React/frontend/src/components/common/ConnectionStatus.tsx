import { useRealtimeStore } from "@/store/realtimeStore";

/**
 * The "Reconnecting…" chip.
 *
 * Shown only while actually disconnected AND only after the first successful
 * connection -- telling someone we are "reconnecting" on a machine that never
 * connected would be a lie. Reuses the .rt-status classes already defined in
 * css/components.css, so it looks identical to the Vanilla version.
 */
export default function ConnectionStatus() {
  const connected = useRealtimeStore((s) => s.connected);
  const everConnected = useRealtimeStore((s) => s.everConnected);

  if (connected || !everConnected) return null;

  return (
    <div className="rt-status" role="status" aria-live="polite">
      <span className="rt-status-dot" />
      Reconnecting…
    </div>
  );
}
