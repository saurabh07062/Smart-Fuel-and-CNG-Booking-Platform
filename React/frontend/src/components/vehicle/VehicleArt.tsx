import { useEffect, useState } from "react";
import { uploadUrl } from "@/services/api/apiClient";
import { vehicleArtKind, type VehicleArtKind } from "@/utils/vehicle";

interface Props {
  type?: string | null;
  /** A saved vehicle's uploaded photo. Falls back to the illustration if it fails. */
  image?: string | null;
  size?: number;
  radius?: number;
  className?: string;
}

/**
 * The picture shown for a vehicle: its uploaded photo when there is one,
 * otherwise a tinted illustration matched to the type (car / bike / other).
 *
 * Drawn with currentColor, so the tint comes from the .cx-art.k-* class and
 * follows the theme without per-mode SVGs.
 */
export default function VehicleArt({ type, image, size = 44, radius = 12, className = "" }: Props) {
  const kind = vehicleArtKind(type);
  const photo = uploadUrl(image ?? undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [photo]);

  return (
    <span
      className={`cx-art k-${kind} ${className}`}
      style={{ width: size, height: size, borderRadius: radius }}
      aria-hidden
    >
      {photo && !failed ? (
        <img src={photo} alt="" onError={() => setFailed(true)} />
      ) : (
        <Illustration kind={kind} />
      )}
    </span>
  );
}

function Wheel({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  return (
    <>
      <circle cx={cx} cy={cy} r={r} fill="var(--card)" stroke="currentColor" strokeWidth="2.5" />
      <circle cx={cx} cy={cy} r={r * 0.36} fill="currentColor" />
    </>
  );
}

function Illustration({ kind }: { kind: VehicleArtKind }) {
  if (kind === "bike") {
    return (
      <svg viewBox="0 0 64 40" fill="none">
        <path
          d="M15 29 25 18h13l4 5"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M24 16.5h13.5l5.5 6H29.5Z" fill="currentColor" fillOpacity=".35" />
        <path d="M18 15h9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        <path
          d="M49 29 43 13.5M40 11.5h6.5"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M29.5 22.5 33 29h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <Wheel cx={15} cy={29} r={7.5} />
        <Wheel cx={49} cy={29} r={7.5} />
      </svg>
    );
  }

  if (kind === "other") {
    return (
      <svg viewBox="0 0 64 40" fill="none">
        <rect
          x="5"
          y="8"
          width="33"
          height="20"
          rx="2.5"
          fill="currentColor"
          fillOpacity=".16"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M38 14h10.5l8.5 7.5V28H38Z"
          fill="currentColor"
          fillOpacity=".16"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="M41.5 17.5h6l4.5 4H41.5Z" fill="currentColor" fillOpacity=".4" />
        <Wheel cx={16} cy={29} r={5} />
        <Wheel cx={47} cy={29} r={5} />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 64 40" fill="none">
      <path
        d="M6 27v-6.4a3 3 0 0 1 2.2-2.9l8.8-2.3 6.3-6.5a5 5 0 0 1 3.6-1.5h11.7a5 5 0 0 1 3.7 1.6l6.5 6.7 8.1 2a3 3 0 0 1 2.3 2.9V27a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2Z"
        fill="currentColor"
        fillOpacity=".16"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="m20.5 15.8 4.9-5a3 3 0 0 1 2.1-.9H31v5.9Zm13.5 0V9.9h4.2a3 3 0 0 1 2.2.9l4.8 5Z"
        fill="currentColor"
        fillOpacity=".4"
      />
      <Wheel cx={18} cy={29} r={5} />
      <Wheel cx={46} cy={29} r={5} />
    </svg>
  );
}
