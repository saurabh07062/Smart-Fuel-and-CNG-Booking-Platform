import { useNavigate } from "react-router-dom";
import type { Booking, UiStation } from "@/types";
import StatusBadge from "@/components/common/StatusBadge";
import { formatCurrency, fuelColors } from "@/utils/format";
import { resolveBookingStation } from "@/utils/station";
import { getVehicleIcon } from "@/utils/vehicle";
import { bookingRef, paymentState, PAYMENT_TONE_COLOR } from "@/utils/payment";

interface Props {
  booking: Booking;
  stations?: UiStation[];
  onCancel?: (id: string) => void;
}

/**
 * One booking row on the dashboard, in the console's row-list style
 * (styles/customer.css .cx-row) -- render it inside a .cx-rows container.
 *
 * Same fuel tinting as before, and the same rule that Cancel / View QR only
 * appear while the booking is still "upcoming".
 */
export default function BookingCard({ booking: b, stations = [], onCancel }: Props) {
  const navigate = useNavigate();
  const id = String(b._id ?? "");
  const st = resolveBookingStation(b, stations);
  const stationName = (b as unknown as { stationName?: string }).stationName || st.name;
  const { color, bg } = fuelColors(b.fuelType);
  const vehicle = [b.vehicleName, b.vehiclePlate].filter(Boolean).join(" · ");

  const open = () => navigate(`/confirmation/${id}`);

  return (
    <div className="cx-row" onClick={open}>
      <span className="cx-row-avatar" style={{ background: bg, color }}>
        <i className="fas fa-gas-pump" aria-hidden />
      </span>

      <div className="cx-row-main">
        <div className="flex items-center gap-2 min-w-0">
          <span className="cx-row-name">{stationName}</span>
          <StatusBadge status={b.status} />
        </div>
        <div className="cx-row-sub">
          {b.bookingDate} · {b.timeSlot} · {b.fuelType} · {b.quantity}L
        </div>
        {vehicle && (
          <div className="cx-row-sub flex items-center gap-1.5 mt-0.5">
            <i className={`fas ${getVehicleIcon(b.vehicleType || "Car")} text-[10px]`} aria-hidden />
            <span className="truncate">{vehicle}</span>
          </div>
        )}
      </div>

      <div className="cx-row-right">
        <div className="cx-row-value">{formatCurrency(b.amount ?? 0)}</div>
        <div className="cx-row-sub text-right" data-testid="booking-payment">
          <span style={{ color: PAYMENT_TONE_COLOR[paymentState(b).tone], fontWeight: 600 }}>{paymentState(b).label}</span>
          <span> · {bookingRef(b)}</span>
        </div>
        {b.status === "upcoming" && (
          <div className="flex items-center justify-end gap-3 mt-1.5">
            <button
              type="button"
              className="cx-link"
              onClick={(e) => {
                e.stopPropagation();
                open();
              }}
            >
              View QR
            </button>
            <button
              type="button"
              className="cx-link"
              style={{ color: "var(--danger)" }}
              onClick={(e) => {
                e.stopPropagation();
                onCancel?.(id);
              }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
