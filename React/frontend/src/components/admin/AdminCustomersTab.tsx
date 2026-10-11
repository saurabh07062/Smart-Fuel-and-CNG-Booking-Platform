import { useEffect, useState } from "react";
import * as api from "@/services/api/adminApi";
import type { AdminCustomer } from "@/services/api/adminApi";
import { toApiError } from "@/services/api/apiClient";
import { formatDate, formatINR } from "@/utils/consoleFormat";
import Money from "@/components/common/Money";
import { ChartCard, DonutChart } from "./charts/Charts";
import DataTable, { type Column } from "@/components/common/DataTable";

/**
 * User management: every registered customer, with what the platform already
 * records about them -- bookings made, completed and cancelled, what they
 * have paid, their vehicles and when they joined.
 *
 * Read-only, and computed by the server (GET /api/v1/admin/customers); this
 * page only shows what comes back. Amounts are masked until the eye is tapped.
 */
export default function AdminCustomersTab() {
  const [data, setData] = useState<{ total: number; customers: AdminCustomer[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .fetchAdminCustomers(query)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(toApiError(err).msg);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const rows = data?.customers ?? [];
  const verified = rows.filter((c) => c.isVerified).length;
  const booked = rows.filter((c) => c.bookings > 0).length;

  return (
    <>
      <div className="grid grid-cols-1 xl:grid-cols-[260px_minmax(0,1fr)] gap-4 mb-4">
        <ChartCard title="Customers" icon="fa-users" testId="customers-summary" note={data ? `${data.total} registered` : null}>
          <DonutChart
            centreLabel="listed"
            ariaLabel="Customers by account state"
            slices={[
              { label: "Verified", value: verified, colour: "#22c55e" },
              { label: "Unverified", value: rows.length - verified, colour: "#f59e0b" },
            ]}
          />
          <p className="text-[11px] vm-text-muted mt-3">
            {booked} of {rows.length} listed customers have booked at least once.
          </p>
        </ChartCard>

        <ChartCard
          title="Registered customers"
          icon="fa-address-book"
          testId="customers-table"
          note={
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setQuery(search);
              }}
            >
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, email or phone"
                aria-label="Search customers"
                className="vm-bg-ground border vm-border rounded-lg px-3 py-1.5 text-xs vm-text w-56"
              />
            </form>
          }
        >
          {error ? (
            <p className="text-[12px] text-red-400" role="alert">
              {error}
            </p>
          ) : data === null ? (
            <p className="text-[11px] vm-text-muted py-6 text-center">Loading customers…</p>
          ) : rows.length === 0 ? (
            <p className="text-[11px] vm-text-muted py-6 text-center">
              {query ? `No customer matches “${query}”.` : "No customers have registered yet."}
            </p>
          ) : (
            <DataTable
              label="Registered customers"
              rows={rows}
              rowKey={(c) => c._id}
              rowTestId={(c) => `customer-row-${c._id}`}
              columns={CUSTOMER_COLUMNS}
            />
          )}
        </ChartCard>
      </div>
    </>
  );
}

/**
 * The customer columns.
 *
 * Who they are and how to reach them stay on a phone; the four counts and
 * the two dates are the comparison you come to a desk for. "Spent" keeps its
 * `Money` wrapper — it is the one figure here that is money, and it reads
 * differently from a count of bookings.
 */
const CUSTOMER_COLUMNS: Column<AdminCustomer>[] = [
  {
    key: "customer",
    header: "Customer",
    cell: (c) => (
      <>
        <p className="font-bold vm-text truncate max-w-[170px]">{c.name}</p>
        <p className="vm-text-muted">
          {c.isVerified ? "Verified" : "Not verified"}
          {c.vehicles > 0 ? ` · ${c.vehicles} vehicle${c.vehicles === 1 ? "" : "s"}` : ""}
        </p>
      </>
    ),
  },
  {
    key: "contact",
    header: "Contact",
    cell: (c) => (
      <div className="vm-text-muted">
        <p className="truncate max-w-[190px]">{c.email}</p>
        <p>{c.phone || "—"}</p>
      </div>
    ),
  },
  { key: "bookings", header: "Bookings", align: "right", cell: (c) => <span className="font-bold">{c.bookings}</span> },
  {
    key: "completed",
    header: "Completed",
    align: "right",
    hideOnPhone: true,
    cell: (c) => <span className="text-emerald-400">{c.completed}</span>,
  },
  {
    key: "cancelled",
    header: "Cancelled",
    align: "right",
    hideOnPhone: true,
    cell: (c) => <span className="text-orange-400">{c.cancelled}</span>,
  },
  {
    key: "spent",
    header: "Spent",
    align: "right",
    cell: (c) => <Money label={`amount paid by ${c.name}`}>{formatINR(c.spent)}</Money>,
  },
  {
    key: "last",
    header: "Last booking",
    hideOnPhone: true,
    cell: (c) => (
      <span className="vm-text-muted whitespace-nowrap">{c.lastBookingAt ? formatDate(c.lastBookingAt) : "—"}</span>
    ),
  },
  {
    key: "joined",
    header: "Joined",
    hideOnPhone: true,
    cell: (c) => <span className="vm-text-muted whitespace-nowrap">{formatDate(c.joinedAt)}</span>,
  },
];
