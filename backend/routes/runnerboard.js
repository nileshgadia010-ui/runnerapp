/**
 * Runner Dashboard - one runner, one day, everything about him.
 *
 * The other screens are each organised around a thing: the live board around the map, the
 * route log around jobs, the day sheet around punches. This one is organised around a
 * person. The desk picks a runner and a date and gets the whole story on a single screen -
 * what he was given, what he reached, where he is now, what he photographed, what he wrote.
 *
 * It is deliberately one request. Every card on that screen describes the same runner on the
 * same day, so six separate calls would only give six chances for the cards to disagree with
 * each other while the page fills in.
 *
 * Nothing here writes. It is a reading screen for the office.
 */
const router = require('express').Router();
const Trip = require('../models/Trip');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const LocationPing = require('../models/LocationPing');
const Photo = require('../models/Photo');
const { auth, can } = require('../middleware/auth');
const { kmFromPings, cleanTrail, distanceM } = require('../services/geo');
const { labelFor } = require('../services/dispatch');
const { tripTat } = require('../services/tat');

router.use(auth, can('viewReports'));

const istDay = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const dayStart = d => new Date(d + 'T00:00:00+05:30');
const dayEnd = d => new Date(dayStart(d).getTime() + 24 * 3600 * 1000);
const round1 = n => Math.round((n || 0) * 10) / 10;

/**
 * The runner picker at the top of the screen.
 *
 * Carries just enough to search on and to show a status dot beside each name, so choosing a
 * runner never needs a second call.
 */
router.get('/roster', async (req, res, next) => {
  try {
    const date = req.query.date || istDay();
    const runners = await User.find({ role: 'runner' })
      .select('name empCode phone photo vehicleNo dutyState active lastSeenAt shiftStart shiftEnd')
      .sort({ active: -1, name: 1 }).lean();

    // Which of them actually punched in on the chosen day - the desk usually wants those
    // first, and on a past date the live duty state means nothing.
    const att = await Attendance.find({ date, runner: { $in: runners.map(r => r._id) } })
      .select('runner tripsDone totalMinutes open').lean();
    const attBy = Object.fromEntries(att.map(a => [String(a.runner), a]));

    res.json({
      date,
      runners: runners.map(r => {
        const a = attBy[String(r._id)];
        return {
          id: r._id, name: r.name, empCode: r.empCode || '', phone: r.phone || '',
          photo: r.photo || '', vehicleNo: r.vehicleNo || '',
          dutyState: r.dutyState, active: r.active !== false,
          shift: shiftText(r),
          workedThatDay: !!a,
          onDutyThatDay: !!(a && a.open),
          lastSeenAt: r.lastSeenAt || null
        };
      })
    });
  } catch (e) { next(e); }
});

/** "09:00 AM - 02:00 PM", the way the board in the office writes it. */
function shiftText(u) {
  if (!u.shiftStart || !u.shiftEnd) return '';
  return clock12(u.shiftStart) + ' - ' + clock12(u.shiftEnd);
}
function clock12(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (isNaN(h)) return hhmm;
  const ap = h >= 12 ? 'PM' : 'AM';
  // Zero-padded, so a column of shift times lines up: "09:00 AM - 02:00 PM".
  return String(h % 12 || 12).padStart(2, '0') + ':' + String(m || 0).padStart(2, '0') + ' ' + ap;
}

/** What to call the shift in one word, so the counter card can say "Assigned (Morning)". */
function shiftWord(u) {
  const h = Number(String(u.shiftStart || '').split(':')[0]);
  if (isNaN(h)) return '';
  if (h < 12) return 'Morning';
  if (h < 16) return 'Afternoon';
  if (h < 21) return 'Evening';
  return 'Night';
}

/**
 * The whole screen for one runner on one day.
 */
