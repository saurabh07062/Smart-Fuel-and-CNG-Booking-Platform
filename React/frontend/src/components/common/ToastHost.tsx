import { useToastStore } from "@/store/toastStore";

const ICONS: Record<string, string> = {
  success: "fa-check-circle",
  error: "fa-exclamation-circle",
  info: "fa-info-circle",
  warning: "fa-exclamation-triangle",
};

/**
 * Renders the toast stack. Mounted once at the App root.
 * Uses the existing .toast / .toast-<type> classes, so the look and the
 * slide-in are identical to the Vanilla implementation.
 */
export default function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div id="toast-container">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.type}`}
          role="status"
          onClick={() => dismiss(t.id)}
        >
          <i className={`fas ${ICONS[t.type]}`} aria-hidden />
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
