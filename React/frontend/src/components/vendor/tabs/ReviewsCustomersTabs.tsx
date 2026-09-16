import { useVendorStore } from "@/store/vendorStore";
import { formatDate, formatINR } from "@/utils/vendorFormat";
import { VendorEmpty } from "../VendorBits";

// The Reviews tab (renderVendorReviewsTab) is removed for now; ratings and
// reviews are not shown anywhere in the app until they are brought back.

/** Port of renderVendorCustomersTab(). */
export function CustomersTab() {
  const customers = useVendorStore((s) => s.customers);

  return (
    <>
      <h2 className="text-2xl font-bold mb-6">Customer Directory</h2>
      {customers.length === 0 ? (
        <VendorEmpty icon="fa-user-friends" message="No customers yet." />
      ) : (
        <div className="vm-bg-surface rounded-2xl border vm-border overflow-hidden">
          <div className="w-full overflow-x-auto">
            <table className="vm-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Contact</th>
                  <th>Total Bookings</th>
                  <th>Total Spent</th>
                  <th>Last Visit</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c, i) => (
                  <tr key={`${c.user?.email ?? "row"}-${i}`}>
                    <td className="vm-td-name">{c.user?.name || "Unknown"}</td>
                    <td>
                      <p className="text-xs">{c.user?.email || ""}</p>
                      <p className="text-xs vm-text-muted">{c.user?.phone || ""}</p>
                    </td>
                    <td className="vm-num">{c.totalBookings || 0}</td>
                    <td className="px-6 py-4 font-mono text-emerald-400">{formatINR(c.totalSpent || 0)}</td>
                    <td className="vm-td-sub">{formatDate(c.lastVisit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
