import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

/**
 * Component tests (npm test). Same "@/..." alias and React plugin as the app
 * build (vite.config.ts), rendered in jsdom. API modules are mocked in each
 * test: nothing here talks to a server or a database.
 */
export default defineConfig((env) => mergeConfig(
  viteConfig(env),
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
    },
  }),
));
