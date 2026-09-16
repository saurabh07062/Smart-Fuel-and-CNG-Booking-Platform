import type { VendorDetail as VendorDetailData } from "@/services/api/adminApi";
import { VendorStatusBadge } from "@/components/console/ConsoleBits";
import { VendorRowActions, type VendorActions } from "./VendorCard";
import { formatDate, formatINR, initial, tint } from "@/utils/consoleFormat";

/** Port of vmRenderDetail(), vmRenderStations() and vmRenderBookings(). */
export default function VendorDetail({
  vendor,
  actions,
  busy,
  onBack,
}: {
  vendor: VendorDetailData;
  actions: VendorActions;
  busy?: boolean;
  onBack: () => void;
}) {
  const open = vendor.vendorStatus === "pending" || vendor.vendorStatus === "under_review";

  const facts: Array<[string, string | undefined]> = [
    ["Email", vendor.email],
    ["Phone", vendor.phone],
    ["Vendor Code", vendor.vendorCode],
    ["GST Number", vendor.gstNumber],
    ["Joined", formatDate(vendor.createdAt)],
    ["Address", vendor.vendorAddress],
  ];

  if (open) {
    facts.push([
      "Application Readiness",
      `${vendor.completenessScore ?? 0}% complete · priority ${vendor.priorityScore ?? 0} · waiting ${
        vendor.daysWaiting ?? 0
      }d`,
    ]);
  }
  if (vendor.vendorDescription) facts.push(["Description", vendor.vendorDescription]);

  const stations = vendor.stations ?? [];
  const bookings = vendor.bookings ?? [];

  return (
    <>
      <button type="button" className="vm-link" onClick={onBack} style={{ marginBottom: 16 }}>
        <i className="fas fa-arrow-left" aria-hidden /> Back to list
      </button>

      <div className="vm-panel">
        <div className="vm-panel-body is-padded">
          <div style={{ display: "flex", alignItems: "flex-start", gap: 18, flexWrap: "wrap" }}>
            <span className={`vm-row-avatar t-${tint(vendor._id)}`} style={{ width: 64, height: 64, fontSize: 26 }}>
              {initial(vendor.name)}
            </span>
            <div style={{ flex: 1, minWidth: 220 }}>
              <h2 className="vm-panel-title" style={{ fontSize: 20 }}>
                {vendor.name || "Unknown"}
              </h2>
              <p className="vm-subtitle">{vendor.businessName || "No business name"}</p>
              <div style={{ marginTop: 8 }}>
                <VendorStatusBadge status={vendor.vendorStatus} />
              </div>
            </div>
            <div className="vm-td-actions" style={{ opacity: busy ? 0.5 : 1 }}>
              <VendorRowActions v={vendor} a={actions} />
            </div>
          </div>

          {vendor.rejectionReason && (
            <p
              className="vm-empty-inline"
              style={{ color: "var(--z-red)", marginTop: 14 }}
            >
              {vendor.rejectionReason}
            </p>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
              gap: 14,
              marginTop: 20,
            }}
          >
            {facts.map(([label, value]) => (
              <div key={label}>
                <div className="vm-fact-label">{label}</div>
                <div className="vm-td-name" style={{ wordBreak: "break-word" }}>
                  {value || "N/A"}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="vm-panel">
        <div className="vm-panel-head">
          <h3 className="vm-panel-title">
            <i className="fas fa-gas-pump" aria-hidden /> Stations
          </h3>
          <span className="vm-subtitle">{stations.length}</span>
        </div>
        <div className="vm-panel-body">
          {stations.length === 0 ? (
            <p className="vm-empty-inline">This vendor has no stations yet</p>
          ) : (
            <div className="vm-rows">
              {stations.map((s) => {
                const prices = (s.prices ?? {}) as Record<string, number | undefined>;
                return (
                  <div className="vm-row" style={{ cursor: "default" }} key={String(s._id)}>
                    <span className="vm-row-avatar">
                      <i className="fas fa-gas-pump" aria-hidden />
                    </span>
                    <div className="vm-row-main">
                      <div className="vm-row-name">{s.name}</div>
                      <div className="vm-row-sub">{s.address || "No address"}</div>
                    </div>
                    <div className="vm-row-right">
                      <div className="vm-row-value">₹{prices.petrol ?? "-"}</div>
                      <div className="vm-row-meta">{s.status || "Active"}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="vm-panel">
        <div className="vm-panel-head">
          <h3 className="vm-panel-title">
            <i className="fas fa-calendar-check" aria-hidden /> Recent bookings
          </h3>
          <span className="vm-subtitle">{bookings.length}</span>
        </div>
        <div className="vm-panel-body">
          {bookings.length === 0 ? (
            <p className="vm-empty-inline">No bookings for this vendor yet</p>
          ) : (
            <div className="vm-rows">
              {bookings.slice(0, 10).map((raw, i) => {
                const b = raw as {
                  _id?: string;
                  fuelType?: string;
                  quantity?: number;
                  amount?: number;
                  status?: string;
                  bookingDate?: string;
                };
                return (
                  <div className="vm-row" style={{ cursor: "default" }} key={b._id ?? i}>
                    <span className="vm-row-avatar">
                      <i className="fas fa-receipt" aria-hidden />
                    </span>
                    <div className="vm-row-main">
                      <div className="vm-row-name">
                        {b.fuelType || "Fuel"} · {b.quantity ?? 0}L
                      </div>
                      <div className="vm-row-sub">
                        {b.bookingDate || "—"} · {b.status || "unknown"}
                      </div>
                    </div>
                    <div className="vm-row-right">
                      <div className="vm-row-value">{formatINR(b.amount ?? 0)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
