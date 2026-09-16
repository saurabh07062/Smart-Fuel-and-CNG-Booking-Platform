import { useState } from "react";
import type { Vehicle } from "@/types";
import Layout from "@/components/layout/Layout";
import EmptyState from "@/components/common/EmptyState";
import VehicleCard from "@/components/vehicle/VehicleCard";
import VehicleFormModal from "@/components/vehicle/VehicleFormModal";
import { useAuthStore } from "@/store/authStore";
import { pushToast } from "@/store/toastStore";
import { toApiError } from "@/services/api/apiClient";
import {
  addVehicle,
  deleteVehicle as apiDeleteVehicle,
  setDefaultVehicle as apiSetDefault,
  updateVehicle,
} from "@/services/api/customerApi";

/**
 * Port of renderMyVehicles() in js/pages/vehicles.js.
 *
 * The vehicle list lives on the User document, so the authenticated user in
 * authStore is its single source of truth here. Every mutation returns the
 * whole array (the server re-assigns `isDefault` by itself when the first
 * vehicle is added or the default is deleted), so the store is replaced from
 * the response rather than patched locally.
 */
export default function MyVehicles() {
  const user = useAuthStore((s) => s.user);
  const patchUser = useAuthStore((s) => s.patchUser);
  const vehicles = user?.vehicles ?? [];

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Vehicle | null>(null);
  const [busy, setBusy] = useState(false);

  const openAdd = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (v: Vehicle) => {
    setEditing(v);
    setModalOpen(true);
  };

  const run = async (fn: () => Promise<Vehicle[]>, successMsg: string) => {
    setBusy(true);
    try {
      const next = await fn();
      patchUser({ vehicles: next });
      pushToast(successMsg, "success");
      return true;
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = async (fields: Partial<Vehicle>, file: File | null) => {
    const id = editing?._id ? String(editing._id) : null;
    const ok = await run(
      () => (id ? updateVehicle(id, fields, file) : addVehicle(fields, file)),
      id ? "Vehicle updated" : "Vehicle added",
    );
    if (ok) setModalOpen(false);
  };

  const onDelete = (id: string) => {
    if (!window.confirm("Delete this vehicle?")) return;
    void run(() => apiDeleteVehicle(id), "Vehicle deleted");
  };

  const onSetDefault = (id: string) => {
    void run(() => apiSetDefault(id), "Default vehicle updated");
  };

  return (
    <Layout>
      <div className="cx-page-head">
        <div className="min-w-0">
          <h1 className="cx-title">My Vehicles</h1>
          <p className="cx-subtitle">
            {vehicles.length
              ? `${vehicles.length} vehicle${vehicles.length > 1 ? "s" : ""} saved · the default is preselected when you book`
              : "Save a vehicle to book fuel slots faster"}
          </p>
        </div>
        <div className="cx-actions">
          <button className="btn btn-primary" onClick={openAdd}>
            <i className="fas fa-plus" aria-hidden /> Add Vehicle
          </button>
        </div>
      </div>

      {vehicles.length === 0 ? (
        <section className="cx-panel">
          <EmptyState
            icon="fa-car-side"
            title="No vehicles saved yet"
            subtitle="Add your car, bike, or any other vehicle once — then reuse it for every booking without retyping the details."
            action={
              <button className="btn btn-primary btn-sm" onClick={openAdd}>
                <i className="fas fa-plus" aria-hidden /> Add Your First Vehicle
              </button>
            }
          />
        </section>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {vehicles.map((v) => (
            <VehicleCard
              key={String(v._id)}
              vehicle={v}
              busy={busy}
              onEdit={openEdit}
              onDelete={onDelete}
              onSetDefault={onSetDefault}
            />
          ))}
        </div>
      )}

      <VehicleFormModal
        open={modalOpen}
        vehicle={editing}
        saving={busy}
        onClose={() => setModalOpen(false)}
        onSubmit={onSubmit}
      />
    </Layout>
  );
}
