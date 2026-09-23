const Trip = require('../models/Trip');
const Attendance = require('../models/Attendance');
const LocationPing = require('../models/LocationPing');
const Location = require('../models/Location');
const User = require('../models/User');
const { kmFromPings, roadKm } = require('./geo');
const { ISTDate, labelFor } = require('./dispatch');

/**
 * One runner's day, from punch in to punch out.
 *
 * The pieces were all being stored already but never brought together: attendance knew when
 * the shift started, the trips knew which counters he stood at, and the breadcrumb trail knew
 * how far he rode. Separately none of them answer the question the office actually asks -
 * where did he go today and how far did that take him.
 *
 * Stops come from the stage timestamps rather than from the raw GPS. A stage is a moment the
 * runner claimed something happened at a place, which is a far better record of "he was here"
 * than a cluster of coordinates that might just be traffic.
 */

const istDayStart = dateStr => new Date(dateStr + 'T00:00:00+05:30');
const istDayEnd = dateStr => new Date(istDayStart(dateStr).getTime() + 24 * 3600 * 1000);

function nearestPlace(lat, lng, places) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || (!lat && !lng)) return null;
  let best = null;
  for (const p of places) {
    if (typeof p.lat !== 'number') continue;
    const km = roadKm(lat, lng, p.lat, p.lng);
    if (km === null) continue;
    if (!best || km < best.km) best = { name: p.name, area: p.area, km: km };
  }
  if (!best || best.km > 25) return null;
  best.at = best.km <= 0.3;
  return best;
}

function placeLabel(nearest) {
  if (!nearest) return 'Away from every saved place';
  return nearest.at ? nearest.name : nearest.km + ' km from ' + nearest.name;
}

/**
 * Builds one row per runner per day in the range.
 */
