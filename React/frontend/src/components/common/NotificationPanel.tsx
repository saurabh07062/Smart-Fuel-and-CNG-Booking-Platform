import { useNotificationStore } from "@/store/notificationStore";

const ICONS: Record<string, string> = {
  booking: "fa-calendar-check",
  payment: "fa-credit-card",
  reminder: "fa-clock",
  offer: "fa-tag",
};

const COLORS: Record<string, string> = {
  booking: "var(--primary)",
  payment: "var(--secondary)",
  reminder: "var(--accent)",
  offer: "var(--danger)",
};

/**
 * The bell panel from renderDashboard().
 *
 * Lifted out of the dashboard because notifications now arrive over the
 * socket on every page, so the panel the bell opens has to exist on every
 * page too -- it lives in Layout beside the header rather than inside one
 * page's markup.
 *
 * An unknown notification type falls back to the booking icon and colour;
 * the Vanilla version indexed its maps directly and rendered `undefined`
 * into the class and the style for any type outside its four.
 */
export default function NotificationPanel() {
  const open = useNotificationStore((s) => s.panelOpen);
  const notifications = useNotificationStore((s) => s.notifications);
  const markAllRead = useNotificationStore((s) => s.markAllRead);

  if (!open) return null;

  return (
    <div className="card p-4 mb-6" style={{ animation: "slideUp .3s ease" }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-bold text-sm">Notifications</h3>
        <button
          className="text-xs font-medium bg-transparent border-0"
          style={{ color: "var(--primary)" }}
          onClick={markAllRead}
        >
          Mark all read
        </button>
      </div>

      <div className="space-y-2 max-h-64 overflow-y-auto">
        {notifications.length === 0 ? (
          <p className="text-xs py-4 text-center" style={{ color: "var(--muted)" }}>
            Nothing yet. Booking updates will appear here.
          </p>
        ) : (
          notifications.map((n) => {
            const icon = ICONS[n.type] ?? ICONS.booking;
            const color = COLORS[n.type] ?? COLORS.booking;
            return (
              <div
                key={n.id}
                className="flex items-start gap-3 p-3 rounded-xl"
                style={{ background: n.read ? "transparent" : "var(--primary-light)" }}
              >
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                  style={{ background: `${color}18` }}
                >
                  <i className={`fas ${icon} text-xs`} style={{ color }} aria-hidden />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{n.title}</p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                    {n.message}
                  </p>
                  <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
                    {n.time}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
