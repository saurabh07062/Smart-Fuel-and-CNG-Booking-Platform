import { useVendorStore } from "@/store/vendorStore";
import type { VendorCustomer } from "@/services/api/vendorApi";
import { formatDate, formatINR } from "@/utils/vendorFormat";
import { VendorEmpty } from "../VendorBits";
import DataTable, { type Column } from "@/components/common/DataTable";

// The Reviews tab (renderVendorReviewsTab) is removed for now; ratings and
// reviews are not shown anywhere in the app until they are brought back.

/**
 * Who this vendor's customers are.
 *
 * On a phone the two counts and the date drop: the name and a way to reach
 * them are what this directory is for, and the rest is desk reading.
 */
const CUSTOMER_COLUMNS: Column<VendorCustomer>[] = [
  { key: "name", header: "Customer", cell: (c) => <span className="vm-td-name">{c.user?.name || "Unknown"}</span> },
  {
    key: "contact",
    header: "Contact",
    cell: (c) => (
      <>
        <p className="text-xs">{c.user?.email || ""}</p>
        <p className="text-xs vm-text-muted">{c.user?.phone || ""}</p>
      </>
    ),
  },
  {
    key: "bookings",
    header: "Total Bookings",
    align: "right",
    hideOnPhone: true,
    cell: (c) => c.totalBookings || 0,
  },
  {
    key: "spent",
    header: "Total Spent",
    align: "right",
    cell: (c) => <span className="font-mono text-emerald-400">{formatINR(c.totalSpent || 0)}</span>,
  },
  {
    key: "last",
    header: "Last Visit",
    hideOnPhone: true,
    cell: (c) => <span className="vm-td-sub">{formatDate(c.lastVisit)}</span>,
  },
];

/** Port of renderVendorCustomersTab(). */
export function CustomersTab() {
  const customers = useVendorStore((s) => s.customers);

  return (
    <>
      <h2 className="text-2xl font-bold mb-6">Customer Directory</h2>
      {customers.length === 0 ? (
        <VendorEmpty icon="fa-user-friends" message="No customers yet." />
      ) : (
        <DataTable
          label="Your customers"
          rows={customers}
          rowKey={(c, i) => `${c.user?.email ?? "row"}-${i}`}
          testId="vendor-customers"
          columns={CUSTOMER_COLUMNS}
        />
      )}
    </>
  );
}
