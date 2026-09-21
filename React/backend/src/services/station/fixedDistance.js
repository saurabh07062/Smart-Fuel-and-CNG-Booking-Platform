/**
 * TEMPORARY (demo): fixed distances for stations, read from
 * data/fixedDistances.json -- the Google Maps driving distance from one origin
 * (G.H. Raisoni College, Wagholi) to each station, measured by hand.
 *
 * Where a station has an entry, customers see that distance ("by road
 * (Google Maps)") instead of the computed one, whatever their location.
 * Stations without an entry keep the computed road distance
 * (services/station/roadDistance.js).
 *
 *   FIXED_DISTANCES=off        ignore the file (live road distances everywhere)
 *   FIXED_DISTANCES_FILE=path  a different file
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "..", "..", "..", "data", "fixedDistances.json");

let cached = null; // { file, mtimeMs, byId }

function load(env = process.env) {
  if (String(env.FIXED_DISTANCES ?? "").trim().toLowerCase() === "off") return null;
  const file = env.FIXED_DISTANCES_FILE || DEFAULT_FILE;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null; // no file: nothing fixed
  }
  // Re-read when the file changes, so an edit needs no restart.
  if (cached && cached.file === file && cached.mtimeMs === stat.mtimeMs) return cached.byId;
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const byId = new Map();
    for (const [id, v] of Object.entries(json?.stations || {})) {
      const km = Number(v?.km);
      if (Number.isFinite(km) && km >= 0) byId.set(String(id), { km, minutes: Number.isFinite(Number(v?.minutes)) ? Number(v.minutes) : null });
    }
    cached = { file, mtimeMs: stat.mtimeMs, byId };
    return byId;
  } catch (err) {
    console.error("[fixedDistance] could not read", file, err.message);
    return null;
  }
}

/** The fixed distance for one station, or null. */
function fixedDistanceFor(stationId, env) {
  const byId = load(env);
  return byId?.get(String(stationId)) ?? null;
}

module.exports = { fixedDistanceFor, DEFAULT_FILE };
