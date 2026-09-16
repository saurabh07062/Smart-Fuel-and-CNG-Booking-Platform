import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as api from "@/services/api/adminApi";
import ConsoleShell, { type ConsoleTab } from "@/components/console/ConsoleShell";
import {
  ConsoleEmpty,
  ConsoleLoading,
  ConsolePanel,
  ConsoleStat,
  VendorStatusBadge,
} from "@/components/console/ConsoleBits";
import VendorCard, { VendorRowActions, type VendorActions } from "@/components/admin/VendorCard";
import VendorDetail from "@/components/admin/VendorDetail";
import {
  filterForTab,
  filterVendors,
  useVendorMgmtStore,
  type VmTab,
} from "@/store/vendorMgmtStore";
import { pushToast } from "@/store/toastStore";
import { toApiError } from "@/services/api/apiClient";
import { useSocketEvent } from "@/hooks/useSocket";
import { SOCKET_EVENTS } from "@/services/socket/socketEvents";
import { formatDate, formatINR, formatINRShort, initial } from "@/utils/consoleFormat";

/** VM_TABS. */
const TABS: ConsoleTab<VmTab>[] = [
  { id: "dashboard", icon: "fa-chart-simple", label: "Dashboard" },
  { id: "vendors", icon: "fa-store", label: "All Vendors" },
  { id: "pending", icon: "fa-clock", label: "Pending Approvals" },
  { id: "active", icon: "fa-circle-check", label: "Active Vendors" },
  { id: "suspended", icon: "fa-pause", label: "Suspended" },
  { id: "rejected", icon: "fa-circle-xmark", label: "Rejected" },
  { id: "revenue", icon: "fa-indian-rupee-sign", label: "Revenue" },
  { id: "stations", icon: "fa-gas-pump", label: "Stations" },
];

/** VM_TAB_COPY. */
const COPY: Record<VmTab, [string, string]> = {
  dashboard: ["Vendor Management", "Every fuel station owner on FuelMart, at a glance"],
  vendors: ["All Vendors", "Browse, search and act on every registered owner"],
  pending: ["Pending Approvals", "Highest priority first — the ones ready to decide"],
  active: ["Active Vendors", "Owners currently running stations on the platform"],
  suspended: ["Suspended", "Temporarily taken offline, with their stations"],
  rejected: ["Rejected", "Applications that were turned down"],
  revenue: ["Revenue", "What vendors are earning across the network"],
  stations: ["Stations", "Station footprint across every vendor"],
};

/**
 * Port of renderVendorManagementPage() and the vm* action functions.
 *
 * REAL-TIME: an admin sits in the `admin` room, so vendor:statusChanged
 * arrives here whenever any vendor's state moves -- the Vanilla app already
 * bound that event to a vmLoadDashboard() refresh, and that behaviour is
 * kept.
 */
