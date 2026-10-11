import { useState } from "react";
import type { Station } from "@/types";
import * as api from "@/services/api/adminApi";
import { useAdminStore } from "@/store/adminStore";
import { pushToast } from "@/store/toastStore";
import { toApiError, uploadUrl } from "@/services/api/apiClient";
import { ConsoleLoading } from "@/components/console/ConsoleBits";
import { soldFuels } from "@/utils/vendorFuels";
import StationImagesEditor from "@/components/vendor/StationImagesEditor";
import type { VendorStation } from "@/services/api/vendorApi";
import StationForm, {
  STATION_DEFAULTS,
  toPayload,
  valuesFromStation,
  type StationFormValues,
} from "./StationForm";

/** Label and colour per fuel, matching the customer pages. */
const FUEL_LOOK: Record<"petrol" | "diesel" | "cng", { label: string; cls: string }> = {
  petrol: { label: "PETROL", cls: "text-orange-400" },
  diesel: { label: "DIESEL", cls: "text-indigo-400" },
  cng: { label: "CNG", cls: "text-emerald-400" },
};

/** Port of renderAdminStationManager() and its CRUD actions. */
export default function AdminStationsTab() {
  const stations = useAdminStore((s) => s.stations);
  const editingId = useAdminStore((s) => s.editingStationId);
  const creating = useAdminStore((s) => s.creatingStation);
  const setEditing = useAdminStore((s) => s.setEditingStation);
  const setCreating = useAdminStore((s) => s.setCreatingStation);
  const loadStations = useAdminStore((s) => s.loadStations);

  const [saving, setSaving] = useState(false);
  /**
   * Which station's photos are open.
   *
   * The admin form carries no photo field on purpose -- it only ever held a
   * URL box, and saving it blank wiped the picture the vendor had uploaded.
   * This is the real thing instead: the same uploader the vendor uses, writing
   * a real file through the same endpoint (an admin is allowed on any station
   * -- backend controllers/vendorPanelController.js findOwnedStation), with
   * the same type, size and shape rules applied server-side.
   */
  const [photosId, setPhotosId] = useState<string | null>(null);

  const save = async (values: StationFormValues, id?: string) => {
    if (!values.name.trim() || !values.address.trim()) {
      pushToast("Station name and address are required", "error");
      return;
    }
    setSaving(true);
    try {
      const payload = toPayload(values);
      if (id) {
        await api.updateStationAdmin(id, payload);
        pushToast("Station details updated successfully! Customers will see changes live.", "success");
      } else {
        await api.createStationAdmin(payload);
        pushToast("Station created successfully", "success");
      }
      setEditing(null);
      setCreating(false);
      await loadStations();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (id: string) => {
    try {
      const r = await api.toggleStationStatusAdmin(id);
      pushToast(r.msg || "Station status updated", "success");
      await loadStations();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("WARNING: This will permanently delete the station. Continue?")) return;
    try {
      const r = await api.deleteStationAdmin(id);
      pushToast(r.msg || "Station deleted", "success");
      await loadStations();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    }
  };

  if (creating) {
    return (
      <StationForm
        heading="Add New Station"
        subheading="This station becomes visible to customers as soon as it is Active."
        saveLabel="Create Station"
        initial={STATION_DEFAULTS}
        saving={saving}
        onCancel={() => setCreating(false)}
        onSave={(v) => void save(v)}
      />
    );
  }

  if (editingId && stations) {
    const station = stations.find((s) => String(s._id) === editingId);
    if (station) {
      return (
        <StationForm
          heading="Edit Station Details"
          subheading="Changes will sync live to all customer pages."
          saveLabel="Save Changes"
          initial={valuesFromStation(station as Station & Record<string, unknown>)}
          saving={saving}
          onCancel={() => setEditing(null)}
          onSave={(v) => void save(v, editingId)}
        />
      );
    }
  }

  const photoStation = photosId && stations ? stations.find((st) => String(st._id) === photosId) : undefined;

  const header = (
    <div className="flex items-center justify-between mb-4">
      <div>
        <h2 className="vm-stat-value" style={{ fontSize: 22 }}>
          Manage Petrol Pumps
        </h2>
        <p className="vm-text-muted text-sm mt-1">
          Control all station details — prices, photos, location &amp; more. Changes reflect
          instantly on customer pages.
        </p>
      </div>
      <button
        onClick={() => setCreating(true)}
        className="vm-accent vm-accent-hover vm-text font-bold py-2.5 px-5 rounded-lg transition-colors flex items-center gap-2"
      >
        <i className="fas fa-plus" aria-hidden /> Add New Station
      </button>
    </div>
  );

  // null means "still loading"; [] means "loaded, none found". Collapsing the
  // two would show "No stations found" during every fetch.
  if (stations === null) {
    return (
      <div className="space-y-6">
        {header}
        <ConsoleLoading label="Loading stations..." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      {photoStation && (
        <StationImagesEditor
          key={`admin-photos-${photosId}`}
          // The editor speaks the vendor station shape; an admin station row
          // carries the same fields it reads (name, fuelTypes, images,
          // pumpImages).
          station={photoStation as unknown as VendorStation}
          onClose={() => setPhotosId(null)}
          onSaved={loadStations}
        />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {stations.length === 0 ? (
          <div className="col-span-full text-center py-16 vm-text-muted">
            <i className="fas fa-gas-pump text-5xl mb-4 opacity-40" aria-hidden />
            <p className="text-lg">No stations found. Create one to get started.</p>
          </div>
        ) : (
          stations.map((s) => (
            <StationCard
              key={String(s._id)}
              station={s}
              onEdit={() => setEditing(String(s._id))}
              onPhotos={() => setPhotosId(String(s._id))}
              onToggle={() => void toggleStatus(String(s._id))}
              onDelete={() => void remove(String(s._id))}
            />
          ))
        )}
      </div>
    </div>
  );
}

function StationCard({
  station: s,
  onEdit,
  onPhotos,
  onToggle,
  onDelete,
}: {
  station: Station;
  onEdit: () => void;
  onPhotos: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const raw = s.images?.[0];
  // uploadUrl() resolves a stored /uploads path; a pasted absolute URL is
  // used as-is, which is what the Vanilla `|| s.images[0]` fallback did.
  // Without a station photo, the pump photo its vendor uploaded is shown --
  // the same order the customer pages use (utils/station.ts).
  const photo =
    (raw ? (uploadUrl(raw) ?? raw) : null) ??
    uploadUrl(s.pumpImages?.petrol ?? null) ??
    uploadUrl(s.pumpImages?.cng ?? null);
  const prices = (s.prices ?? {}) as Record<string, number | undefined>;

  return (
    <div className="vm-bg-surface rounded-2xl border vm-border overflow-hidden transition-colors">
      <div className="h-40 vm-bg-ground relative overflow-hidden">
        {photo && !imgFailed ? (
          <img
            src={photo}
            alt=""
            className="w-full h-full object-cover"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <i className="fas fa-gas-pump text-5xl vm-text-muted" aria-hidden />
          </div>
        )}
        <div className="absolute top-3 right-3">
          <span
            className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
              s.status === "Active"
                ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                : "bg-red-500/20 text-red-400 border border-red-500/30"
            }`}
          >
            {s.status || "Active"}
          </span>
        </div>
      </div>

      <div className="p-5">
        <h3 className="font-bold text-lg mb-1 truncate">{s.name}</h3>
        <p className="vm-text-muted text-xs mb-3 flex items-start gap-2">
          <i className="fas fa-map-marker-alt mt-1" aria-hidden /> <span>{s.address}</span>
        </p>

        {/* Only the fuels this station sells: a CNG-only pump shows CNG alone. */}
        <div className="grid gap-2 mb-4" style={{ gridTemplateColumns: `repeat(${Math.max(1, soldFuels(s.fuelTypes).length)}, minmax(0, 1fr))` }}>
          {soldFuels(s.fuelTypes).map((fuel) => {
            const meta = FUEL_LOOK[fuel];
            const price = prices[fuel];
            return (
              <div key={fuel} className="vm-bg-ground rounded-lg p-2 text-center">
                <p className="text-[10px] vm-text-muted font-bold">{meta.label}</p>
                <p className={`text-sm font-bold ${meta.cls}`}>{price != null && price > 0 ? `₹${price}` : "Not set"}</p>
              </div>
            );
          })}
        </div>

        <p className="text-[11px] vm-text-muted mb-4">
          <i className="fas fa-location-dot mr-1" aria-hidden /> {s.coordinates?.lat ?? "N/A"},{" "}
          {s.coordinates?.lng ?? "N/A"}
        </p>

        <div className="flex gap-2">
          <button
            onClick={onEdit}
            className="flex-1 vm-accent vm-accent-hover vm-text text-sm font-bold py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            <i className="fas fa-edit" aria-hidden /> Edit
          </button>
          {/* A real photo upload, not a URL box. The wording follows what the
              station actually has, so an admin can see which pumps still have
              no picture without opening each one. */}
          <button
            onClick={onPhotos}
            className="flex-1 vm-bg-ground vm-hover border vm-border vm-text text-sm font-bold py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            <i className={`fas ${photo ? "fa-images" : "fa-camera"}`} aria-hidden /> {photo ? "Photos" : "Add Photo"}
          </button>
          <button onClick={onToggle} className="vm-btn vm-btn-ghost vm-btn-sm" title="Toggle Status" aria-label="Toggle status">
            <i className="fas fa-power-off" aria-hidden />
          </button>
          <button
            onClick={onDelete}
            className="px-3 bg-red-600/20 text-red-400 text-sm font-bold py-2 rounded-lg transition-colors"
            title="Delete"
            aria-label="Delete station"
          >
            <i className="fas fa-trash" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
