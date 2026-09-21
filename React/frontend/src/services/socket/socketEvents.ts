/**
 * Event names, mirroring backend/src/services/notification/realtime.js EVENTS.
 *
 * These are the CANONICAL names only. The backend also emits a legacy alias
 * for each ("booking_updated" beside "booking:updated") so that a browser
 * with a cached Vanilla bundle keeps working during the rollout -- but this
 * client must bind to one name per event, or every change would be handled
 * twice.
 */
export const SOCKET_EVENTS = {
  FUEL_PRICE_UPDATED: "fuelPrice:updated",
  FUEL_AVAILABILITY_UPDATED: "fuelAvailability:updated",
  STATION_STATUS_UPDATED: "station:statusChanged",
  STATION_CREATED: "station:created",
  STATION_UPDATED: "station:updated",
  STATION_DELETED: "station:deleted",
  BOOKING_CREATED: "booking:created",
  BOOKING_UPDATED: "booking:updated",
  BOOKING_CANCELLED: "booking:cancelled",
  BOOKING_COMPLETED: "booking:completed",
  QUEUE_UPDATED: "queue:updated",
  SLOT_UPDATED: "slot:updated",
  INVENTORY_UPDATED: "inventory:updated",
  /** Admins: a new vendor application { vendorId, name, businessName, vendorStatus }. */
  VENDOR_REQUEST_CREATED: "vendor:requestCreated",
  VENDOR_APPROVED: "vendor:approved",
  VENDOR_STATUS_CHANGED: "vendor:statusChanged",
  NOTIFICATION_CREATED: "notification:created",
  /** Addressed to one customer: { bookingId, position, etaMinutes } (services/queue/stationQueue.js). */
  ETA_UPDATE: "eta_update",
} as const;

export type SocketEvent = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];
