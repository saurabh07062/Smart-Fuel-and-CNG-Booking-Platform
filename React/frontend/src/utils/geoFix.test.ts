import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFreshUserCoords } from "./geo";

type Success = (p: GeolocationPosition) => void;
type Failure = (e: GeolocationPositionError) => void;

const reading = (lat: number, lng: number, accuracy: number) =>
  ({ coords: { latitude: lat, longitude: lng, accuracy }, timestamp: Date.now() }) as GeolocationPosition;

let onSuccess: Success;
let onError: Failure;
let options: PositionOptions | undefined;
const clearWatch = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  clearWatch.mockClear();
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      watchPosition: (ok: Success, err: Failure, opts?: PositionOptions) => {
        onSuccess = ok;
        onError = err;
        options = opts;
        return 7;
      },
      clearWatch,
    },
  });
});
afterEach(() => vi.useRealTimers());

describe("getFreshUserCoords: GPS fix", () => {
  it("asks for high accuracy (GPS) and never a cached position", () => {
    void getFreshUserCoords();
    expect(options).toMatchObject({ enableHighAccuracy: true, maximumAge: 0 });
  });

  it("keeps the most accurate reading and stops once it is GPS quality", async () => {
    const fix = getFreshUserCoords();
    onSuccess(reading(18.60, 73.78, 1500)); // coarse network estimate first
    onSuccess(reading(18.5723, 73.9872, 60));
    onSuccess(reading(18.57229, 73.98719, 12)); // GPS lock
    await expect(fix).resolves.toMatchObject({ lat: 18.57229, lng: 73.98719, accuracy: 12 });
    expect(clearWatch).toHaveBeenCalledWith(7);
  });

  it("without a GPS lock, returns the best reading when time is up", async () => {
    const fix = getFreshUserCoords({ timeout: 5000 });
    onSuccess(reading(18.60, 73.78, 1500));
    onSuccess(reading(18.58, 73.98, 400));
    vi.advanceTimersByTime(5000);
    await expect(fix).resolves.toMatchObject({ lat: 18.58, lng: 73.98, accuracy: 400 });
  });

  it("denied: resolves null", async () => {
    const fix = getFreshUserCoords();
    onError({ code: 1 } as GeolocationPositionError);
    await expect(fix).resolves.toBeNull();
  });
});
