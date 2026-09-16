import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "accent" | "outline" | "ghost";
type Size = "sm" | "md" | "lg";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  loading?: boolean;
  icon?: string;
  children?: ReactNode;
}

/**
 * The app's button.
 *
 * Every class here (.btn, .btn-primary, .btn-sm, .btn-block) already exists
 * in css/components.css and is used verbatim -- so a migrated button is
 * pixel-identical to the Vanilla one rather than a Tailwind re-creation of it.
 *
 * `loading` is the one addition: the Vanilla code did this by hand at each
 * call site, saving and restoring innerHTML around a fetch, which is where
 * the "button stays disabled forever after an error" bug came from.
 */
export default function Button({
  variant = "primary",
  size = "md",
  block = false,
  loading = false,
  icon,
  children,
  className = "",
  disabled,
  ...rest
}: Props) {
  const classes = [
    "btn",
    `btn-${variant}`,
    size !== "md" ? `btn-${size}` : "",
    block ? "btn-block" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button className={classes} disabled={disabled || loading} {...rest}>
      {loading ? (
        <i className="fas fa-spinner fa-spin" aria-hidden />
      ) : icon ? (
        <i className={`fas ${icon}`} aria-hidden />
      ) : null}
      {children}
    </button>
  );
}
