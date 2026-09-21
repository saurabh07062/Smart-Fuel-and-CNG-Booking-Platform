/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "customer" in the customer app build (npm run build:customer); unset for the website. */
  readonly VITE_APP_MODE?: "customer";
}