router.get('/:runnerId', async (req, res, next) => {
  try {
    const date = req.query.date || istDay();
    const from = dayStart(date), to = dayEnd(date);

    const runner = await User.findById(req.params.runnerId)
      .select('name empCode phone photo vehicleNo branch dutyState active lastLocation lastSeenAt shiftStart shiftEnd weekOff')
      .lean();
    if (!runner) return res.status(404).json({ error: 'No such runner' });

    const [trips, att, pings, photos] = await Promise.all([
      Trip.find({ runner: runner._id, assignedAt: { $gte: from, $lt: to } })
        .populate('case', 'caseNo jobType patientName reference bloodGroup component unitsRequested')
        .populate('pickupLocation dropLocation', 'name area city address lat lng type phone contactPerson')
        .sort({ assignedAt: 1 }).lean(),
      Attendance.findOne({ runner: runner._id, date }).lean(),
      LocationPing.find({ runner: runner._id, at: { $gte: from, $lt: to } })
        .select('lat lng at speed accuracy mock').sort({ at: 1 }).lean(),
      Photo.find({ runner: runner._id, at: { $gte: from, $lt: to } })
        .select('kind trip at lat lng').sort({ at: 1 }).lean()
    ]);

    const sessions = (att && att.sessions) || [];
    const stops = buildStops(trips);
    const photoByTrip = {};
    photos.filter(p => p.kind === 'PROOF' && p.trip)
      .forEach(p => { photoByTrip[String(p.trip)] = String(p._id); });

    // Distance: the GPS trail is the honest figure. The odometer is kept alongside rather
    // than instead of it, because the two disagreeing is itself worth seeing.
    const km = round1(kmFromPings(pings));

    res.json({
      date,
      today: date === istDay(),

      runner: {
        id: runner._id,
        name: runner.name,
        empCode: runner.empCode || '',
        phone: runner.phone || '',
        photo: runner.photo || '',
        vehicleNo: runner.vehicleNo || '',
        branch: runner.branch || '',
        dutyState: runner.dutyState,
        active: runner.active !== false,
        shift: shiftText(runner),
        shiftWord: shiftWord(runner),
        weekOff: runner.weekOff || ''
      },

      // What he actually brought back or handed over. Places visited answers "did he go";
      // these answer "and what came of it" - the money collected, the units delivered, the
      // parcels dropped. The office reconciles the cash against this the same evening.
      collected: (() => {
        const done = trips.filter(t => t.status === 'COMPLETED');
        const money = done.filter(t => t.type === 'PAYMENT_COLLECT');
        const units = done.filter(t => t.type === 'BLOOD_DELIVERY');
        const parcels = done.filter(t => t.type === 'PACKAGE_DELIVER');
        const samples = done.filter(t => ['SAMPLE_PICKUP', 'COLLECTION_SAMPLE'].includes(t.type));
        return {
          amount: Math.round(money.reduce((n, t) => n + (t.amountCollected || 0), 0)),
          payments: money.length,
          modes: money.reduce((m, t) => {
            const k = t.paymentMode || 'CASH';
            m[k] = (m[k] || 0) + (t.amountCollected || 0);
            return m;
          }, {}),
          units: units.reduce((n, t) => n + (t.unitsCarried || 0), 0),
          deliveries: units.length,
          parcels: parcels.length,
          samples: samples.length
        };
      })(),

      counters: {
        total: stops.length,
        completed: stops.filter(s => s.status === 'VISITED').length,
        pending: stops.filter(s => s.status !== 'VISITED').length,
        inProgress: stops.filter(s => s.status === 'IN_PROGRESS').length,
        jobs: trips.length,
        jobsDone: trips.filter(t => t.status === 'COMPLETED').length,
        km,
        odoKm: att ? (att.odoKm || 0) : 0,
        minutes: sessions.reduce((n, s) => n + (s.minutes ||
          (s.inAt && s.outAt ? Math.round((new Date(s.outAt) - new Date(s.inAt)) / 60000) : 0)), 0)
          + (sessions.some(s => s.inAt && !s.outAt)
            ? Math.round((Date.now() - new Date(sessions.find(s => s.inAt && !s.outAt).inAt)) / 60000) : 0)
      },

      // Where he is right now. Only meaningful for today - on an older date the last ping of
      // that day is the honest answer instead, and the client is told which it got.
      live: liveMark(runner, pings, date),

      // The day's two bookends, which is the question the office asks first.
      route: {
        startPlace: sessions[0] ? placeOf(sessions[0].inAddress, sessions[0].inLat, sessions[0].inLng, stops) : '',
        startAt: sessions[0] ? sessions[0].inAt : null,
        lastPlace: lastPlaceOf(sessions, pings, stops),
        lastAt: lastTimeOf(sessions, pings),
        stillOn: sessions.some(s => s.inAt && !s.outAt)
      },

      // The line drawn on the map. Thinned, because a full day is thousands of points and
      // the shape of the route survives dropping most of them.
      // The drawn route and the kilometre count come from the same cleaned list, so the map
      // can never show a journey the number disagrees with. A runner who has not moved gets
      // a single point and therefore no line at all - which is the honest picture.
      trail: thin(cleanTrail(pings)).map(p => [p.lat, p.lng]),
      trailPoints: pings.length,
      movedPoints: cleanTrail(pings).length,

      stops,
      timeline: buildTimeline(sessions, trips, stops, att, photoByTrip),
      notes: trips.filter(t => t.runnerNote).map(t => ({
        at: t.completedAt || t.atDropAt || t.assignedAt,
        text: t.runnerNote,
        tripNo: t.tripNo,
        place: t.dropLocation ? t.dropLocation.name : '',
        photo: photoByTrip[String(t._id)] || t.proofPhoto || ''
      })).sort((a, b) => new Date(b.at) - new Date(a.at))
    });
  } catch (e) { next(e); }
});

