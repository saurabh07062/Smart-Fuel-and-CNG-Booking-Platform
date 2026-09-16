import { useSocketConnection } from "@/hooks/useSocket";
import { useRealtimeSync } from "@/hooks/useRealtimeSync";
import { useSessionKeepAlive } from "@/hooks/useSessionKeepAlive";
import ConnectionStatus from "@/components/common/ConnectionStatus";
import ToastHost from "@/components/common/ToastHost";
import AppRoutes from "@/routes/AppRoutes";

/**
 * App root: app-wide realtime wiring, global overlays (connection status,
 * toasts) and the route table.
 */
export default function App() {
  useSocketConnection();
  // One subscription set for the whole session. Mounted here rather than per
  // page so a booking or price event lands wherever the user happens to be.
  useRealtimeSync();
  // Keeps the 15-minute session cookie fresh for socket reconnects.
  useSessionKeepAlive();

  return (
    <>
      <ConnectionStatus />
      <ToastHost />
      <AppRoutes />
    </>
  );
}
