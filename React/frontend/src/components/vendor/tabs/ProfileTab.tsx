import { useEffect, useState } from "react";
import * as api from "@/services/api/vendorApi";
import { useVendorStore } from "@/store/vendorStore";
import { useAuthStore } from "@/store/authStore";
import { pushToast } from "@/store/toastStore";
import { toApiError } from "@/services/api/apiClient";

const FIELDS: Array<[keyof Form, string, boolean]> = [
  ["name", "Name", false],
  ["phone", "Phone", false],
  ["businessName", "Business Name", false],
  ["gstNumber", "GST Number", false],
  ["vendorAddress", "Address", true],
];

interface Form {
  name: string;
  phone: string;
  businessName: string;
  gstNumber: string;
  vendorAddress: string;
  vendorDescription: string;
}

/** Port of renderVendorProfileTab() + saveVendorProfile(). */
export default function ProfileTab() {
  const profile = useVendorStore((s) => s.profile);
  const setProfile = useVendorStore((s) => s.setProfile);
  const user = useAuthStore((s) => s.user);
  const patchUser = useAuthStore((s) => s.patchUser);

  const p = profile ?? (user as unknown as api.VendorProfile) ?? {};

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Form>({
    name: "",
    phone: "",
    businessName: "",
    gstNumber: "",
    vendorAddress: "",
    vendorDescription: "",
  });

  // Refill from the loaded profile whenever the edit form opens, so it never
  // shows values from a previous session's edit.
  useEffect(() => {
    if (!editing) return;
    setForm({
      name: p.name ?? "",
      phone: p.phone ?? "",
      businessName: p.businessName ?? "",
      gstNumber: p.gstNumber ?? "",
      vendorAddress: p.vendorAddress ?? "",
      vendorDescription: p.vendorDescription ?? "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const set = (k: keyof Form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.updateVendorProfile(form);
      pushToast(r.msg || "Profile updated", "success");
      const next = { ...p, ...form };
      setProfile(next);
      // The rail and topbar read the auth store, so keep both in step or the
      // header would keep showing the old business name until a reload.
      patchUser({ name: form.name, businessName: form.businessName });
      setEditing(false);
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setBusy(false);
    }
  };

  const statusCls =
    p.vendorStatus === "active"
      ? "bg-emerald-900/30 text-emerald-400 border-emerald-700"
      : "bg-yellow-900/30 text-yellow-400 border-yellow-700";

  return (
    <>
      <h2 className="text-2xl font-bold mb-6">Profile & Settings</h2>

      <div className="vm-bg-surface rounded-2xl border vm-border p-6 mb-6">
        <div className="flex items-start gap-6 mb-6">
          <div className="w-20 h-20 rounded-2xl vm-accent flex items-center justify-center vm-text font-bold text-3xl">
            {(p.name || "?").charAt(0).toUpperCase()}
          </div>
          <div className="flex-1">
            <h3 className="vm-panel-title">{p.name || "Unknown"}</h3>
            <p className="vm-subtitle">{p.businessName || "No business name"}</p>
            <div className="mt-2">
              <span
                className={`px-2.5 py-1 rounded-full border ${statusCls} text-[10px] font-bold uppercase tracking-wider`}
              >
                {p.vendorStatus || "pending"}
              </span>
            </div>
          </div>
          <button
            onClick={() => setEditing((v) => !v)}
            className="vm-accent vm-accent-hover vm-text font-bold py-2.5 px-4 rounded-lg transition-colors text-sm flex items-center gap-2"
          >
            <i className="fas fa-edit" aria-hidden /> Edit Profile
          </button>
        </div>

        {editing ? (
          <div className="border-t vm-border pt-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {FIELDS.map(([key, label, wide]) => (
                <div key={key} className={wide ? "col-span-2" : undefined}>
                  <label className="block text-xs font-bold vm-text-muted mb-2">{label}</label>
                  <input
                    type="text"
                    className="w-full vm-input px-4 py-2.5 text-sm vm-text"
                    value={form[key]}
                    onChange={(e) => set(key, e.target.value)}
                  />
                </div>
              ))}
              <div className="col-span-2">
                <label className="block text-xs font-bold vm-text-muted mb-2">Description</label>
                <textarea
                  rows={3}
                  className="w-full vm-input px-4 py-2.5 text-sm vm-text"
                  value={form.vendorDescription}
                  onChange={(e) => set("vendorDescription", e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setEditing(false)}
                className="vm-bg-ground vm-hover border vm-border vm-text font-bold py-2.5 px-4 rounded-lg transition-colors text-sm"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={busy}
                className="vm-accent vm-accent-hover vm-text font-bold py-2.5 px-4 rounded-lg transition-colors text-sm flex items-center gap-2"
              >
                <i className="fas fa-save" aria-hidden /> {busy ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm border-t vm-border pt-6">
            <ReadOnly label="Email" value={p.email} />
            <ReadOnly label="Phone" value={p.phone} />
            <ReadOnly label="GST Number" value={p.gstNumber} />
            <ReadOnly label="Address" value={p.vendorAddress} />
            <div className="col-span-2">
              <ReadOnly label="Description" value={p.vendorDescription} />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function ReadOnly({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <p className="vm-text-muted text-xs mb-1">{label}</p>
      <p className="vm-text">{value || "N/A"}</p>
    </div>
  );
}
