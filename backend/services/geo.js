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

// Total distance covered by a sorted list of pings, in km.
// Jumps bigger than 3 km between two consecutive pings are skipped - those are almost
// always a GPS glitch after a tunnel or a long signal gap, not real riding.
function kmFromPings(pings) {
  let total = 0;
  for (let i = 1; i < pings.length; i++) {
    const d = distanceM(pings[i - 1].lat, pings[i - 1].lng, pings[i].lat, pings[i].lng);
    if (d !== null && d < 3000) total += d;
  }
  return Math.round((total / 1000) * 10) / 10;
}

module.exports = { distanceM, roadKm, etaMinutes, kmFromPings, ROAD_FACTOR };
