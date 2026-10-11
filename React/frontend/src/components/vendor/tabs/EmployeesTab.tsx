import { useEffect, useRef, useState } from "react";
import * as api from "@/services/api/vendorApi";
import { useVendorStore } from "@/store/vendorStore";
import { pushToast } from "@/store/toastStore";
import { toApiError } from "@/services/api/apiClient";
import { formatINR } from "@/utils/vendorFormat";
import { VendorEmpty, VendorHeading } from "../VendorBits";
import DataTable, { type Column } from "@/components/common/DataTable";

const EMPTY = { name: "", phone: "", email: "", role: "Attendant", shift: "Full-Time", salary: "0", station: "" };

/** Port of renderVendorEmployeesTab() + addVendorEmployee()/deleteVendorEmployee(). */
export default function EmployeesTab() {
  const employees = useVendorStore((s) => s.employees);
  const stations = useVendorStore((s) => s.stations);
  const loadTab = useVendorStore((s) => s.loadTab);

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);

  /**
   * The photo, handled exactly as a customer handles a vehicle picture
   * (components/vehicle/VehicleFormModal.tsx): the file is held here and sent
   * with the record, and the preview is an object URL that is revoked when it
   * is replaced, because an un-revoked one leaks the image for the life of
   * the page.
   */
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!photo) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const clearPhoto = () => {
    setPhoto(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const set = (k: keyof typeof EMPTY, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const add = async () => {
    if (!form.name || !form.phone) {
      pushToast("Name and phone are required", "error");
      return;
    }
    setBusy(true);
    try {
      const r = await api.addVendorEmployee(
        {
          name: form.name,
          phone: form.phone,
          email: form.email || undefined,
          role: form.role,
          shift: form.shift,
          salary: Number(form.salary) || 0,
          station: form.station || undefined,
        },
        photo,
      );
      pushToast(r.msg || "Employee added", "success");
      setForm(EMPTY);
      clearPhoto();
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
          {/*
            The photo, above the fields: it is the thing that makes a staff
            list recognisable at a glance, and the same control a customer
            uses for a vehicle picture.
          */}
          <div className="flex items-center gap-4 mb-4">
            <div className="relative flex-shrink-0">
              <div
                className="w-14 h-14 rounded-xl flex items-center justify-center text-2xl"
                style={{ background: "var(--primary-light)", color: "var(--primary)" }}
              >
                <i className="fas fa-user" aria-hidden />
              </div>
              {preview && (
                <img
                  src={preview}
                  alt=""
                  className="absolute inset-0 w-14 h-14 rounded-xl object-cover"
                  style={{ border: "1px solid var(--border)" }}
                />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold vm-text">Employee photo</p>
              <p className="text-xs vm-text-muted mt-0.5">Optional. JPG, PNG or WEBP, up to 3MB.</p>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <button type="button" className="vm-btn vm-btn-ghost" onClick={() => fileRef.current?.click()}>
                  <i className="fas fa-camera mr-1.5" aria-hidden /> Choose photo
                </button>
                {preview && (
                  <button
                    type="button"
                    className="vm-btn vm-btn-ghost"
                    style={{ color: "var(--danger)" }}
                    onClick={clearPhoto}
                  >
                    <i className="fas fa-xmark mr-1.5" aria-hidden /> Remove
                  </button>
                )}
              </div>
              {/* The name must match the multer field in routes/vendorPanelRoutes.js */}
              <input
                ref={fileRef}
                type="file"
                name="employeePhoto"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
                data-testid="employee-photo-input"
              />
            </div>
          </div>

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
        <DataTable
          label="Your staff"
          rows={employees}
          rowKey={(e) => e._id}
          testId="vendor-employees"
          columns={EMPLOYEE_COLUMNS(remove)}
        />
      )}
    </>
  );
}

/**
 * The staff columns.
 *
 * Name carries the face, so it never drops. Shift, salary and station are the
 * three a phone can live without: on a 375px screen they are what turns a
 * readable list into a sideways scroll before you reach the delete button.
 * Phone and role stay, because they are why a vendor opens this tab — who is
 * on, and how to reach them.
 */
const EMPLOYEE_COLUMNS = (remove: (id: string) => void): Column<api.VendorEmployee>[] => [
  {
    key: "name",
    header: "Name",
    cell: (e) => (
      <span className="flex items-center gap-2.5">
        {e.photo ? (
          <img
            src={e.photo}
            alt=""
            className="w-8 h-8 rounded-full object-cover flex-shrink-0"
            style={{ border: "1px solid var(--border)" }}
            loading="lazy"
          />
        ) : (
          <span
            className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
            style={{ background: "var(--primary-light)", color: "var(--primary)" }}
            aria-hidden
          >
            {e.name.charAt(0).toUpperCase()}
          </span>
        )}
        {e.name}
      </span>
    ),
  },
  { key: "phone", header: "Phone", cell: (e) => e.phone || "N/A" },
  { key: "role", header: "Role", cell: (e) => e.role || "Attendant" },
  { key: "shift", header: "Shift", cell: (e) => e.shift || "Full-Time", hideOnPhone: true },
  {
    key: "salary",
    header: "Salary",
    align: "right",
    hideOnPhone: true,
    cell: (e) => (e.salary ? formatINR(e.salary) : "N/A"),
  },
  { key: "station", header: "Station", hideOnPhone: true, cell: (e) => (e.station ? e.station.name : "Unassigned") },
  {
    key: "actions",
    header: "",
    align: "right",
    cell: (e) => (
      <button
        onClick={() => void remove(e._id)}
        title="Delete"
        aria-label={`Remove ${e.name}`}
        className="w-8 h-8 rounded-lg vm-bg-ground text-red-400 border vm-border transition-colors inline-flex items-center justify-center"
      >
        <i className="fas fa-trash text-xs" aria-hidden />
      </button>
    ),
  },
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-bold vm-text-muted mb-2">{label}</label>
      {children}
    </div>
  );
}
