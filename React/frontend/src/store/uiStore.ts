import { create } from "zustand";
import { persist } from "zustand/middleware";

/** The customer app's accent colour. */
export type Accent = "red" | "green";

/** Stamp the accent on <html>; styles/customer.css re-points --primary for "green". */
function applyAccent(accent: Accent) {
  document.documentElement.setAttribute("data-accent", accent);
}

interface UiState {
  darkMode: boolean;
  toggleTheme: () => void;
  accent: Accent;
  setAccent: (accent: Accent) => void;
  profileMenuOpen: boolean;
  setProfileMenuOpen: (open: boolean) => void;
}

/**
 * Theme and small UI flags.
 *
 * The theme is applied by stamping data-theme on <html>, exactly as the
 * Vanilla toggleTheme() did -- css/variables.css keys its dark palette off
 * that attribute, so reusing the mechanism is what keeps both themes correct
 * without duplicating a single colour.
 */
export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      darkMode: false,

      toggleTheme: () => {
        const next = !get().darkMode;
        document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
        set({ darkMode: next });
      },

      accent: "red",
      setAccent: (accent) => {
        applyAccent(accent);
        set({ accent });
      },

      profileMenuOpen: false,
      setProfileMenuOpen: (profileMenuOpen) => set({ profileMenuOpen }),
    }),
    {
      name: "fm-ui",
      partialize: (s) => ({ darkMode: s.darkMode, accent: s.accent }),
      // Re-stamp the attribute on rehydrate. Without this a reload shows the
      // light palette while the store still says dark.
      onRehydrateStorage: () => (state) => {
        document.documentElement.setAttribute(
          "data-theme",
          state?.darkMode ? "dark" : "light",
        );
        applyAccent(state?.accent === "green" ? "green" : "red");
      },
    },
  ),
);
