import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount every rendered tree and forget stored state between tests.
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
