/**
 * Frontend dev server against the TEST backend (port 5055, database
 * fuelmart_test), on port 3002 so it can run beside the normal one on 3001.
 *
 * Start the test API first: npm --prefix React/backend run test:server
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const child = spawn("npx vite --port 3002 --strictPort", {
  cwd,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, FUELMART_API_TARGET: process.env.FUELMART_API_TARGET || "http://127.0.0.1:5055" },
});
child.on("exit", (code) => process.exit(code ?? 0));
