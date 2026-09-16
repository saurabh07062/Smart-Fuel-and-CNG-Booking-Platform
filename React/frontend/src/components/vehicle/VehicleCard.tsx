import { useNavigate } from "react-router-dom";
import type { Vehicle } from "@/types";
import VehicleArt from "@/components/vehicle/VehicleArt";
import { vehicleDisplayName } from "@/utils/vehicle";

interface Props {
  vehicle: Vehicle;
  onEdit: (v: Vehicle) => void;
  onDelete: (id: string) => void;
  onSetDefault: (id: string) => void;
  busy?: boolean;
}

/**
 * One saved vehicle.
 *
 * "Book with this" is the primary action because it is why a vehicle is
 * saved at all; edit, set-default and delete are secondary and grouped as
 * icon buttons. "Set default" disappears once the vehicle already is the
 * default, as before. A broken photo falls back to the type illustration
 * (VehicleArt handles that).
 */
export default function VehicleCard({ vehicle: v, onEdit, onDelete, onSetDefault, busy }: Props) {
  const navigate = useNavigate();

  const id = String(v._id ?? "");
  const type = v.vehicleType || "Car";
  const fuel = v.fuelType || "Petrol";
  const reg = v.registrationNumber || "—";
  const subtitle = [v.brand, v.model].filter(Boolean).join(" ");
  const fuelTag = fuel === "CNG" ? "is-green" : fuel === "Diesel" ? "is-amber" : "is-blue";

  return (
    <article className={`cx-panel cx-vehicle flex flex-col ${v.isDefault ? "is-default" : ""}`}>
      <div className="cx-panel-body flex-1">
        <div className="flex items-start gap-3">
          <VehicleArt type={type} image={v.image} size={60} radius={14} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="cx-row-name" style={{ fontSize: 15 }}>
                {vehicleDisplayName(v)}
              </h3>
              {v.isDefault && (
                <span className="cx-tag is-blue flex-shrink-0">
                  <i className="fas fa-star" aria-hidden /> Default
                </span>
              )}
            </div>
            <p className="cx-row-sub">{subtitle || `${type} · ${fuel}`}</p>
            <span className="cx-plate mt-2">{reg}</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 mt-4">
          <span className="cx-tag is-neutral">{type}</span>
          <span className={`cx-tag ${fuelTag}`}>{fuel}</span>
          {v.color && <span className="cx-tag is-neutral">{v.color}</span>}
        </div>
      </div>

      <div className="cx-panel-foot flex items-center gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm flex-1"
          onClick={() => navigate(`/booking?vehicleId=${id}&vehiclePlate=${encodeURIComponent(reg)}`)}
        >
          <i className="fas fa-calendar-check" aria-hidden /> Book with This
        </button>
        {!v.isDefault && (
          <button
            type="button"
            className="cx-icon-btn is-sm"
            onClick={() => onSetDefault(id)}
            disabled={busy}
            title="Set as default"
            aria-label="Set as default"
          >
            <i className="far fa-star" aria-hidden />
          </button>
        )}
        <button
          type="button"
          className="cx-icon-btn is-sm"
          onClick={() => onEdit(v)}
          disabled={busy}
          title="Edit"
          aria-label="Edit vehicle"
        >
          <i className="fas fa-pen" aria-hidden />
        </button>
        <button
          type="button"
          className="cx-icon-btn is-sm is-danger"
          onClick={() => onDelete(id)}
          disabled={busy}
          title="Delete"
          aria-label="Delete vehicle"
        >
          <i className="fas fa-trash" aria-hidden />
        </button>
      </div>
    </article>
  );
}
