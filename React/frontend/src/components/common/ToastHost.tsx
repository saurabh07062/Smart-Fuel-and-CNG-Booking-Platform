import { useEffect, useRef, useState } from "react";
import { TOAST_MS, useToastStore } from "@/store/toastStore";

const ICONS: Record<string, string> = {
  success: "fa-check-circle",
  error: "fa-exclamation-circle",
  info: "fa-info-circle",
  warning: "fa-exclamation-triangle",
};

/** Sideways drag, in px, that dismisses a toast. */
const SWIPE_PX = 60;

/**
 * Shows the toast queue one at a time: the first toast stays for TOAST_MS,
 * then the next appears. Tap or swipe sideways to dismiss it early.
 * Mounted once at the App root; uses the existing .toast / .toast-<type> classes.
 */
export default function ToastHost() {
  const current = useToastStore((s) => s.toasts[0]);
  const dismiss = useToastStore((s) => s.dismiss);
  const [dx, setDx] = useState(0);
  const startX = useRef<number | null>(null);

  // Each toast gets its own full display time once it is the one on screen.
  useEffect(() => {
    if (!current) return;
    setDx(0);
    const timer = setTimeout(() => dismiss(current.id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [current, dismiss]);

  return (
    <div id="toast-container" aria-live="polite">
      {current && (
        <div
          key={current.id}
          className={`toast toast-${current.type}`}
          role="status"
          style={dx ? { transform: `translateX(${dx}px)`, opacity: Math.max(0.2, 1 - Math.abs(dx) / 160) } : undefined}
          onClick={() => dismiss(current.id)}
          onPointerDown={(e) => {
            startX.current = e.clientX;
          }}
          onPointerMove={(e) => {
            if (startX.current != null) setDx(e.clientX - startX.current);
          }}
          onPointerUp={() => {
            if (Math.abs(dx) > SWIPE_PX) dismiss(current.id);
            else setDx(0);
            startX.current = null;
          }}
          onPointerCancel={() => {
            setDx(0);
            startX.current = null;
          }}
        >
          <i className={`fas ${ICONS[current.type]}`} aria-hidden />
          <span>{current.message}</span>
        </div>
      )}
    </div>
  );
}
