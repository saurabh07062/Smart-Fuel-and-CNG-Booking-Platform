import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
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
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
