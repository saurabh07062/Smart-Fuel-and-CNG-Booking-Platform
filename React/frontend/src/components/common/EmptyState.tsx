import type { ReactNode } from "react";

interface Props {
  icon?: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

/**
 * Reuses .card/.empty-state/.empty-icon/.empty-title/.empty-sub from
 * css/components.css -- the same markup js/pages/vehicles.js emits for
 * "No vehicles saved yet".
 */
export default function EmptyState({ icon = "fa-inbox", title, subtitle, action }: Props) {
  return (
    <div className="card empty-state">
      <div className="empty-icon">
        <i className={`fas ${icon}`} aria-hidden />
      </div>
      <p className="empty-title">{title}</p>
      {subtitle && <p className="empty-sub">{subtitle}</p>}
      {action && <div className="empty-cta">{action}</div>}
    </div>
  );
}