/**
 * Turns the day's jobs into the numbered pins on the map.
 *
 * A pin is a place he was sent to, not a job - a job sends him to two places, and the office
 * counts the visits. They come out in the order he was meant to make them, which is the
 * order the pins are numbered in.
 *
 * Status is the whole point of the colour coding:
 *   VISITED      he arrived - there is a timestamp saying so
 *   IN_PROGRESS  this is the leg he is riding or standing at right now
 *   PENDING      still ahead of him, or he never got there
 */
function buildStops(trips) {
  const out = [];

  trips.forEach(t => {
    const reachedPickup = t.atPickupAt || null;
    const reachedDrop = t.atDropAt || null;
    const dead = ['REJECTED', 'CANCELLED'].includes(t.status);
    const what = t.case ? (t.case.patientName || t.case.reference || t.case.caseNo) : '';

    const leg = (place, kind, reachedAt, leftAt, live) => {
      if (!place) return;
      out.push({
        tripId: String(t._id),
        tripNo: t.tripNo,
        jobType: t.type,
        kind,                                  // PICKUP or DROP
        placeId: place._id,
        name: place.name,
        address: place.address || '',
        area: [place.area, place.city].filter(Boolean).join(', '),
        phone: place.phone || '',
        contactPerson: place.contactPerson || '',
        lat: place.lat, lng: place.lng,
        assignedAt: t.assignedAt,
        reachedAt, leftAt,
        minutes: reachedAt && leftAt
          ? Math.round((new Date(leftAt) - new Date(reachedAt)) / 60000) : null,
        status: reachedAt ? 'VISITED' : (dead ? 'PENDING' : (live ? 'IN_PROGRESS' : 'PENDING')),
        did: labelFor(t.type, kind === 'PICKUP' ? 'AT_PICKUP' : 'COMPLETED'),
        stage: t.status,
        what,
        note: t.runnerNote || '',
        caseNo: t.case ? t.case.caseNo : '',
        // Why it is still open, in the words the desk would use.
        why: dead ? (t.status === 'REJECTED' ? 'Declined by runner' : 'Cancelled by desk')
          : (reachedAt ? '' : 'Not visited')
      });
    };

    // He is "on" the pickup leg until he has collected, and on the drop leg after that.
    const onPickup = ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE_PICKUP', 'AT_PICKUP'].includes(t.status);
    const onDrop = ['PICKED', 'EN_ROUTE_DROP', 'AT_DROP'].includes(t.status);

    leg(t.pickupLocation, 'PICKUP', reachedPickup, t.pickedAt, onPickup);
    leg(t.dropLocation, 'DROP', reachedDrop, t.completedAt, onDrop);
  });

  // Ordered by when he actually got there, falling back to when the job was given - so the
  // numbers on the map read as the sequence of his day.
  //
  // The fallback needs the tie-break underneath it. Both legs of one job carry the same
  // assignedAt, so two places he has not reached yet sort equal, and a drop could be
  // numbered ahead of the pickup that has to happen first. Within a tie, the job's own order
  // decides, and a pickup always comes before its drop.
  const order = { PICKUP: 0, DROP: 1 };
  out.sort((a, b) => {
    const d = new Date(a.reachedAt || a.assignedAt) - new Date(b.reachedAt || b.assignedAt);
    if (d) return d;
    if (a.tripId !== b.tripId) return new Date(a.assignedAt) - new Date(b.assignedAt);
    return order[a.kind] - order[b.kind];
  });
  out.forEach((s, i) => { s.n = i + 1; });
  return out;
}

/**
 * The scrollable list under the map: punches and visits woven into one column of time.
 *
 * Punches and visits live in different collections and neither knows about the other, which
 * is exactly why they are worth merging here - the sequence is the thing the office reads.
 */
