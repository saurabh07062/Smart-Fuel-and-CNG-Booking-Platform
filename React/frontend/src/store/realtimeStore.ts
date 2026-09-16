import { create } from "zustand";

interface RealtimeState {
  connected: boolean;
  /** False until the first successful connect, so "Reconnecting…" is not
   *  shown on a machine that has never connected. */
  everConnected: boolean;
  setConnected: (connected: boolean) => void;
}

export const useRealtimeStore = create<RealtimeState>((set) => ({
  connected: false,
  everConnected: false,
  setConnected: (connected) =>
    set((s) => ({ connected, everConnected: s.everConnected || connected })),
}));