async function daySheets({ from, to, runnerId }) {
  const runnerQuery = { role: 'runner' };
  if (runnerId) runnerQuery._id = runnerId;
  const runners = await User.find(runnerQuery).select('name empCode vehicleNo').lean();
  const runnerById = Object.fromEntries(runners.map(r => [String(r._id), r]));
  const ids = runners.map(r => r._id);

  const places = await Location.find({ active: { $ne: false } })
    .select('name area lat lng').lean();

  // Every day in the range, oldest first.
  const days = [];
  for (let t = istDayStart(from); t < istDayEnd(to); t = new Date(t.getTime() + 24 * 3600 * 1000)) {
    days.push(ISTDate(new Date(t.getTime() + 12 * 3600 * 1000)));
  }

  const attendance = await Attendance.find({ runner: { $in: ids }, date: { $in: days } }).lean();

  const trips = await Trip.find({
    runner: { $in: ids },
    assignedAt: { $gte: istDayStart(from), $lt: istDayEnd(to) }
  }).populate('case', 'caseNo jobType patientName reference')
    .populate('pickupLocation dropLocation', 'name area')
    .lean();

  const pings = await LocationPing.find({
    runner: { $in: ids },
    at: { $gte: istDayStart(from), $lt: istDayEnd(to) }
  }).select('runner lat lng at').sort({ at: 1 }).lean();

  // Bucket everything by runner and day once, rather than filtering inside a loop.
  const key = (r, d) => String(r) + '|' + d;
  const tripsBy = {}, pingsBy = {}, attBy = {};
  attendance.forEach(a => { attBy[key(a.runner, a.date)] = a; });
  trips.forEach(t => {
    const k = key(t.runner, ISTDate(new Date(t.assignedAt)));
    (tripsBy[k] = tripsBy[k] || []).push(t);
  });
  pings.forEach(p => {
    const k = key(p.runner, ISTDate(new Date(p.at)));
    (pingsBy[k] = pingsBy[k] || []).push(p);
  });

  const sheets = [];
  for (const date of days) {
    for (const r of runners) {
      const k = key(r._id, date);
      const att = attBy[k];
      const dayTrips = (tripsBy[k] || []).sort((a, b) => new Date(a.assignedAt) - new Date(b.assignedAt));
      const dayPings = pingsBy[k] || [];

      // A day with no punch and no job is not a day worth a row.
      if (!att && !dayTrips.length) continue;

      const sessions = (att && att.sessions) || [];
      const first = sessions[0];
      const last = sessions[sessions.length - 1];
      const open = sessions.find(x => x.inAt && !x.outAt);

      const stops = buildStops(dayTrips, places);

      // Prefer the stored figure, but fall back to the clock. Rows written by older builds
      // have inAt and outAt without `minutes`, and reading those as a zero-hour day is worse
      // than recomputing it.
      const spanOf = s => (s.minutes || (s.inAt && s.outAt
        ? Math.round((new Date(s.outAt) - new Date(s.inAt)) / 60000) : 0));

      const minutes = sessions.reduce((s, x) => s + (x.outAt ? spanOf(x) : 0), 0)
        + (open ? Math.round((Date.now() - new Date(open.inAt).getTime()) / 60000) : 0);

      sheets.push({
        date,
        runnerId: String(r._id),
        runner: r.name,
        empCode: r.empCode,
        vehicleNo: r.vehicleNo,

        punchIn: first && first.inAt ? {
          at: first.inAt, lat: first.inLat, lng: first.inLng, odo: first.inOdo,
          place: placeLabel(nearestPlace(first.inLat, first.inLng, places))
        } : null,

        punchOut: last && last.outAt ? {
          at: last.outAt, lat: last.outLat, lng: last.outLng, odo: last.outOdo,
          place: placeLabel(nearestPlace(last.outLat, last.outLng, places))
        } : null,

        stillOn: !!open,
        sessions: sessions.length,

        stops,
        stopCount: stops.length,
        placesVisited: new Set(stops.map(s => s.place)).size,

        jobs: dayTrips.length,
        jobsDone: dayTrips.filter(t => t.status === 'COMPLETED').length,

        minutes,
        km: kmFromPings(dayPings),
        odoKm: att ? (att.odoKm || (att.endOdo && att.startOdo ? att.endOdo - att.startOdo : 0)) : 0,
        startOdo: att ? att.startOdo : 0,
        endOdo: att ? att.endOdo : 0
      });
    }
  }

  return sheets;
}

/**
 * Turns a day's trips into the list of counters the runner actually stood at.
 *
 * Only the two stages that mean "I am standing at a place" produce a stop - reaching the
 * pickup and reaching the drop. Accepting a job or setting off happen on the road and would
 * pad the list with places he never entered.
 */
function buildStops(dayTrips, places) {
  const stops = [];

  dayTrips.forEach(t => {
    const what = t.case ? (t.case.patientName || t.case.reference || t.case.caseNo) : '';

    if (t.atPickupAt) {
      stops.push({
        at: t.atPickupAt,
        place: t.pickupLocation ? t.pickupLocation.name : 'Pickup point',
        area: t.pickupLocation ? t.pickupLocation.area : '',
        did: labelFor(t.type, 'AT_PICKUP'),
        leftAt: t.pickedAt || null,
        minutes: t.atPickupAt && t.pickedAt
          ? Math.round((new Date(t.pickedAt) - new Date(t.atPickupAt)) / 60000) : null,
        tripNo: t.tripNo, what: what
      });
    }

    if (t.atDropAt) {
      stops.push({
        at: t.atDropAt,
        place: t.dropLocation ? t.dropLocation.name : 'Drop point',
        area: t.dropLocation ? t.dropLocation.area : '',
        did: labelFor(t.type, 'COMPLETED'),
        leftAt: t.completedAt || null,
        minutes: t.atDropAt && t.completedAt
          ? Math.round((new Date(t.completedAt) - new Date(t.atDropAt)) / 60000) : null,
        tripNo: t.tripNo, what: what
      });
    }
  });

  return stops.sort((a, b) => new Date(a.at) - new Date(b.at));
}

module.exports = { daySheets, nearestPlace, placeLabel };
