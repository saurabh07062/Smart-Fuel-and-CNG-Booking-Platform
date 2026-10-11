import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import { IS_NATIVE_BUILD } from "./services/api/serverAddress";
import App from "./App";
import ErrorBoundary from "./components/common/ErrorBoundary";
import "./index.css";

/**
 * BrowserRouter, not HashRouter.
 *
 * The Vanilla app routes on the hash (`#stations`) because it is served as
 * static files with no rewrite rule. Vite's dev server and any production
 * host with an SPA fallback handle real paths, and real paths are what the
 * approval email already links to (/vendor/secret-code). A production host
 * must therefore serve index.html for unknown paths (SPA fallback).
 */
// The bundled build is an app, not a page: styles/customer.css keys its
// phone behaviour (safe areas, tap targets, no text selection on chrome)
// off this class, and the website never carries it.
if (IS_NATIVE_BUILD) document.documentElement.classList.add("is-app");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* "/app" in the customer app build (vite.config.ts base), "/" on the website. */}
    {/* A crash inside any screen shows a message with a way out, instead of
        unmounting everything and leaving a blank page -- a white WebView in
        the Android app, where there is no console to look at. */}
    <ErrorBoundary>
      {/*
        The Android app's pages are files inside the APK: there is no server
        to rewrite /dashboard to index.html, so it routes on the hash. The
        website keeps real paths.
      */}
      {IS_NATIVE_BUILD ? (
        <HashRouter>
          <App />
        </HashRouter>
      ) : (
        <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "") || undefined}>
          <App />
        </BrowserRouter>
      )}
    </ErrorBoundary>
  </React.StrictMode>,
);
