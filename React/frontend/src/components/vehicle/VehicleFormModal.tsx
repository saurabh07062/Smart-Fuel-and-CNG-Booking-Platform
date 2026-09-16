import { useEffect, useRef, useState } from "react";
import type { Vehicle } from "@/types";
import Modal from "@/components/common/Modal";
import { detectVehicleType, getVehicleIcon, validateImageFile } from "@/utils/vehicle";
import { uploadUrl } from "@/services/api/apiClient";
import { pushToast } from "@/store/toastStore";

interface Props {
  open: boolean;
  /** null = add, a vehicle = edit. */
  vehicle: Vehicle | null;
  saving?: boolean;
  onClose: () => void;
  onSubmit: (fields: Partial<Vehicle>, file: File | null) => void;
}

const EMPTY = {
  vehicleType: "Car",
  fuelType: "Petrol",
  nickname: "",
  registrationNumber: "",
  brand: "",
  model: "",
  color: "",
  isDefault: false,
};

/**
 * Port of renderVehicleDetailsForm() + renderVehicleModal() in
 * js/pages/dashboard.js -- same fields in the same order, same required
 * markers, same hints, same photo block.
 *
 * The Vanilla form kept its auto-detect state in a DOM dataset attribute
 * (`data-auto-type="0"` once the user picked a type by hand). That is the
 * same rule here, held as `autoType` state: brand/model text only nudges the
 * Vehicle Type select until the user changes the select themselves, and after
 * that it never overrides them again.
 */