function buildTimeline(sessions, trips, stops, att, photoByTrip) {
  const rows = [];

  sessions.forEach((s, i) => {
    if (s.inAt) rows.push({
      type: 'PUNCH_IN', at: s.inAt,
      place: s.inAddress || '', lat: s.inLat, lng: s.inLng,
      photo: s.inOdoPhoto || (i === 0 && att ? att.startOdoPhoto : '') || '',
      odo: s.inOdo || null,
      status: 'COMPLETED',
      label: sessions.length > 1 ? 'Punch In (' + (i + 1) + ')' : 'Punch In'
    });
    if (s.outAt) rows.push({
      type: 'PUNCH_OUT', at: s.outAt,
      place: s.outAddress || '', lat: s.outLat, lng: s.outLng,
      photo: s.outOdoPhoto || (i === sessions.length - 1 && att ? att.endOdoPhoto : '') || '',
      odo: s.outOdo || null,
      status: 'COMPLETED',
      label: sessions.length > 1 ? 'Punch Out (' + (i + 1) + ')' : 'Punch Out'
    });
  });

  // A visit only enters the timeline once he actually arrived; a place he never reached is a
  // pin on the map and a line in the pending list, but it is not something that happened.
  stops.filter(s => s.reachedAt).forEach(s => {
    const trip = trips.find(t => String(t._id) === s.tripId);
    const ev = trip && (trip.events || []).slice().reverse()
      .find(e => e.status === (s.kind === 'PICKUP' ? 'AT_PICKUP' : 'AT_DROP'));

    rows.push({
      type: 'VISIT', at: s.reachedAt,
      place: s.name,
      area: s.area,
      // The GPS reading taken when he pressed the button, which is the checkable one. The
      // saved coordinates of the building are the fallback.
      lat: ev && ev.lat !== undefined ? ev.lat : s.lat,
      lng: ev && ev.lng !== undefined ? ev.lng : s.lng,
      fromPhone: !!(ev && ev.lat !== undefined),
      photo: photoByTrip[s.tripId] || '',
      status: s.leftAt ? 'COMPLETED' : 'IN_PROGRESS',
      label: 'Connection Visit',
      stopN: s.n, tripNo: s.tripNo, did: s.did, what: s.what,
      minutes: s.minutes,

      // How far from the place he actually was when he pressed "I have reached".
      // The dispatcher has always measured this; nothing ever showed it. It is the one
      // number that can tell the office a visit was claimed from somewhere else.
      awayM: ev && typeof ev.distanceToTargetM === 'number' ? ev.distanceToTargetM : null
    });
  });

  rows.sort((a, b) => new Date(a.at) - new Date(b.at));
  rows.forEach((r, i) => { r.n = i + 1; });
  return rows;
}

/** Where the rider marker goes, and whether it means "now" or "last seen that day". */
function liveMark(runner, pings, date) {
  const isToday = date === istDay();
  const last = pings.length ? pings[pings.length - 1] : null;

  if (isToday && runner.lastLocation && runner.lastLocation.lat) {
    return {
      lat: runner.lastLocation.lat, lng: runner.lastLocation.lng,
      at: runner.lastLocation.at || runner.lastSeenAt,
      battery: runner.lastLocation.battery,
      onDuty: runner.dutyState !== 'OFF_DUTY',
      live: true
    };
  }
  if (last) return { lat: last.lat, lng: last.lng, at: last.at, onDuty: false, live: false };
  return null;
}

/** Prefer the address the phone wrote; fall back to the nearest place he visited. */
function placeOf(address, lat, lng, stops) {
  if (address) return address;
  if (typeof lat !== 'number') return '';
  let best = null;
  stops.forEach(s => {
    const d = distanceM(lat, lng, s.lat, s.lng);
    if (d !== null && (!best || d < best.d)) best = { d, name: s.name };
  });
  if (!best) return '';
  return best.d <= 400 ? best.name : (Math.round(best.d / 100) / 10) + ' km from ' + best.name;
}

function lastPlaceOf(sessions, pings, stops) {
  const last = sessions[sessions.length - 1];
  if (last && last.outAt) return placeOf(last.outAddress, last.outLat, last.outLng, stops);
  const p = pings.length ? pings[pings.length - 1] : null;
  return p ? placeOf('', p.lat, p.lng, stops) : '';
}

function lastTimeOf(sessions, pings) {
  const last = sessions[sessions.length - 1];
  if (last && last.outAt) return last.outAt;
  return pings.length ? pings[pings.length - 1].at : null;
}

/**
 * Thins the trail to something a browser can draw.
 *
 * Keeps a point whenever the runner has moved a real distance since the last kept one, so
 * straight runs collapse and corners survive. A hard cap keeps a bad GPS day - thousands of
 * jittering points from a phone sitting still - from reaching the map at all.
 */
function thin(pings, maxPoints = 600) {
  if (pings.length <= 2) return pings;
  const kept = [pings[0]];
  for (let i = 1; i < pings.length - 1; i++) {
    const prev = kept[kept.length - 1];
    const d = distanceM(prev.lat, prev.lng, pings[i].lat, pings[i].lng);
    if (d !== null && d >= 60) kept.push(pings[i]);
  }
  kept.push(pings[pings.length - 1]);
  if (kept.length <= maxPoints) return kept;

  const step = Math.ceil(kept.length / maxPoints);
  const out = kept.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== kept[kept.length - 1]) out.push(kept[kept.length - 1]);
  return out;
}

module.exports = router;
