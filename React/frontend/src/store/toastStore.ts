import { create } from "zustand";

export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastState {
  toasts: Toast[];
  push: (message: string, type?: ToastType) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

/**
 * Toasts, replacing the global `toast()` in js/utils.js.
 *
 * That function appended straight to #toast-container and removed the node on
 * a timer -- fine in a DOM-mutating app, but it would fight React's ownership
 * of the tree. A store keeps the same call ergonomics (`pushToast("Saved",
 * "success")` from anywhere, including non-component code) while React does
 * the rendering.
 */
export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  push: (message, type = "info") => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    // Same 3.5s as the Vanilla version.
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 3500);
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Callable outside React -- services, socket handlers, axios interceptors. */
export const pushToast = (message: string, type: ToastType = "info") =>
  useToastStore.getState().push(message, type);
