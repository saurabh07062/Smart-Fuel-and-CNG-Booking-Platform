import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The last line of defence against a blank screen.
 *
 * When a render throws, React unmounts the whole tree -- in the browser that
 * leaves an empty page, and in the Android app a white WebView with no way
 * back. There is no console to look at on a phone, so the failure has to
 * explain itself on screen and offer the two things that actually help:
 * reload, or go to the dashboard.
 *
 * It catches render, lifecycle and constructor errors. It cannot catch an
 * error inside an event handler or a rejected promise -- those do not unmount
 * the tree, and the pages report them through toasts.
 */
interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept for `adb logcat` / the browser console: the screen shows the
    // message, the log keeps the component stack that locates it.
    console.error("[FuelMart] a screen failed to render:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--bg, #0b0f14)",
          color: "var(--text, #e6edf3)",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }} aria-hidden>
            ⛽
          </div>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>This screen could not open</h1>
          <p style={{ fontSize: 13, opacity: 0.75, marginBottom: 18 }}>
            Something went wrong while showing this page. Your booking and your account are unaffected.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                background: "var(--primary, #22c55e)",
                color: "#fff",
                border: 0,
                borderRadius: 12,
                padding: "10px 18px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Reload
            </button>
            <button
              type="button"
              onClick={() => {
                // A full load, not a router push: the tree that crashed is gone.
                window.location.href = `${import.meta.env.BASE_URL}dashboard`.replace("//dashboard", "/dashboard");
              }}
              style={{
                background: "transparent",
                color: "inherit",
                border: "1px solid rgba(255,255,255,0.25)",
                borderRadius: 12,
                padding: "10px 18px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Go to dashboard
            </button>
          </div>
          <p style={{ fontSize: 11, opacity: 0.5, marginTop: 16, wordBreak: "break-word" }}>{error.message}</p>
        </div>
      </div>
    );
  }
}
