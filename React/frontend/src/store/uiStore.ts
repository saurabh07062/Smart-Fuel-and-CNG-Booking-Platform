import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UiState {
  darkMode: boolean;
  toggleTheme: () => void;
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

      profileMenuOpen: false,
      setProfileMenuOpen: (profileMenuOpen) => set({ profileMenuOpen }),
    }),
    {
      name: "fm-ui",
      partialize: (s) => ({ darkMode: s.darkMode }),
      // Re-stamp the attribute on rehydrate. Without this a reload shows the
      // light palette while the store still says dark.
      onRehydrateStorage: () => (state) => {
        document.documentElement.setAttribute(
          "data-theme",
          state?.darkMode ? "dark" : "light",
        );
      },
    },
  ),
);