export default function VehicleFormModal({ open, vehicle, saving, onClose, onSubmit }: Props) {
  const [form, setForm] = useState<typeof EMPTY>(EMPTY);
  const [autoType, setAutoType] = useState(true);
  const [typeHint, setTypeHint] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Reload the form whenever the modal opens, so an edit never shows the
  // previous vehicle's values and an add never shows the last edit's.
  useEffect(() => {
    if (!open) return;
    setForm({
      vehicleType: vehicle?.vehicleType || "Car",
      fuelType: vehicle?.fuelType || "Petrol",
      nickname: vehicle?.nickname || "",
      registrationNumber: vehicle?.registrationNumber || "",
      brand: vehicle?.brand || "",
      model: vehicle?.model || "",
      color: vehicle?.color || "",
      isDefault: !!vehicle?.isDefault,
    });
    setAutoType(!vehicle); // editing an existing vehicle never re-guesses its type
    setTypeHint(null);
    setFile(null);
    setPreview(uploadUrl(vehicle?.image));
  }, [open, vehicle]);

  // An object URL for a chosen file has to be revoked, or every re-pick leaks
  // one for the lifetime of the page.
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const set = <K extends keyof typeof EMPTY>(k: K, v: (typeof EMPTY)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  /** Port of refreshVehicleFormPreview(false): guess only while autoType holds. */
  const onBrandModelChange = (k: "brand" | "model", value: string) => {
    setForm((f) => {
      const next = { ...f, [k]: value };
      if (autoType) {
        const guess = detectVehicleType(next.brand, next.model);
        if (guess && guess !== next.vehicleType) {
          next.vehicleType = guess;
          setTypeHint(`Auto-detected as ${guess} — change it above if that's wrong`);
        }
      }
      return next;
    });
  };

  const onPickFile = (f: File | null) => {
    if (!f) return;
    const check = validateImageFile(f);
    if (!check.ok) {
      pushToast(check.msg, "error");
      return;
    }
    setFile(f);
  };

  const clearImage = () => {
    setFile(null);
    setPreview(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(
      {
        ...form,
        registrationNumber: form.registrationNumber.trim().toUpperCase(),
      },
      file,
    );
  };

  return (
    <Modal open={open} title={vehicle ? "Edit Vehicle" : "Add Vehicle"} onClose={onClose}>
      <form className="space-y-4" onSubmit={submit}>
        <div
          className="flex items-center gap-4 p-3 rounded-xl"
          style={{ background: "var(--bg2)", border: "1px solid var(--border)" }}
        >
          <div className="relative flex-shrink-0">
            <div
              className="w-14 h-14 rounded-xl flex items-center justify-center text-2xl"
              style={{ background: "var(--primary-light)", color: "var(--primary)" }}
            >
              <i className={`fas ${getVehicleIcon(form.vehicleType)}`} aria-hidden />
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
            <p className="text-xs font-semibold" style={{ color: "var(--text)" }}>
              Vehicle photo
            </p>
            <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
              Optional. JPG, PNG or WEBP, up to 5MB.
            </p>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => fileRef.current?.click()}
              >
                <i className="fas fa-camera" aria-hidden /> Choose photo
              </button>
              {preview && (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
                  onClick={clearImage}
                >
                  <i className="fas fa-xmark" aria-hidden /> Remove
                </button>
              )}
            </div>
            {/* Field name must match the multer field in routes/customerRoutes.js */}
            <input
              ref={fileRef}
              type="file"
              name="vehicleImage"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="field">
            <label className="field-label">
              Vehicle Type <span style={{ color: "var(--danger)" }}>*</span>
            </label>
            <select
              className="input-field"
              required
              value={form.vehicleType}
              onChange={(e) => {
                setAutoType(false); // user took manual control; stop auto-guessing
                setTypeHint(null);
                set("vehicleType", e.target.value);
              }}
            >
              <option value="Car">Car</option>
              <option value="Bike">Bike</option>
              <option value="Scooter">Scooter</option>
              <option value="Other">Other</option>
            </select>
            {typeHint && (
              <span className="field-hint" style={{ color: "var(--primary)" }}>
                {typeHint}
              </span>
            )}
          </div>
          <div className="field">
            <label className="field-label">
              Fuel Type <span style={{ color: "var(--danger)" }}>*</span>
            </label>
            <select
              className="input-field"
              required
              value={form.fuelType}
              onChange={(e) => set("fuelType", e.target.value)}
            >
              <option value="Petrol">Petrol</option>
              <option value="Diesel">Diesel</option>
              <option value="CNG">CNG</option>
              <option value="EV">EV</option>
            </select>
          </div>
        </div>

        <div className="field">
          <label className="field-label">
            Nickname <span style={{ color: "var(--danger)" }}>*</span>
          </label>
          <div className="field-input-wrap">
            <i className="fas fa-tag field-icon" aria-hidden />
            <input
              type="text"
              className="input-field"
              placeholder="e.g. My Car"
              required
              value={form.nickname}
              onChange={(e) => set("nickname", e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label className="field-label">
            Registration Number <span style={{ color: "var(--danger)" }}>*</span>
          </label>
          <div className="field-input-wrap">
            <i className="fas fa-id-card field-icon" aria-hidden />
            <input
              type="text"
              className="input-field uppercase"
              placeholder="MH12AB1234"
              required
              value={form.registrationNumber}
              onChange={(e) => set("registrationNumber", e.target.value)}
            />
          </div>
          <span className="field-hint">Letters and numbers only, e.g. MH12AB1234</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="field">
            <label className="field-label">Brand</label>
            <input
              type="text"
              className="input-field"
              placeholder="Honda"
              value={form.brand}
              onChange={(e) => onBrandModelChange("brand", e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">Model</label>
            <input
              type="text"
              className="input-field"
              placeholder="City"
              value={form.model}
              onChange={(e) => onBrandModelChange("model", e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="field">
            <label className="field-label">Color</label>
            <input
              type="text"
              className="input-field"
              placeholder="Red"
              value={form.color}
              onChange={(e) => set("color", e.target.value)}
            />
          </div>
          <div className="field flex flex-col justify-center pt-1">
            <label className="flex items-center gap-3 cursor-pointer group">
              <div className="relative flex items-center">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={form.isDefault}
                  onChange={(e) => set("isDefault", e.target.checked)}
                />
                <div
                  className="w-5 h-5 rounded border peer-checked:bg-[var(--primary)] peer-checked:border-[var(--primary)] transition-all flex items-center justify-center"
                  style={{ background: "var(--bg2)", borderColor: "var(--border)" }}
                >
                  <i
                    className="fas fa-check text-white text-xs opacity-0 peer-checked:opacity-100 scale-50 peer-checked:scale-100 transition-all"
                    aria-hidden
                  />
                </div>
              </div>
              <span className="text-sm font-medium transition-colors" style={{ color: "var(--muted)" }}>
                Set as default vehicle
              </span>
            </label>
          </div>
        </div>

        <button type="submit" className="w-full btn btn-primary font-medium py-3 mt-2" disabled={saving}>
          {saving ? "Saving…" : "Save Vehicle"}
        </button>
      </form>
    </Modal>
  );
}
