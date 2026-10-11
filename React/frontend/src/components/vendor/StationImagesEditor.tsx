import { useEffect, useRef, useState } from "react";
import { soldFuels } from "@/utils/vendorFuels";
import type { VendorStation } from "@/services/api/vendorApi";
import { updateVendorPumpImages, updateVendorStationPhoto } from "@/services/api/vendorApi";
import { toApiError, uploadUrl } from "@/services/api/apiClient";
import { pushToast } from "@/store/toastStore";

import { IMAGE_MAX_BYTES, STATION_IMAGE_RULE_TEXT, stationImageProblem } from "@/utils/imageUpload";

/** The same rules the server enforces (backend middleware/upload.js, "stations"). */
export const PUMP_IMAGE_MAX_BYTES = IMAGE_MAX_BYTES;

type PumpKey = "petrol" | "cng";
/**
 * "station" is the station's own photo (Station.images[0]) -- the wide banner
 * above the pump in the customer app. It lives here, with the pump photos,
 * because it is the vendor's picture to take: the admin form used to hold a
 * URL box for it, which meant an admin save could overwrite or erase a real
 * photo with a pasted link.
 */
type SlotKey = PumpKey | "station";
const SLOTS: { key: SlotKey; label: string; icon: string }[] = [
  { key: "station", label: "Station Photo", icon: "fa-image" },
  { key: "petrol", label: "Petrol Pump Image", icon: "fa-gas-pump" },
  { key: "cng", label: "CNG Pump Image", icon: "fa-fire" },
];
const blank = <T,>(v: T): Record<SlotKey, T> => ({ station: v, petrol: v, cng: v });

/**
 * Why a chosen file cannot be uploaded, or null. Type, size AND the picture's
 * own dimensions -- the server refuses a portrait or a thumbnail
 * (services/upload/imageRules.js), so it is refused here first, before the
 * vendor waits for an upload that was never going to be kept.
 */
export function pumpImageProblem(file: File): Promise<string | null> {
  return stationImageProblem(file, PUMP_IMAGE_MAX_BYTES);
}

/**
 * Edit Station: add or replace the station's petrol and CNG pump photos.
 *
 * Each slot shows the saved photo with Replace, or Add Image when there is
 * none. A chosen file is checked (type, size) and previewed before anything is
 * sent; Save uploads only the slots that changed.
 */
