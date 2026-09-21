/**
 * The fuel icons of the Stations filter: a pump for "all", a green drop for
 * petrol, a nozzle with a drop for diesel, a blue gas cylinder with a flame
 * for CNG. Inline SVG, so they are crisp at any size and need no icon font.
 */
export type FuelIconKind = "all" | "petrol" | "diesel" | "cng";

export default function FuelIcon({ kind, size = 24 }: { kind: FuelIconKind; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true } as const;

  if (kind === "petrol") {
    return (
      <svg {...common}>
        <path d="M12 2.5c-.3 0-.6.2-.8.5C9.4 5.6 5.5 10.6 5.5 14.6a6.5 6.5 0 0 0 13 0c0-4-3.9-9-5.7-11.6-.2-.3-.5-.5-.8-.5z" fill="#22c55e" />
        <path d="M12 2.5c.3 0 .6.2.8.5 1.8 2.6 5.7 7.6 5.7 11.6a6.5 6.5 0 0 1-6.5 6.5z" fill="#16a34a" />
        <path d="M8.6 14.4a3.6 3.6 0 0 0 2.3 3.4" stroke="#dcfce7" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      </svg>
    );
  }

  if (kind === "diesel") {
    return (
      <svg {...common}>
        {/* nozzle */}
        <path
          d="M3.2 20.4l2.6-4.6 1.6-.4 3.8-3.9c.5-.5 1.2-.7 1.9-.6l2.2.4 1.5-1.5c.3-.3.8-.3 1.1 0l.5.5-2.2 2.2.1 1.1c.1.6-.1 1.2-.5 1.6l-3.1 3.1-2.5-.2-1.9 1.9-1.4-.3-1.2 1.2z"
          fill="currentColor"
        />
        <path d="M16.5 5.2c.7-.9 2.3-1.3 3.3-.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        {/* drop */}
        <path d="M20 8.2c-.1 0-.2.1-.3.2-.5.8-1.4 2-1.4 2.9a1.7 1.7 0 0 0 3.4 0c0-.9-.9-2.1-1.4-2.9-.1-.1-.2-.2-.3-.2z" fill="currentColor" />
      </svg>
    );
  }

  if (kind === "cng") {
    return (
      <svg {...common}>
        {/* cylinder */}
        <rect x="9" y="1.5" width="6" height="2" rx=".8" fill="#3b82f6" />
        <rect x="10.2" y="3.2" width="3.6" height="1.6" fill="#2563eb" />
        <rect x="5.5" y="4.5" width="13" height="17" rx="4.5" fill="#2f6fed" />
        <rect x="8" y="21" width="8" height="1.8" rx=".8" fill="#2563eb" />
        {/* flame */}
        <path
          d="M12.3 8.2c.2 1.5-1 2.2-1.8 3.3-.7.9-1.1 1.8-1.1 2.8a2.7 2.7 0 0 0 5.4.2c.1-1.1-.4-2-.9-2.6.1.9-.3 1.5-.8 1.7.3-1.6-.2-4.1-.8-5.4z"
          fill="#ffffff"
        />
      </svg>
    );
  }

  // all stations: a fuel pump
  return (
    <svg {...common}>
      <path d="M5.5 2.5h8a1.5 1.5 0 0 1 1.5 1.5v16.5H4V4a1.5 1.5 0 0 1 1.5-1.5z" fill="currentColor" />
      <rect x="6" y="4.5" width="7" height="5" rx=".8" fill="var(--card)" />
      <rect x="3" y="19.5" width="13" height="2.2" rx="1" fill="currentColor" />
      <path
        d="M15 8.5h1.3a1.5 1.5 0 0 1 1.5 1.5v6.2a1.3 1.3 0 0 0 2.6 0V8.6l-2.3-2.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
