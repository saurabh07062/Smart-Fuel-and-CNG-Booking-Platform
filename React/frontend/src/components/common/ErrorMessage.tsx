import Button from "./Button";

interface Props {
  message: string;
  onRetry?: () => void;
}

export default function ErrorMessage({ message, onRetry }: Props) {
  return (
    <div
      className="card p-5 flex items-start gap-3"
      style={{ borderColor: "var(--danger)", background: "var(--danger-light)" }}
      role="alert"
    >
      <i
        className="fas fa-triangle-exclamation mt-0.5"
        style={{ color: "var(--danger)" }}
        aria-hidden
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium" style={{ color: "var(--danger)" }}>
          {message}
        </p>
        {onRetry && (
          <div className="mt-3">
            <Button variant="outline" size="sm" icon="fa-rotate" onClick={onRetry}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
