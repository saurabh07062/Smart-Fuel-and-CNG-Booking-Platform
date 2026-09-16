import { useMemo, useState } from "react";
import type { UiStation, Vehicle } from "@/types";
import VehicleArt from "@/components/vehicle/VehicleArt";
import { useBookingDraftStore } from "@/store/bookingDraftStore";
import { pushToast } from "@/store/toastStore";
import {
  BOOKING_VEHICLE_TYPES,
  detectVehicleType,
  isValidPlate,
  normalisePlate,
  resolveDraftVehicle,
  vehicleDisplayName,
} from "@/utils/vehicle";

interface Props {
  station: UiStation;
  vehicles: Vehicle[];
  /**
   * Save a vehicle to the account. Resolves to the saved vehicle, or null if
   * saving failed (the caller has already shown the error).
   */
  onSaveVehicle: (fields: Partial<Vehicle>) => Promise<Vehicle | null>;
  savingVehicle: boolean;
}

interface NewVehicle {
  type: string;
  plate: string;
  name: string;
  save: boolean;
}

const FUEL_ICON: Record<string, string> = { CNG: "fire", Diesel: "oil-can", Petrol: "droplet" };
const FUEL_TONE: Record<string, string> = { CNG: "cx-tone-green", Diesel: "cx-tone-amber", Petrol: "cx-tone-blue" };

/** Fuel values the vehicle schema accepts (VehicleFormModal's select). */
const VEHICLE_FUELS = ["Petrol", "Diesel", "CNG", "EV"];

/**
 * Step 0 -- fuel type, then the vehicle the slot is for.
 *
 * Fuel buttons still come from the station's own fuelTypes, with prices from
 * uiPrices so both API casings resolve.
 *
 * The vehicle can be one of the customer's saved vehicles, or a new one added
 * inline (type + number) without leaving the wizard. A new vehicle is saved to
 * the account by default so it is there next time; unticking "Save" books
 * with it once and leaves the account untouched.
 */
