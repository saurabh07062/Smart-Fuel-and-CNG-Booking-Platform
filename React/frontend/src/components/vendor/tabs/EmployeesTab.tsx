import { useState } from "react";
import * as api from "@/services/api/vendorApi";
import { useVendorStore } from "@/store/vendorStore";
import { pushToast } from "@/store/toastStore";
import { toApiError } from "@/services/api/apiClient";
import { formatINR } from "@/utils/vendorFormat";
import { VendorEmpty, VendorHeading } from "../VendorBits";

const EMPTY = { name: "", phone: "", email: "", role: "Attendant", shift: "Full-Time", salary: "0", station: "" };

/** Port of renderVendorEmployeesTab() + addVendorEmployee()/deleteVendorEmployee(). */
export default function EmployeesTab() {
  const employees = useVendorStore((s) => s.employees);
  const stations = useVendorStore((s) => s.stations);
  const loadTab = useVendorStore((s) => s.loadTab);

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof EMPTY, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const add = async () => {
    if (!form.name || !form.phone) {
      pushToast("Name and phone are required", "error");
      return;
    }
    setBusy(true);
    try {
      const r = await api.addVendorEmployee({
        name: form.name,
        phone: form.phone,
        email: form.email || undefined,
        role: form.role,
        shift: form.shift,
        salary: Number(form.salary) || 0,
        station: form.station || undefined,
      });
      pushToast(r.msg || "Employee added", "success");
      setForm(EMPTY);
      setShowAdd(false);
      await loadTab("employees");
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Remove this employee?")) return;
    try {
      const r = await api.deleteVendorEmployee(id);
      pushToast(r.msg || "Employee removed", "success");
      await loadTab("employees");
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    }
  };

  return (
    <>
      <VendorHeading
        title="Employee Management"
        action={
          <button
            onClick={() => setShowAdd((v) => !v)}
            className="vm-accent vm-accent-hover vm-text font-bold py-2.5 px-4 rounded-lg transition-colors text-sm flex items-center gap-2"
          >
            <i className="fas fa-plus" aria-hidden /> Add Employee
          </button>
        }
      />

      {showAdd && (
        <div className="vm-bg-surface rounded-2xl border vm-border p-6 mb-6">
          <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
            <i className="fas fa-user-plus vm-accent-text" aria-hidden /> Add New Employee
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Name *">
              <input className="w-full vm-input px-4 py-2.5 text-sm vm-text" value={form.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field label="Phone *">
              <input className="w-full vm-input px-4 py-2.5 text-sm vm-text" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
            </Field>
            <Field label="Email">
              <input type="email" className="w-full vm-input px-4 py-2.5 text-sm vm-text" value={form.email} onChange={(e) => set("email", e.target.value)} />
            </Field>
            <Field label="Role">
              <select className="w-full vm-input px-4 py-2.5 text-sm vm-text" value={form.role} onChange={(e) => set("role", e.target.value)}>
                {["Attendant", "Manager", "Cashier", "Security"].map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </Field>
            <Field label="Shift">
              <select className="w-full vm-input px-4 py-2.5 text-sm vm-text" value={form.shift} onChange={(e) => set("shift", e.target.value)}>
                {["Full-Time", "Morning", "Evening", "Night"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label="Salary (₹)">
              <input type="number" className="w-full vm-input px-4 py-2.5 text-sm vm-text" value={form.salary} onChange={(e) => set("salary", e.target.value)} />
            </Field>
            <div className="col-span-2">
              <Field label="Assign to Station">
                <select className="w-full vm-input px-4 py-2.5 text-sm vm-text" value={form.station} onChange={(e) => set("station", e.target.value)}>
                  <option value="">-- Select Station --</option>
                  {stations.map((s) => (
                    <option key={String(s._id)} value={String(s._id)}>{s.name}</option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button onClick={() => setShowAdd(false)} className="vm-bg-ground vm-hover border vm-border vm-text font-bold py-2.5 px-4 rounded-lg transition-colors text-sm">
              Cancel
            </button>
            <button onClick={add} disabled={busy} className="vm-accent vm-accent-hover vm-text font-bold py-2.5 px-4 rounded-lg transition-colors text-sm flex items-center gap-2">
              <i className="fas fa-save" aria-hidden /> {busy ? "Saving…" : "Add Employee"}
            </button>
          </div>
        </div>
      )}

      {employees.length === 0 ? (
        <VendorEmpty
          icon="fa-users"
          title="No Employees"
          message="You haven't added any employees yet."
          action={
            <button onClick={() => setShowAdd(true)} className="vm-btn vm-btn-primary">
              <i className="fas fa-plus mr-2" aria-hidden /> Add Employee
            </button>
          }
        />
      ) : (
        <div className="vm-bg-surface rounded-2xl border vm-border overflow-hidden">
          <div className="w-full overflow-x-auto">
            <table className="vm-table">
              <thead>
                <tr>
                  <th>Name</th><th>Phone</th><th>Role</th><th>Shift</th><th>Salary</th><th>Station</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => (
                  <tr key={e._id}>
                    <td className="vm-td-name">{e.name}</td>
                    <td>{e.phone || "N/A"}</td>
                    <td>{e.role || "Attendant"}</td>
                    <td>{e.shift || "Full-Time"}</td>
                    <td className="vm-num">{e.salary ? formatINR(e.salary) : "N/A"}</td>
                    <td className="px-6 py-4 text-xs">{e.station ? e.station.name : "Unassigned"}</td>
                    <td>
                      <button
                        onClick={() => void remove(e._id)}
                        title="Delete"
                        aria-label={`Remove ${e.name}`}
                        className="w-8 h-8 rounded-lg vm-bg-ground text-red-400 border vm-border transition-colors flex items-center justify-center"
                      >
                        <i className="fas fa-trash text-xs" aria-hidden />
                      </button>
                    </td>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-bold vm-text-muted mb-2">{label}</label>
      {children}
    </div>
  );
}
