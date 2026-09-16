import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Layout from "@/components/layout/Layout";
import EmptyState from "@/components/common/EmptyState";
import PumpCard from "@/components/station/PumpCard";
import { useLocationStore } from "@/store/locationStore";

/**
 * Port of renderNearestPump() in js/pages/nearestPump.js.
 *
 * Reached only after the dashboard's search succeeds. This page owns
 * DISPLAYING the prediction; the dashboard only collects location + fuel type
 * and hands the already-fetched result over.
 *
 * It does not re-run the search. The result is read from the store, falling
 * back to the last saved one so a refresh or a bookmark on this URL does not
 * strand the user on an empty page.
 */
export default function NearestPump() {
  const navigate = useNavigate();
  const result = useLocationStore((s) => s.result);
  const hydrateResult = useLocationStore((s) => s.hydrateResult);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!result) hydrateResult();
    setChecked(true);
  }, [result, hydrateResult]);

  const stations = result?.stations ?? [];

  // `checked` keeps the "No recent search" card from flashing for one frame
  // before localStorage has been consulted.
  if (checked && stations.length === 0) {
    return (
      <Layout>
        <div className="max-w-xl mx-auto pt-4 md:pt-10">
          <section className="cx-panel">
            <EmptyState
              icon="fa-map-location-dot"
              title="No recent search"
              subtitle="Use your location from the dashboard to find the nearest station."
              action={
                <button className="btn btn-primary btn-sm" onClick={() => navigate("/dashboard")}>
                  Back to Dashboard
                </button>
              }
            />
          </section>
        </div>
      </Layout>
    );
  }

  if (!result) return null;

  const { fuelType } = result;
  const fuelLabel = fuelType.charAt(0).toUpperCase() + fuelType.slice(1).toLowerCase();
  const nearest = stations[0];
  const others = stations.slice(1);

  return (
    <Layout>
      <div className="max-w-5xl mx-auto">
        <button type="button" className="cx-back" onClick={() => navigate("/dashboard")}>
          <i className="fas fa-arrow-left" aria-hidden /> Back to Dashboard
        </button>

        <div className="cx-page-head">
          <div className="min-w-0">
            <h1 className="cx-title">Nearest {fuelLabel} stations</h1>
            <p className="cx-subtitle">Stations you can book come first, ranked on distance, queue wait and price together.</p>
          </div>
          <span className="cx-live">Live availability</span>
        </div>

        <p className="cx-eyebrow mb-2 flex items-center gap-1.5">
          <i className="fas fa-star" style={{ color: "var(--accent)" }} aria-hidden /> Best match for you
        </p>
        <PumpCard station={nearest} fuelType={fuelType} isPrimary />

        {others.length > 0 && (
          <>
            <h2 className="cx-section-title mt-8 mb-3">Other nearby stations</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {others.map((st) => (
                <PumpCard key={st.stationId} station={st} fuelType={fuelType} />
              ))}
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
