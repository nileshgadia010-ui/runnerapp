// Distance between two coordinates in metres.
function distanceM(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(v => typeof v !== 'number' || isNaN(v))) return null;
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Road distance is always longer than the straight line. 1.35 is a reasonable multiplier
// for Indian city roads and keeps the estimate honest without calling a paid routing API.
const ROAD_FACTOR = 1.35;

function roadKm(lat1, lng1, lat2, lng2) {
  const m = distanceM(lat1, lng1, lat2, lng2);
  if (m === null) return null;
  return Math.round((m / 1000) * ROAD_FACTOR * 10) / 10;
}

// Rough riding time in minutes at typical city speed, with a floor so a 200 m hop
// does not show as "0 min".
function etaMinutes(km, kmph = 22) {
  if (km === null || km === undefined) return null;
  return Math.max(2, Math.round((km / kmph) * 60));
}

/* ==========================================================================
   Turning a stream of GPS fixes into a journey
   --------------------------------------------------------------------------
   A phone that is standing still does not report the same point twice. Every
   fix lands a few metres from the last one, and indoors that wander can be
   fifty metres or more. The old sum simply added every hop under 3 km, so a
   runner sitting at his desk for four minutes was credited with 1.2 km and a
   map full of roads he never rode. Two numbers on the dashboard were wrong
   and the trail agreed with them, which is the worst kind of wrong.

   So distance is measured from an ANCHOR rather than from the previous fix.
   The anchor stays put until a fix lands decisively far from it; only then
   does that leg count and the anchor move up. Standing still, every fix is
   within the jitter radius and nothing accumulates - the answer is zero, and
   zero is the truth.
   ========================================================================== */

// A fix vaguer than this cannot prove a 40 m move, so it is not allowed to try.
// Android reports accuracy as a 68% confidence radius; 60 m is a bad urban fix.
const MAX_ACCURACY_M = 60;

// Below this, it is jitter and not travel. Comfortably above the wander of a
// stationary phone with a decent fix, comfortably below one second of riding.
const MIN_MOVE_M = 40;

// Faster than a runner on a bike can be: a glitch, usually the first fix after
// a tunnel or a cold start.
const MAX_SPEED_KMPH = 150;

// Long enough that a big jump is explained by the phone having been offline
// rather than by a bad fix.
const OFFLINE_GAP_S = 300;

function usable(p) {
  if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') return false;
  if (p.lat === 0 && p.lng === 0) return false;
  if (p.mock) return false;                                   // a fake-GPS app said so
  // Older pings were stored before accuracy was recorded. Those are let through;
  // the anchor below is what actually protects the number.
  if (typeof p.accuracy === 'number' && p.accuracy > 0 && p.accuracy > MAX_ACCURACY_M) return false;
  return true;
}

/**
 * The fixes worth keeping, in order: the start, plus every point the runner
 * genuinely moved to. This is what both the distance and the drawn route use,
 * so the map can never show a journey the kilometre count disagrees with.
 */
function cleanTrail(pings) {
  const good = (pings || []).filter(usable);
  if (good.length === 0) return [];

  const kept = [good[0]];
  let anchor = good[0];

  for (let i = 1; i < good.length; i++) {
    const p = good[i];
    const d = distanceM(anchor.lat, anchor.lng, p.lat, p.lng);
    if (d === null || d < MIN_MOVE_M) continue;               // still standing at the anchor

    const secs = (new Date(p.at) - new Date(anchor.at)) / 1000;
    const kmph = secs > 0 ? (d / 1000) / (secs / 3600) : Infinity;

    // Impossibly fast, and no gap to explain it: throw the fix away and keep
    // the anchor where it was. The next honest fix will be measured from the
    // place he actually is, not from a coordinate the phone invented.
    if (kmph > MAX_SPEED_KMPH && secs < OFFLINE_GAP_S) continue;

    kept.push(p);
    anchor = p;
  }
  return kept;
}

// Total distance actually travelled, in km.
function kmFromPings(pings) {
  const trail = cleanTrail(pings);
  let total = 0;
  for (let i = 1; i < trail.length; i++) {
    total += distanceM(trail[i - 1].lat, trail[i - 1].lng, trail[i].lat, trail[i].lng) || 0;
  }
  return Math.round((total / 1000) * 10) / 10;
}

/** Did he move at all? Used to say "parked here" rather than draw a route of one point. */
function movedAtAll(pings) {
  return cleanTrail(pings).length > 1;
}

module.exports = {
  distanceM, roadKm, etaMinutes, kmFromPings, cleanTrail, movedAtAll,
  ROAD_FACTOR, MIN_MOVE_M, MAX_ACCURACY_M
};