export default function StationImagesEditor({
  station,
  onClose,
  onSaved,
}: {
  station: VendorStation;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [files, setFiles] = useState<Record<SlotKey, File | null>>(() => blank<File | null>(null));
  const [previews, setPreviews] = useState<Record<SlotKey, string | null>>(() => blank<string | null>(null));
  const [errors, setErrors] = useState<Record<SlotKey, string | null>>(() => blank<string | null>(null));
  const [saving, setSaving] = useState(false);

  // Object URLs hold the file in memory until revoked: a replaced preview is
  // revoked when it is replaced, the rest when the editor closes.
  const createdUrls = useRef<string[]>([]);
  useEffect(() => () => createdUrls.current.forEach((url) => URL.revokeObjectURL(url)), []);

  const choose = async (key: SlotKey, file: File | undefined) => {
    if (!file) return;
    const problem = await pumpImageProblem(file);
    setErrors((e) => ({ ...e, [key]: problem }));
    if (problem) return;
    const old = previews[key];
    if (old) URL.revokeObjectURL(old);
    const url = URL.createObjectURL(file);
    createdUrls.current.push(url);
    setFiles((f) => ({ ...f, [key]: file }));
    setPreviews((p) => ({ ...p, [key]: url }));
  };

  // A CNG-only station is not asked for a petrol pump photo, and the other
  // way round: the slots follow what the station sells.
  const sells = new Set<string>(soldFuels(station.fuelTypes));
  const slots = SLOTS.filter((slot) => slot.key === "station" || sells.has(slot.key));
  const changed = Boolean(files.station || files.petrol || files.cng);

  const save = async () => {
    if (!changed) return;
    setSaving(true);
    try {
      // Two endpoints: the pump photos go to /pump-images, the station's own
      // photo is a normal station edit with a file. Only what changed is sent.
      if (files.petrol || files.cng) {
        // Only the pump photos: the station's own photo goes to a different
        // endpoint, and passing it here would send a key that route ignores.
        await updateVendorPumpImages(String(station._id), { petrol: files.petrol, cng: files.cng });
      }
      if (files.station) {
        await updateVendorStationPhoto(String(station._id), files.station);
      }
      pushToast("Photos updated", "success");
      await onSaved();
      onClose();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="vm-bg-surface rounded-2xl border vm-border p-6 mb-6" role="region" aria-label="Station photos">
      <h3 className="text-lg font-bold mb-1 flex items-center gap-2">
        <i className="fas fa-camera vm-accent-text" aria-hidden /> Station &amp; Pump Photos
      </h3>
      <p className="vm-subtitle mb-4" style={{ fontSize: "12px" }}>
        {station.name} · {STATION_IMAGE_RULE_TEXT}
      </p>
      <p className="vm-text-muted mb-4" style={{ fontSize: "11.5px" }}>
        <i className="fas fa-circle-info mr-1" aria-hidden />
        A photo that does not meet this is not uploaded — the customer banner is wide, and a portrait or a small
        photo is stretched across it.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {slots.map(({ key, label, icon }) => {
          const saved = uploadUrl(
            key === "station" ? station.images?.[0] ?? null : station.pumpImages?.[key] ?? null,
          );
          const shown = previews[key] ?? saved;
          const inputId = `station-photo-${key}-${station._id}`;
          return (
            <div key={key} className="vm-bg-ground rounded-xl border vm-border p-4">
              <p className="text-xs font-bold vm-text-muted mb-2">
                <i className={`fas ${icon} mr-1`} aria-hidden /> {label}
              </p>
              {key === "station" && (
                <p className="text-xs vm-text-muted mb-2">Shown to customers above your pump in the app.</p>
              )}
              {shown ? (
                <img
                  src={shown}
                  alt={label}
                  className="w-full h-40 object-cover rounded-lg mb-3"
                  style={{ border: "1px solid var(--z-line)" }}
                />
              ) : (
                <div className="w-full h-40 rounded-lg mb-3 flex items-center justify-center vm-text-muted text-sm border vm-border">
                  No image yet
                </div>
              )}
              {previews[key] && <p className="text-xs vm-text-muted mb-2">New image selected — press Save to upload.</p>}
              <label
                htmlFor={inputId}
                className="block text-center cursor-pointer vm-bg-surface vm-hover border vm-border rounded-lg py-2 text-xs font-bold transition-colors"
              >
                <i className={`fas ${saved || previews[key] ? "fa-arrows-rotate" : "fa-plus"} mr-1`} aria-hidden />
                {saved || previews[key] ? `Replace ${label}` : `Add ${label}`}
              </label>
              <input
                id={inputId}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                aria-label={label}
                onChange={(e) => {
                  void choose(key, e.target.files?.[0]);
                  e.target.value = ""; // choosing the same file again still fires
                }}
              />
              {errors[key] && (
                <p role="alert" className="text-xs mt-2" style={{ color: "var(--status-bad)" }}>
                  {errors[key]}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex justify-end gap-3 mt-6">
        <button
          type="button"
          onClick={onClose}
          className="vm-bg-ground vm-hover border vm-border vm-text font-bold py-2.5 px-4 rounded-lg transition-colors text-sm"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!changed || saving}
          className="vm-accent vm-accent-hover vm-text font-bold py-2.5 px-4 rounded-lg transition-colors text-sm flex items-center gap-2 disabled:opacity-50"
        >
          <i className="fas fa-save" aria-hidden /> {saving ? "Saving…" : "Save Changes"}
        </button>
      </div>
    </div>
  );
}
