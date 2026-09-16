import type { ManagedVendor } from "@/services/api/adminApi";
import { VendorStatusBadge } from "@/components/console/ConsoleBits";
import { formatDate, formatINRShort, initial, tint } from "@/utils/consoleFormat";

export interface VendorActions {
  onView: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onSuspend: (id: string) => void;
  onReactivate: (id: string) => void;
  onReissue: (id: string) => void;
  onDelete: (id: string) => void;
  onUnderReview: (id: string) => void;
}

/**
 * vmScorePill(). Only pending/under_review applications carry a priority
 * score, so it is only shown for those.
 */
function ScorePill({ v }: { v: ManagedVendor }) {
  const open = v.vendorStatus === "pending" || v.vendorStatus === "under_review";
  if (!open || v.priorityScore == null) return null;
  return <span className="vm-score">{v.priorityScore}</span>;
}

/** Port of vmVendorCard(). */
export default function VendorCard({ v, a }: { v: ManagedVendor; a: VendorActions }) {
  const id = v._id;
  const open = v.vendorStatus === "pending" || v.vendorStatus === "under_review";
  const days = Number.isFinite(v.daysWaiting) ? v.daysWaiting : null;

  const meta = open
    ? `${v.completenessScore ?? 0}% documents ready${days !== null ? ` · waiting ${days}d` : ""}`
    : v.email || "No email";

  return (
    <article className="vm-card">
      <button
        type="button"
        className={`vm-cover t-${tint(id)}`}
        onClick={() => a.onView(id)}
        aria-label={`Open ${v.name || "vendor"}`}
      >
        <span className="vm-cover-initial">{initial(v.name)}</span>
        <span className="vm-cover-status">
          <VendorStatusBadge status={v.vendorStatus} />
        </span>
        {v.vendorCode && <span className="vm-cover-code">{v.vendorCode}</span>}
      </button>

      <div className="vm-card-body" onClick={() => a.onView(id)}>
        <div className="vm-card-top">
          <h3 className="vm-card-name">{v.name || "Unknown"}</h3>
          <ScorePill v={v} />
        </div>
        <p className="vm-card-biz">{v.businessName || "No business name"}</p>
        <p className="vm-card-meta">{meta}</p>
      </div>

      <hr className="vm-card-split" />
      <div className="vm-card-facts">
        <div className="vm-fact">
          <div className="vm-fact-value">{v.stationCount || 0}</div>
          <div className="vm-fact-label">Stations</div>
        </div>
        <div className="vm-fact">
          <div className="vm-fact-value is-money">{formatINRShort(v.totalRevenue || 0)}</div>
          <div className="vm-fact-label">Revenue</div>
        </div>
        <div className="vm-fact">
          <div className="vm-fact-value" style={{ fontSize: "12.5px", fontWeight: 500 }}>
            {formatDate(v.createdAt)}
          </div>
          <div className="vm-fact-label">Joined</div>
        </div>
      </div>

      <div className="vm-card-actions">
        <CardActions v={v} a={a} />
      </div>
    </article>
  );
}

/** The per-status action set from vmVendorCard(). */
function CardActions({ v, a }: { v: ManagedVendor; a: VendorActions }) {
  const id = v._id;

  if (v.vendorStatus === "pending" || v.vendorStatus === "under_review") {
    return (
      <>
        <button type="button" className="vm-btn vm-btn-sm vm-btn-approve" onClick={() => a.onApprove(id)}>
          <i className="fas fa-check" aria-hidden /> Approve
        </button>
        <button type="button" className="vm-btn vm-btn-sm vm-btn-outline-red" onClick={() => a.onReject(id)}>
          <i className="fas fa-xmark" aria-hidden /> Reject
        </button>
        <button type="button" className="vm-icon-btn" onClick={() => a.onView(id)} title="View details" aria-label="View details">
          <i className="fas fa-arrow-right" aria-hidden />
        </button>
      </>
    );
  }

  if (v.vendorStatus === "active") {
    return (
      <>
        <button type="button" className="vm-btn vm-btn-sm vm-btn-ghost" onClick={() => a.onView(id)}>
          <i className="fas fa-eye" aria-hidden /> View
        </button>
        <button
          type="button"
          className="vm-icon-btn"
          onClick={() => a.onReissue(id)}
          title="Email a new secret code"
          aria-label="Email a new secret code"
        >
          <i className="fas fa-key" aria-hidden />
        </button>
        <button type="button" className="vm-btn vm-btn-sm vm-btn-outline-red" onClick={() => a.onSuspend(id)}>
          <i className="fas fa-pause" aria-hidden /> Suspend
        </button>
      </>
    );
  }

  if (v.vendorStatus === "suspended") {
    return (
      <>
        <button type="button" className="vm-btn vm-btn-sm vm-btn-ghost" onClick={() => a.onView(id)}>
          <i className="fas fa-eye" aria-hidden /> View
        </button>
        <button type="button" className="vm-btn vm-btn-sm vm-btn-approve" onClick={() => a.onReactivate(id)}>
          <i className="fas fa-play" aria-hidden /> Reactivate
        </button>
      </>
    );
  }

  return (
    <>
      <button type="button" className="vm-btn vm-btn-sm vm-btn-ghost" onClick={() => a.onView(id)}>
        <i className="fas fa-eye" aria-hidden /> View details
      </button>
      <button
        type="button"
        className="vm-icon-btn is-danger"
        onClick={() => a.onDelete(id)}
        title="Delete vendor"
        aria-label="Delete vendor"
      >
        <i className="fas fa-trash" aria-hidden />
      </button>
    </>
  );
}

/** Port of vmRenderActions() -- the denser per-row set used by the table. */
export function VendorRowActions({ v, a }: { v: ManagedVendor; a: VendorActions }) {
  const id = v._id;
  return (
    <>
      {v.vendorStatus === "pending" && (
        <button type="button" className="vm-icon-btn" onClick={() => a.onUnderReview(id)} title="Mark under review" aria-label="Mark under review">
          <i className="fas fa-magnifying-glass" aria-hidden />
        </button>
      )}
      {(v.vendorStatus === "pending" || v.vendorStatus === "under_review") && (
        <>
          <button type="button" className="vm-icon-btn is-good" onClick={() => a.onApprove(id)} title="Approve" aria-label="Approve">
            <i className="fas fa-check" aria-hidden />
          </button>
          <button type="button" className="vm-icon-btn is-danger" onClick={() => a.onReject(id)} title="Reject" aria-label="Reject">
            <i className="fas fa-xmark" aria-hidden />
          </button>
        </>
      )}
      {v.vendorStatus === "active" && (
        <>
          <button type="button" className="vm-icon-btn" onClick={() => a.onReissue(id)} title="Email a new secret code" aria-label="Email a new secret code">
            <i className="fas fa-key" aria-hidden />
          </button>
          <button type="button" className="vm-icon-btn is-danger" onClick={() => a.onSuspend(id)} title="Suspend" aria-label="Suspend">
            <i className="fas fa-pause" aria-hidden />
          </button>
        </>
      )}
      {v.vendorStatus === "suspended" && (
        <button type="button" className="vm-icon-btn is-good" onClick={() => a.onReactivate(id)} title="Reactivate" aria-label="Reactivate">
          <i className="fas fa-play" aria-hidden />
        </button>
      )}
      <button type="button" className="vm-icon-btn is-danger" onClick={() => a.onDelete(id)} title="Delete" aria-label="Delete">
        <i className="fas fa-trash" aria-hidden />
      </button>
    </>
  );
}
