import { useEffect, useRef, useState } from "react";
import { searchPlaces, type PlaceMatch } from "@/services/api/stationApi";
import { toApiError } from "@/services/api/apiClient";

/**
 * "Where are you?", typed instead of measured.
 *
 * The way a customer sets their location when the device cannot or may not
 * give a fix: permission refused, no signal indoors, a laptop with no GPS.
 * The map is still there and still works; this is simply faster on a phone.
 *
 * The lookup is the SERVER's (backend routes/discoveryRoutes.js search-place),
 * so no third-party key ships in this bundle. Nothing here invents a place: an
 * empty answer is shown as an empty answer, with the map offered instead.
 */
export default function PlaceSearchPanel({
  onPicked,
  onUseMap,
  autoFocus = false,
}: {
  /** The chosen point, ready to become the session's location. */
  onPicked: (place: PlaceMatch) => void;
  /** Escape hatch: set it on the map instead. */
  onUseMap?: () => void;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceMatch[] | null>(null);
  const [state, setState] = useState<"idle" | "searching" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  /**
   * Search as they type, but not on every keystroke.
   *
   * 400 ms after they stop: the lookup reaches a free external service
   * through our server, and a request per character would be both slow for
   * the customer and rude to that service (it is rate-limited on both sides).
   * The effect's cleanup cancels a pending search, and `live` stops a slow
   * answer from overwriting a newer one.
   */
  useEffect(() => {
    const text = query.trim();
    if (text.length < 3) {
      setResults(null);
      setState("idle");
      setError(null);
      return;
    }

    let live = true;
    setState("searching");
    setError(null);
    const timer = window.setTimeout(async () => {
      try {
        const found = await searchPlaces(text);
        if (!live) return;
        setResults(found);
        setState("idle");
      } catch (err) {
        if (!live) return;
        // A network or server failure is NOT "no such place": say which it
        // was, or the customer retypes a perfectly good address.
        setError(toApiError(err).msg || "Could not search just now.");
        setResults(null);
        setState("error");
      }
    }, 400);

    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="cx-place" data-testid="place-search">
      <label htmlFor="place-search-input" className="cx-place-label">
        Search for your area, landmark or city
      </label>
      <div className="cx-place-field">
        <i className="fas fa-magnifying-glass" aria-hidden />
        <input
          id="place-search-input"
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. Baner Road, Pune"
          autoComplete="off"
          maxLength={120}
          aria-describedby="place-search-help"
        />
        {query && (
          <button type="button" className="cx-place-clear" onClick={() => setQuery("")} aria-label="Clear search">
            <i className="fas fa-xmark" aria-hidden />
          </button>
        )}
      </div>

      <p id="place-search-help" className="cx-place-help">
        {state === "searching"
          ? "Searching…"
          : query.trim().length > 0 && query.trim().length < 3
            ? "Type at least three characters."
            : "We use this only to find pumps near you."}
      </p>

      {state === "error" && error && (
        <p className="cx-place-error" role="alert">
          <i className="fas fa-triangle-exclamation" aria-hidden /> {error}
        </p>
      )}

      {results !== null && results.length === 0 && state === "idle" && (
        <p className="cx-place-empty" data-testid="place-search-empty">
          No place matched “{query.trim()}”. Try a different spelling{onUseMap ? ", or set it on the map" : ""}.
        </p>
      )}

      {results !== null && results.length > 0 && (
        <ul className="cx-place-results" aria-label="Matching places">
          {results.map((place) => (
            <li key={`${place.lat},${place.lng},${place.label}`}>
              <button type="button" className="cx-place-result" onClick={() => onPicked(place)}>
                <i className="fas fa-location-dot" aria-hidden />
                <span>
                  <strong>{place.name || place.label}</strong>
                  <small>{place.label}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {onUseMap && (
        <button type="button" className="cx-place-map" onClick={onUseMap}>
          <i className="fas fa-map-location-dot" aria-hidden /> Pick it on the map instead
        </button>
      )}
    </div>
  );
}
