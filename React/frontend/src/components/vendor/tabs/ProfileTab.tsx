import { useEffect, useRef, useState } from "react";
import * as api from "@/services/api/vendorApi";
import { useVendorStore } from "@/store/vendorStore";
import { useAuthStore } from "@/store/authStore";
import { pushToast } from "@/store/toastStore";
import { toApiError, uploadUrl } from "@/services/api/apiClient";
import { IMAGE_ACCEPT, imageFileProblem } from "@/utils/imageUpload";
import { FUEL_REQUIRED_MSG, VENDOR_FUELS, soldFuels, type VendorFuel } from "@/utils/vendorFuels";

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

  // The fuels sold: registered by the vendor, editable here.
  const currentFuels = soldFuels(p.vendorFuelTypes ?? user?.vendorFuelTypes);
  const [fuelsForm, setFuelsForm] = useState<VendorFuel[]>(currentFuels);
  const [fuelsError, setFuelsError] = useState<string | null>(null);

  // Refill from the loaded profile whenever the edit form opens, so it never
  // shows values from a previous session's edit.
  useEffect(() => {
    if (!editing) return;
    setFuelsForm(currentFuels);
    setFuelsError(null);
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

  // ---- profile photo --------------------------------------------------
  const photoInput = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoFailed, setPhotoFailed] = useState(false);
  const photo = uploadUrl(p.profileImage ?? null);

  // ---- invoice signature ---------------------------------------------
  const signInput = useRef<HTMLInputElement>(null);
  const [signBusy, setSignBusy] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const signature = uploadUrl(p.signatureImage ?? null);

  const uploadSignature = async (file: File | undefined) => {
    if (!file) return;
    const problem = imageFileProblem(file);
    setSignError(problem);
    if (problem) return;
    setSignBusy(true);
    try {
      const r = await api.uploadVendorSignature(file);
      if (!r.signatureImage) throw new Error("The server did not return the saved signature.");
      pushToast(r.msg || "Signature updated", "success");
      setProfile({ ...p, signatureImage: r.signatureImage });
    } catch (err) {
      const msg = err instanceof Error && !("response" in err) ? err.message : toApiError(err).msg;
      setSignError(msg);
      pushToast(msg, "error");
    } finally {
      setSignBusy(false);
    }
  };

  const uploadPhoto = async (file: File | undefined) => {
    if (!file) return;
    const problem = imageFileProblem(file);
    setPhotoError(problem);
    if (problem) return;
    setPhotoBusy(true);
    try {
      const r = await api.uploadVendorProfilePhoto(file);
      const saved = r.user?.profileImage ?? null;
      if (!saved) throw new Error("The server did not return the saved photo.");
      pushToast(r.msg || "Profile photo updated", "success");
      setPhotoFailed(false);
      setProfile({ ...p, profileImage: saved });
      // The console header's avatar reads the auth store: update it too, so the
      // new photo shows everywhere at once.
      patchUser({ profileImage: saved });
    } catch (err) {
      const msg = err instanceof Error && !("response" in err) ? err.message : toApiError(err).msg;
      setPhotoError(msg);
      pushToast(msg, "error");
    } finally {
      setPhotoBusy(false);
    }
  };

  const save = async () => {
    if (fuelsForm.length === 0) {
      setFuelsError(FUEL_REQUIRED_MSG);
      return;
    }
    setBusy(true);
    try {
      const r = await api.updateVendorProfile({ ...form, vendorFuelTypes: fuelsForm });
      pushToast(r.msg || "Profile updated", "success");
      const next = { ...p, ...form, vendorFuelTypes: fuelsForm };
      setProfile(next);
      // The rail and topbar read the auth store, so keep both in step or the
      // header would keep showing the old business name until a reload. The
      // Add Station form reads the fuels from there too.
      patchUser({ name: form.name, businessName: form.businessName, vendorFuelTypes: fuelsForm });
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
          <div className="flex flex-col items-center gap-2 flex-shrink-0">
            {photo && !photoFailed ? (
              <img
                src={photo}
                alt="Profile photo"
                className="w-20 h-20 rounded-2xl object-cover"
                style={{ border: "1px solid var(--z-line)" }}
                onError={() => setPhotoFailed(true)}
              />
            ) : (
              <div className="w-20 h-20 rounded-2xl vm-accent flex items-center justify-center vm-text font-bold text-3xl">
                {(p.name || "?").charAt(0).toUpperCase()}
              </div>
            )}
            <button
              type="button"
              onClick={() => photoInput.current?.click()}
              disabled={photoBusy}
              className="vm-bg-ground vm-hover border vm-border rounded-lg px-2.5 py-1 text-[11px] font-bold transition-colors disabled:opacity-50"
            >
              <i className={`fas ${photoBusy ? "fa-spinner fa-spin" : "fa-camera"} mr-1`} aria-hidden />
              {photoBusy ? "Uploading…" : photo ? "Change Photo" : "Upload Photo"}
            </button>
            <input
              ref={photoInput}
              type="file"
              accept={IMAGE_ACCEPT}
              className="sr-only"
              aria-label="Profile photo file"
              onChange={(e) => {
                void uploadPhoto(e.target.files?.[0]);
                e.target.value = ""; // picking the same file again still fires
              }}
            />
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
            {photoError ? (
              <p role="alert" className="text-xs mt-2" style={{ color: "var(--status-bad)" }}>
                {photoError}
              </p>
            ) : (
              <p className="vm-text-muted text-[11px] mt-2">JPG, PNG or WEBP, up to 5MB</p>
            )}
          </div>
          <button
            onClick={() => setEditing((v) => !v)}
            className="vm-accent vm-accent-hover vm-text font-bold py-2.5 px-4 rounded-lg transition-colors text-sm flex items-center gap-2"
          >
            <i className="fas fa-edit" aria-hidden /> Edit Profile
          </button>
        </div>

        <div className="border-t vm-border pt-5 mb-6 flex items-center gap-4 flex-wrap">
          <div
            className="w-44 h-16 rounded-lg vm-bg-ground border vm-border flex items-center justify-center overflow-hidden"
            style={{ background: "#fff" }}
          >
            {signature ? (
              <img src={signature} alt="Invoice signature" className="max-h-14 max-w-full object-contain" />
            ) : (
              <span className="text-[11px]" style={{ color: "#64748b" }}>No signature</span>
            )}
          </div>
          <div className="flex-1 min-w-[180px]">
            <h4 className="font-bold text-sm">Invoice signature</h4>
            {signError ? (
              <p role="alert" className="text-xs mt-1" style={{ color: "var(--status-bad)" }}>{signError}</p>
            ) : (
              <p className="vm-text-muted text-[11px] mt-1">Printed on invoices issued from now on. PNG on a white or transparent background works best.</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => signInput.current?.click()}
            disabled={signBusy}
            className="vm-bg-ground vm-hover border vm-border rounded-lg px-3 py-2 text-xs font-bold transition-colors disabled:opacity-50"
          >
            <i className={`fas ${signBusy ? "fa-spinner fa-spin" : "fa-signature"} mr-1`} aria-hidden />
            {signBusy ? "Uploading…" : signature ? "Change Signature" : "Upload Signature"}
          </button>
          <input
            ref={signInput}
            type="file"
            accept={IMAGE_ACCEPT}
            className="sr-only"
            aria-label="Signature image file"
            onChange={(e) => {
              void uploadSignature(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
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
                <p className="block text-xs font-bold vm-text-muted mb-2">Fuels Sold *</p>
                <div className="flex gap-4" role="group" aria-label="Fuels Sold">
                  {VENDOR_FUELS.map((f) => (
                    <label key={f.key} className="flex items-center gap-2 text-sm vm-text">
                      <input
                        type="checkbox"
                        checked={fuelsForm.includes(f.key)}
                        onChange={(e) => {
                          setFuelsError(null);
                          setFuelsForm((cur) =>
                            e.target.checked
                              ? VENDOR_FUELS.map((x) => x.key).filter((k) => k === f.key || cur.includes(k))
                              : cur.filter((k) => k !== f.key),
                          );
                        }}
                      />
                      {f.label}
                    </label>
                  ))}
                </div>
                {fuelsError && (
                  <p role="alert" className="text-xs mt-1" style={{ color: "var(--status-bad)" }}>
                    {fuelsError}
                  </p>
                )}
              </div>
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
            <ReadOnly
              label="Fuels Sold"
              value={VENDOR_FUELS.filter((f) => currentFuels.includes(f.key))
                .map((f) => f.label)
                .join(", ")}
            />
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