export default function FuelVehicleStep({ station, vehicles, onSaveVehicle, savingVehicle }: Props) {
  const draft = useBookingDraftStore((s) => s.draft);
  const patch = useBookingDraftStore((s) => s.patch);

  const current = useMemo(() => resolveDraftVehicle(draft, vehicles), [draft, vehicles]);
  const oneTime = current && !current.saved ? current : null;

  const [formSeed, setFormSeed] = useState<Partial<NewVehicle> | null>(null);
  const [formKey, setFormKey] = useState(0);

  // With nothing saved and nothing chosen, the form is the only way forward,
  // so it opens by itself instead of behind an "Add" tile.
  const formOpen = formSeed !== null || (vehicles.length === 0 && !current);

  const openForm = (seed: Partial<NewVehicle> = {}) => {
    setFormSeed(seed);
    setFormKey((k) => k + 1);
  };
  const closeForm = () => setFormSeed(null);

  const selectSaved = (v: Vehicle) =>
    patch({
      vehicleId: String(v._id ?? ""),
      vehiclePlate: v.registrationNumber ?? null,
      vehicleType: v.vehicleType ?? null,
      vehicleName: vehicleDisplayName(v),
    });

  const submitNew = async ({ type, plate, name, save }: NewVehicle) => {
    const existing = vehicles.find((v) => normalisePlate(v.registrationNumber || "") === plate);
    if (existing) {
      selectSaved(existing);
      closeForm();
      pushToast("That vehicle is already saved, so it has been selected for you", "info");
      return;
    }

    if (save) {
      const added = await onSaveVehicle({
        vehicleType: type,
        nickname: name,
        registrationNumber: plate,
        fuelType: VEHICLE_FUELS.includes(draft.fuelType ?? "") ? (draft.fuelType as string) : "Petrol",
        isDefault: false,
      });
      if (!added) return;
      selectSaved(added);
    } else {
      patch({ vehicleId: null, vehiclePlate: plate, vehicleType: type, vehicleName: name });
    }
    closeForm();
  };

  return (
    <div className="space-y-7">
      <section>
        <div className="cx-section">
          <h3 className="cx-section-title">
            <span className="cx-section-num">1</span> Select fuel type
          </h3>
        </div>
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
        >
          {station.fuelTypes.map((f) => {
            const selected = draft.fuelType === f;
            return (
              <button
                key={f}
                type="button"
                className={`cx-option ${selected ? "is-selected" : ""}`}
                onClick={() => patch({ fuelType: f })}
                aria-pressed={selected}
              >
                <span className="cx-option-check">
                  <i className="fas fa-check" aria-hidden />
                </span>
                <span className={`cx-stat-icon mx-auto mb-2 ${FUEL_TONE[f] ?? "cx-tone-blue"}`}>
                  <i className={`fas fa-${FUEL_ICON[f] ?? "droplet"}`} aria-hidden />
                </span>
                <span className="cx-option-name block">{f}</span>
                <span className="cx-option-sub block">
                  {station.uiPrices[f as keyof typeof station.uiPrices] != null
                    ? `INR ${station.uiPrices[f as keyof typeof station.uiPrices]}/L`
                    : "Price not published"}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <div className="cx-section">
          <h3 className="cx-section-title">
            <span className="cx-section-num">2</span> Select your vehicle
          </h3>
          {!formOpen && (
            <button type="button" className="cx-link" onClick={() => openForm()}>
              <i className="fas fa-plus" aria-hidden /> Add new
            </button>
          )}
        </div>

        {(vehicles.length > 0 || oneTime) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {vehicles.map((v) => {
              const vid = String(v._id ?? "");
              const selected = draft.vehicleId === vid;
              return (
                <button
                  key={vid}
                  type="button"
                  className={`cx-option flex items-center gap-3 text-left ${selected ? "is-selected" : ""}`}
                  onClick={() => {
                    selectSaved(v);
                    closeForm();
                  }}
                  aria-pressed={selected}
                >
                  <span className="cx-option-check">
                    <i className="fas fa-check" aria-hidden />
                  </span>
                  <VehicleArt type={v.vehicleType} image={v.image} size={46} />
                  <span className="min-w-0 flex-1 pr-5">
                    <span className="cx-option-name block">{vehicleDisplayName(v)}</span>
                    <span className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <span className="cx-plate">{v.registrationNumber || "—"}</span>
                      {v.isDefault && <span className="cx-tag is-blue">Default</span>}
                    </span>
                  </span>
                </button>
              );
            })}

            {oneTime && (
              <button
                type="button"
                className="cx-option is-selected flex items-center gap-3 text-left"
                onClick={() =>
                  openForm({ type: oneTime.type, plate: oneTime.plate, name: oneTime.name, save: false })
                }
                aria-pressed
                title="Edit this vehicle"
              >
                <span className="cx-option-check">
                  <i className="fas fa-check" aria-hidden />
                </span>
                <VehicleArt type={oneTime.type} size={46} />
                <span className="min-w-0 flex-1 pr-5">
                  <span className="cx-option-name block">{oneTime.name}</span>
                  <span className="flex items-center gap-1.5 mt-1 flex-wrap">
                    <span className="cx-plate">{oneTime.plate}</span>
                    <span className="cx-tag is-amber">This booking only</span>
                  </span>
                </span>
              </button>
            )}

            {!formOpen && (
              <button
                type="button"
                className="cx-option is-dashed flex items-center gap-3 text-left"
                onClick={() => openForm()}
              >
                <span
                  className="flex items-center justify-center flex-shrink-0"
                  style={{ width: 46, height: 46, borderRadius: 12, background: "var(--bg2)" }}
                >
                  <i className="fas fa-plus" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="cx-option-name block" style={{ color: "inherit" }}>
                    Add a new vehicle
                  </span>
                  <span className="cx-option-sub block">Car, bike or other</span>
                </span>
              </button>
            )}
          </div>
        )}

        {formOpen && (
          <div className={vehicles.length > 0 || oneTime ? "mt-3" : ""}>
            <AddVehicleForm
              key={formKey}
              seed={formSeed ?? {}}
              saving={savingVehicle}
              canCancel={vehicles.length > 0 || !!oneTime}
              onCancel={closeForm}
              onSubmit={submitNew}
            />
          </div>
        )}
      </section>
    </div>
  );
}

function AddVehicleForm({
  seed,
  saving,
  canCancel,
  onCancel,
  onSubmit,
}: {
  seed: Partial<NewVehicle>;
  saving: boolean;
  canCancel: boolean;
  onCancel: () => void;
  onSubmit: (v: NewVehicle) => void | Promise<void>;
}) {
  const [type, setType] = useState(seed.type ?? "Car");
  const [plate, setPlate] = useState(seed.plate ?? "");
  const [name, setName] = useState(seed.name ?? "");
  const [save, setSave] = useState(seed.save ?? true);
  // Same rule as VehicleFormModal: typed text only nudges the type until the
  // customer picks one themselves.
  const [autoType, setAutoType] = useState(!seed.type);
  const [typeHint, setTypeHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const displayName = name.trim() || `My ${type}`;

  const onNameChange = (value: string) => {
    setName(value);
    if (!autoType) return;
    const guess = detectVehicleType(value);
    if (guess && guess !== type) {
      setType(guess);
      setTypeHint(`Looks like a ${guess}. Pick another type if that's wrong.`);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!plate) return setError("Enter your vehicle number");
    if (!isValidPlate(plate)) return setError("Enter a valid vehicle number, e.g. MH12AB1234");
    void onSubmit({ type, plate, name: displayName, save });
  };

  return (
    <form className="cx-subpanel" onSubmit={submit} noValidate>
      <div className="flex items-center gap-4 mb-4">
        <VehicleArt type={type} size={72} radius={16} />
        <div className="min-w-0">
          <p className="cx-eyebrow">{seed.plate ? "Edit vehicle" : "New vehicle"}</p>
          <p className="cx-option-name" style={{ fontSize: 15 }}>
            {displayName}
          </p>
          <span className="cx-plate mt-1" style={plate ? undefined : { color: "var(--muted)" }}>
            {plate || "MH12AB1234"}
          </span>
        </div>
      </div>

      <p className="text-[12.5px] font-semibold mb-2" style={{ color: "var(--text2)" }} id="bk-vehicle-type">
        Vehicle type <span style={{ color: "var(--danger)" }}>*</span>
      </p>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-labelledby="bk-vehicle-type">
        {BOOKING_VEHICLE_TYPES.map((t) => {
          const selected = type === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`cx-option ${selected ? "is-selected" : ""}`}
              style={{ padding: "12px 6px" }}
              onClick={() => {
                setAutoType(false);
                setTypeHint(null);
                setType(t.id);
              }}
            >
              <span className="cx-option-check">
                <i className="fas fa-check" aria-hidden />
              </span>
              <VehicleArt type={t.id} size={44} className="mx-auto mb-2" />
              <span className="cx-option-name block">{t.id}</span>
              <span className="cx-option-sub hidden sm:block">{t.hint}</span>
            </button>
          );
        })}
      </div>
      {typeHint && (
        <p className="text-[11.5px] mt-2" style={{ color: "var(--primary)" }}>
          <i className="fas fa-wand-magic-sparkles mr-1" aria-hidden />
          {typeHint}
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
        <div className={`field ${error ? "has-error" : ""}`}>
          <label className="field-label" htmlFor="bk-plate">
            Vehicle number <span style={{ color: "var(--danger)" }}>*</span>
          </label>
          <input
            id="bk-plate"
            type="text"
            className="input-field cx-plate-input"
            placeholder="MH12AB1234"
            autoComplete="off"
            maxLength={12}
            value={plate}
            aria-invalid={!!error}
            aria-describedby="bk-plate-hint"
            onChange={(e) => {
              setPlate(normalisePlate(e.target.value).slice(0, 12));
              setError(null);
            }}
          />
          {error ? (
            <span className="cx-error" id="bk-plate-hint" role="alert">
              <i className="fas fa-circle-exclamation" aria-hidden /> {error}
            </span>
          ) : (
            <span className="field-hint" id="bk-plate-hint">
              Letters and numbers only. Spaces are removed.
            </span>
          )}
        </div>
        <div className="field">
          <label className="field-label" htmlFor="bk-nickname">
            Nickname{" "}
            <span className="font-normal" style={{ color: "var(--muted)" }}>
              (optional)
            </span>
          </label>
          <input
            id="bk-nickname"
            type="text"
            className="input-field"
            placeholder={`e.g. My ${type}`}
            maxLength={40}
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
          />
        </div>
      </div>

      <label className="cx-check mt-4">
        <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
        <span>
          <span className="font-semibold" style={{ color: "var(--text)" }}>
            Save to My Vehicles
          </span>
          <span className="block text-[11.5px]" style={{ color: "var(--muted)" }}>
            Reuse it on future bookings. Untick to use it for this booking only.
          </span>
        </span>
      </label>

      <div className="flex gap-2 mt-4 justify-end flex-wrap">
        {canCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? (
            <>
              <i className="fas fa-spinner fa-spin" aria-hidden /> Saving…
            </>
          ) : (
            <>
              <i className="fas fa-check" aria-hidden /> {save ? "Save & use vehicle" : "Use this vehicle"}
            </>
          )}
        </button>
      </div>
    </form>
  );
}