export default function VendorManagement() {
  const navigate = useNavigate();

  const tab = useVendorMgmtStore((s) => s.tab);
  const setTab = useVendorMgmtStore((s) => s.setTab);
  const loading = useVendorMgmtStore((s) => s.loading);
  const error = useVendorMgmtStore((s) => s.error);
  const stats = useVendorMgmtStore((s) => s.stats);
  const vendors = useVendorMgmtStore((s) => s.vendors);
  const filter = useVendorMgmtStore((s) => s.filter);
  const search = useVendorMgmtStore((s) => s.search);
  const listView = useVendorMgmtStore((s) => s.listView);
  const selected = useVendorMgmtStore((s) => s.selectedVendor);
  const load = useVendorMgmtStore((s) => s.load);
  const setFilter = useVendorMgmtStore((s) => s.setFilter);
  const setSearch = useVendorMgmtStore((s) => s.setSearch);
  const setListView = useVendorMgmtStore((s) => s.setListView);
  const viewDetail = useVendorMgmtStore((s) => s.viewDetail);
  const backToList = useVendorMgmtStore((s) => s.backToList);
  const reset = useVendorMgmtStore((s) => s.reset);

  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  useSocketEvent(SOCKET_EVENTS.VENDOR_STATUS_CHANGED, () => void load(), [load]);
  useSocketEvent(SOCKET_EVENTS.VENDOR_APPROVED, () => void load(), [load]);

  /** Runs an action, reports its message, and refreshes the list. */
  const run = async (fn: () => Promise<{ msg?: string }>, fallback: string) => {
    setBusy(true);
    try {
      const r = await fn();
      pushToast(r.msg || fallback, "success");
      await load();
      return r;
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const actions: VendorActions = {
    onView: (id) => void viewDetail(id),

    onApprove: async (id) => {
      if (!window.confirm("Are you sure you want to approve this vendor?")) return;
      const r = (await run(() => api.approveVendor(id), "Vendor approved successfully")) as
        | { secretCodeEmailed?: boolean }
        | null;
      // The secret code is deliberately NOT in the response and must never be
      // shown here -- only the vendor's inbox ever holds it. When the email
      // fails, the recovery path is "Reissue secret code", which sends a fresh
      // one and revokes the old, rather than revealing anything.
      if (r && r.secretCodeEmailed === false) {
        window.alert(
          "Vendor approved, but the secret code email could not be sent.\n\n" +
            "They cannot open their dashboard until they receive it. Fix the mail " +
            "configuration, then use the Reissue secret code action on this vendor.",
        );
      }
    },

    onReissue: (id) => {
      const ok = window.confirm(
        "Email this vendor a new secret code?" +
          "\n\nAny code they already have will stop working, and they will have to " +
          "verify again before their dashboard opens.",
      );
      if (!ok) return;
      void run(() => api.reissueSecretCode(id), "New secret code sent");
    },

    onUnderReview: (id) => {
      if (!window.confirm("Mark this application as under review?")) return;
      void run(() => api.markVendorUnderReview(id), "Vendor marked as under review");
    },

    onReject: (id) => {
      const reason = window.prompt("Enter rejection reason (optional):", "Application rejected by admin");
      if (reason === null) return;
      void run(() => api.rejectVendor(id, reason), "Vendor rejected successfully");
    },

    onSuspend: (id) => {
      const reason = window.prompt("Enter suspension reason (optional):", "Suspended by admin");
      if (reason === null) return;
      void run(() => api.suspendVendor(id, reason), "Vendor suspended successfully");
    },

    onReactivate: (id) => {
      if (!window.confirm("Are you sure you want to reactivate this vendor?")) return;
      void run(() => api.reactivateVendor(id), "Vendor reactivated successfully");
    },

    onDelete: async (id) => {
      const ok = window.confirm(
        "WARNING: This will permanently delete the vendor and all their stations. This action cannot be undone. Continue?",
      );
      if (!ok) return;
      const r = await run(() => api.deleteVendor(id), "Vendor deleted successfully");
      if (r) backToList();
    },
  };

  // A dedicated status tab pins its own filter; only "All Vendors" lets the
  // chips drive it, so a chip can never contradict the tab it sits under.
  const pinned = filterForTab(tab);
  const effectiveFilter = pinned === "all" ? filter : pinned;
  const visible = useMemo(
    () => filterVendors(vendors, effectiveFilter, search),
    [vendors, effectiveFilter, search],
  );

  const body = () => {
    if (loading && !stats) return <ConsoleLoading label="Loading vendors..." />;

    if (error) {
      return (
        <ConsoleEmpty
          icon="fa-plug-circle-exclamation"
          title="Could not load vendor data"
          text={error}
          action={
            <button type="button" className="vm-btn vm-btn-primary" onClick={() => void load()}>
              <i className="fas fa-rotate" aria-hidden /> Try again
            </button>
          }
        />
      );
    }

    if (selected) {
      return <VendorDetail vendor={selected} actions={actions} busy={busy} onBack={backToList} />;
    }

    if (tab === "dashboard") return <Dashboard />;
    if (tab === "revenue") return <RevenueSection />;
    if (tab === "stations") return <StationsSection />;

    return <VendorList />;
  };

  function Dashboard() {
    if (!stats) return <ConsoleLoading />;

    const open = vendors
      .filter((v) => v.vendorStatus === "pending" || v.vendorStatus === "under_review")
      .sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0))
      .slice(0, 3);

    const monthly = stats.monthlyEarnings ?? [];
    const maxRevenue = Math.max(...monthly.map((m) => m.revenue), 1);
    const top = (stats.topPerformingVendors ?? []).slice(0, 5);
    const recent = (stats.recentRegistrations ?? []).slice(0, 5);

    return (
      <>
        <div className="vm-stats">
          <ConsoleStat label="Total Vendors" value={stats.totalVendors} icon="fa-store" tone="red" />
          <ConsoleStat label="Active" value={stats.activeVendors} icon="fa-circle-check" tone="green" />
          <ConsoleStat label="Awaiting Approval" value={stats.pendingApprovals} icon="fa-clock" tone="amber" />
          <ConsoleStat label="Suspended" value={stats.suspendedVendors} icon="fa-pause" tone="slate" />
        </div>
        <div className="vm-stats">
          <ConsoleStat label="Rejected" value={stats.rejectedVendors} icon="fa-circle-xmark" tone="red" />
          <ConsoleStat label="Stations Live" value={stats.totalStations} icon="fa-gas-pump" tone="blue" />
          <ConsoleStat label="Total Bookings" value={stats.totalBookings} icon="fa-calendar-check" tone="blue" />
          <ConsoleStat
            label="Network Revenue"
            value={formatINRShort(stats.totalVendorRevenue)}
            icon="fa-indian-rupee-sign"
            tone="green"
          />
        </div>

        {stats.pendingApprovals > 0 && (
          <ConsolePanel
            title="Needs your decision"
            icon="fa-bolt"
            action={
              <button type="button" className="vm-link" onClick={() => setTab("pending")}>
                See all {stats.pendingApprovals} <i className="fas fa-arrow-right" aria-hidden />
              </button>
            }
          >
            {open.length === 0 ? (
              <p className="vm-empty-inline">Nothing waiting — every application has been decided.</p>
            ) : (
              <div className="vm-grid">
                {open.map((v) => (
                  <VendorCard key={v._id} v={v} a={actions} />
                ))}
              </div>
            )}
          </ConsolePanel>
        )}

        <ConsolePanel
          title="Monthly earnings"
          icon="fa-chart-column"
          action={<span className="vm-subtitle">Current year</span>}
        >
          {monthly.length === 0 ? (
            <p className="vm-empty-inline">No earnings recorded yet</p>
          ) : (
            <div className="vm-bars">
              {monthly.map((m) => (
                <div className="vm-bar-col" key={m.month}>
                  <div className="vm-bar-track">
                    <div
                      className="vm-bar"
                      style={{ height: `${Math.max((m.revenue / maxRevenue) * 100, 2)}%` }}
                    >
                      <span className="vm-bar-value">{formatINR(m.revenue)}</span>
                    </div>
                  </div>
                  <span className="vm-bar-label">{String(m.month).substring(0, 3)}</span>
                </div>
              ))}
            </div>
          )}
        </ConsolePanel>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(330px,1fr))", gap: 20 }}>
          <ConsolePanel title="Top performers" icon="fa-trophy" padded={false}>
            {top.length === 0 ? (
              <p className="vm-empty-inline">No revenue recorded yet</p>
            ) : (
              <div className="vm-rows">
                {top.map((v, i) => (
                  <div className="vm-row" style={{ cursor: "default" }} key={`${v.vendorName}-${i}`}>
                    <span className={`vm-row-avatar ${i < 3 ? "is-rank" : ""}`}>{i + 1}</span>
                    <div className="vm-row-main">
                      <div className="vm-row-name">{v.vendorName || "Unknown"}</div>
                      <div className="vm-row-sub">
                        {v.businessName || v.stationName || "No business name"}
                      </div>
                    </div>
                    <div className="vm-row-right">
                      <div className="vm-row-value">{formatINR(v.revenue)}</div>
                      <div className="vm-row-meta">{v.bookings || 0} bookings</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ConsolePanel>

          <ConsolePanel
            title="Just registered"
            icon="fa-user-plus"
            padded={false}
            action={
              <button type="button" className="vm-link" onClick={() => setTab("vendors")}>
                All vendors <i className="fas fa-arrow-right" aria-hidden />
              </button>
            }
          >
            {recent.length === 0 ? (
              <p className="vm-empty-inline">No recent registrations</p>
            ) : (
              <div className="vm-rows">
                {recent.map((v) => (
                  <button type="button" className="vm-row" key={v._id} onClick={() => void viewDetail(v._id)}>
                    <span className="vm-row-avatar">{initial(v.name)}</span>
                    <div className="vm-row-main">
                      <div className="vm-row-name">{v.name || "Unknown"}</div>
                      <div className="vm-row-sub">
                        {v.businessName || "No business name"} · {formatDate(v.createdAt)}
                      </div>
                    </div>
                    <div className="vm-row-right">
                      <VendorStatusBadge status={v.vendorStatus} />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </ConsolePanel>
        </div>
      </>
    );
  }

  function VendorList() {
    const chips: Array<[typeof filter, string]> = [
      ["all", "All"],
      ["pending", "Pending"],
      ["active", "Active"],
      ["suspended", "Suspended"],
      ["rejected", "Rejected"],
    ];

    return (
      <>
        <div className="vm-toolbar">
          <div className="vm-search">
            <i className="fas fa-search" aria-hidden />
            <input
              type="text"
              placeholder="Search name, business, email or code…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search vendors"
            />
          </div>

          {pinned === "all" && (
            <div className="vm-chips">
              {chips.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`vm-chip ${filter === value ? "is-active" : ""}`}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          <div className="vm-viewtoggle">
            <button
              type="button"
              className={`vm-icon-btn ${listView === "grid" ? "is-active" : ""}`}
              onClick={() => setListView("grid")}
              title="Card view"
              aria-label="Card view"
            >
              <i className="fas fa-table-cells-large" aria-hidden />
            </button>
            <button
              type="button"
              className={`vm-icon-btn ${listView === "table" ? "is-active" : ""}`}
              onClick={() => setListView("table")}
              title="Table view"
              aria-label="Table view"
            >
              <i className="fas fa-list" aria-hidden />
            </button>
          </div>
        </div>

        {visible.length === 0 ? (
          <ConsoleEmpty
            icon="fa-store-slash"
            title="No vendors here"
            text={search ? "Nothing matches that search." : "Nothing in this category yet."}
          />
        ) : listView === "grid" ? (
          <div className="vm-grid">
            {visible.map((v) => (
              <VendorCard key={v._id} v={v} a={actions} />
            ))}
          </div>
        ) : (
          <table className="vm-table">
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Business</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Stations</th>
                <th>Revenue</th>
                <th>Joined</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((v) => (
                <tr key={v._id}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                      <span className="vm-row-avatar" style={{ width: 34, height: 34, fontSize: 13 }}>
                        {initial(v.name)}
                      </span>
                      <div>
                        <div className="vm-td-name">{v.name || "Unknown"}</div>
                        <div className="vm-td-sub">{v.email || ""}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div>{v.businessName || "N/A"}</div>
                    <div className="vm-td-sub">{v.vendorCode || v.gstNumber || ""}</div>
                  </td>
                  <td>
                    <VendorStatusBadge status={v.vendorStatus} />
                  </td>
                  <td>{v.priorityScore ?? "—"}</td>
                  <td className="vm-num">{v.stationCount || 0}</td>
                  <td className="vm-money">{formatINR(v.totalRevenue || 0)}</td>
                  <td className="vm-td-sub">{formatDate(v.createdAt)}</td>
                  <td>
                    <div className="vm-td-actions">
                      <button
                        type="button"
                        className="vm-icon-btn"
                        onClick={() => void viewDetail(v._id)}
                        title="View details"
                        aria-label="View details"
                      >
                        <i className="fas fa-eye" aria-hidden />
                      </button>
                      <VendorRowActions v={v} a={actions} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    );
  }

  function RevenueSection() {
    const ranked = [...vendors].sort((a, b) => (b.totalRevenue || 0) - (a.totalRevenue || 0));
    return (
      <ConsolePanel title="Revenue by vendor" icon="fa-indian-rupee-sign" padded={false}>
        {ranked.length === 0 ? (
          <p className="vm-empty-inline">No revenue recorded yet</p>
        ) : (
          <div className="vm-rows">
            {ranked.map((v, i) => (
              <button type="button" className="vm-row" key={v._id} onClick={() => void viewDetail(v._id)}>
                <span className={`vm-row-avatar ${i < 3 ? "is-rank" : ""}`}>{i + 1}</span>
                <div className="vm-row-main">
                  <div className="vm-row-name">{v.name || "Unknown"}</div>
                  <div className="vm-row-sub">{v.businessName || "No business name"}</div>
                </div>
                <div className="vm-row-right">
                  <div className="vm-row-value">{formatINR(v.totalRevenue || 0)}</div>
                  <div className="vm-row-meta">{v.stationCount || 0} stations</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </ConsolePanel>
    );
  }

  function StationsSection() {
    const withStations = vendors.filter((v) => (v.stationCount || 0) > 0);
    return (
      <ConsolePanel title="Station footprint" icon="fa-gas-pump" padded={false}>
        {withStations.length === 0 ? (
          <p className="vm-empty-inline">No vendor has a station yet</p>
        ) : (
          <div className="vm-rows">
            {withStations.map((v) => (
              <button type="button" className="vm-row" key={v._id} onClick={() => void viewDetail(v._id)}>
                <span className="vm-row-avatar">{initial(v.name)}</span>
                <div className="vm-row-main">
                  <div className="vm-row-name">{v.businessName || v.name || "Unknown"}</div>
                  <div className="vm-row-sub">
                    <VendorStatusBadge status={v.vendorStatus} />
                  </div>
                </div>
                <div className="vm-row-right">
                  <div className="vm-row-value">{v.stationCount}</div>
                  <div className="vm-row-meta">stations</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </ConsolePanel>
    );
  }

  const [title, subtitle] = COPY[tab];

  return (
    <ConsoleShell
      logoIcon="fa-store"
      logoName="Vendor Management"
      logoSub="Admin Console"
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      title={title}
      subtitle={subtitle}
      onRefresh={() => void load()}
      onBeforeLogout={reset}
      railExtra={
        <button
          type="button"
          className="vm-nav-item"
          onClick={() => navigate("/admin")}
          style={{
            marginTop: 8,
            borderTop: "1px solid var(--z-line)",
            paddingTop: 14,
            borderRadius: "0 0 10px 10px",
          }}
        >
          <i className="fas fa-user-shield" aria-hidden />
          <span>Admin Panel</span>
        </button>
      }
    >
      {body()}
    </ConsoleShell>
  );
}
