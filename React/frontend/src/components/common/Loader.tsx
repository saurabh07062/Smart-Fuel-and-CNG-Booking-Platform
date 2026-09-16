interface Props {
  label?: string;
  /** Fill the viewport, for a first page load. */
  full?: boolean;
}

/** Matches the Vanilla loading treatment: spinner over the app background. */
export default function Loader({ label = "Loading…", full = false }: Props) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3"
      style={{
        minHeight: full ? "60vh" : "180px",
        color: "var(--muted)",
      }}
      role="status"
      aria-live="polite"
    >
      <i className="fas fa-spinner fa-spin text-3xl" style={{ color: "var(--primary)" }} />
      <p className="text-sm">{label}</p>
    </div>
  );
}
