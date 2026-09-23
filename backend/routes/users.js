const router = require('express').Router();
const User = require('../models/User');
const Trip = require('../models/Trip');
const Attendance = require('../models/Attendance');
const Location = require('../models/Location');
const LocationPing = require('../models/LocationPing');
const { roadKm, etaMinutes, kmFromPings } = require('../services/geo');
const { ISTDate } = require('../services/dispatch');
const { auth, allow, can } = require('../middleware/auth');

router.use(auth);

// List staff. ?role=runner&available=1 is what the assign screen uses.
router.get('/', async (req, res) => {
  const q = {};
  if (req.query.role) q.role = req.query.role;
  if (req.query.active !== 'all') q.active = true;
  if (req.query.available === '1') q.dutyState = 'AVAILABLE';

  const users = await User.find(q).sort({ name: 1 });
  res.json(users.map(u => u.publicJSON()));
});

// Live board of every runner with his current trip - powers the map and the side panel.
router.get('/live', async (req, res) => {
  const runners = await User.find({ role: 'runner', active: true }).sort({ name: 1 }).lean();
  const tripIds = runners.map(r => r.activeTrip).filter(Boolean);
  const trips = await Trip.find({ _id: { $in: tripIds } })
    .populate('case', 'caseNo patientName priority bloodGroup component')
    .populate('pickupLocation dropLocation', 'name area lat lng')
    .lean();
  const byId = Object.fromEntries(trips.map(t => [String(t._id), t]));

  // Every unfinished job each runner is holding, so the board can show "on a job, 2 waiting"
  // and the desk knows who actually has room for the next one.
  const openTrips = await Trip.find({
    runner: { $in: runners.map(r => r._id) },
    status: { $in: ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE_PICKUP', 'AT_PICKUP', 'PICKED', 'EN_ROUTE_DROP', 'AT_DROP'] }
  }).select('runner tripNo status type queueOrder assignedAt').sort({ queueOrder: 1, assignedAt: 1 }).lean();

  const queueByRunner = {};
  openTrips.forEach(t => {
    const k = String(t.runner);
    (queueByRunner[k] = queueByRunner[k] || []).push(t);
  });

  // Today's job count per runner, so the side panel can show workload at a glance.
  const today = ISTDate();
  const att = await Attendance.find({ runner: { $in: runners.map(r => r._id) }, date: today })
    .select('runner tripsDone').lean();
  const doneById = Object.fromEntries(att.map(a => [String(a.runner), a.tripsDone || 0]));

  const stale = Date.now() - 3 * 60 * 1000;
  res.json(runners.map(r => ({
    id: r._id,
    name: r.name,
    empCode: r.empCode,
    phone: r.phone,
    vehicleNo: r.vehicleNo,
    dutyState: r.dutyState,
    lastLocation: r.lastLocation,
    lastSeenAt: r.lastSeenAt,
    signalLost: r.dutyState !== 'OFF_DUTY' && (!r.lastSeenAt || new Date(r.lastSeenAt).getTime() < stale),

    // Environment flags the phone reported. These are hints, not proof - any client side
    // check can be defeated - but a runner who keeps showing up flagged is worth a word.
    integrity: r.integrity || null,
    flagged: !!(r.integrity && (r.integrity.vpn || r.integrity.mockLocation || r.integrity.rooted)),

    tripsToday: doneById[String(r._id)] || 0,

    // Jobs in hand right now, and how many of those are still waiting their turn.
    jobsInHand: (queueByRunner[String(r._id)] || []).length,
    waiting: Math.max(0, (queueByRunner[String(r._id)] || []).length - 1),
    queue: (queueByRunner[String(r._id)] || []).map(t => ({
      id: String(t._id), tripNo: t.tripNo, status: t.status, type: t.type
    })),

    // How far he still has to ride to the point he is heading for right now. The desk asks
    // this constantly ("kitna door hai?"), so the board answers it without anyone calling.
    ...toTarget(r, r.activeTrip ? byId[String(r.activeTrip)] : null),

    trip: r.activeTrip ? byId[String(r.activeTrip)] || null : null
  })));
});

/*
 * Where one runner is, and where his day started.
 *
 * The board could already show a dot on a map, which answers "is he moving" but not the
 * question the desk actually asks out loud: where IS he, and where did he punch in from.
 * A pair of coordinates is not an answer a human can act on.
 *
 * So each point is reported against the places the office already knows - "1.2 km from
 * Sterling Hospital, Memnagar" - which is both more useful than a street address and free
 * of any dependency on an outside geocoder that could be slow, rate-limited or simply down.
 */
router.get('/:id/where', async (req, res) => {
  const runner = await User.findById(req.params.id);
  if (!runner || runner.role !== 'runner') return res.status(404).json({ error: 'Runner not found' });

  const places = await Location.find({ active: { $ne: false } })
    .select('name area city type lat lng').lean();

  const date = ISTDate();
  const att = await Attendance.findOne({ runner: runner._id, date }).lean();
  const session = att && att.sessions && att.sessions.length ? att.sessions[0] : null;
  const openSession = att && (att.sessions || []).find(x => x.inAt && !x.outAt);

  // Distance covered today, from the breadcrumb trail.
  const dayStart = new Date(date + 'T00:00:00+05:30');
  const pings = await LocationPing.find({ runner: runner._id, at: { $gte: dayStart } })
    .select('lat lng at').sort({ at: 1 }).lean();

  const loc = runner.lastLocation || {};
  const stale = Date.now() - 3 * 60 * 1000;

  res.json({
    runner: {
      id: runner._id, name: runner.name, empCode: runner.empCode,
      phone: runner.phone, vehicleNo: runner.vehicleNo,
      dutyState: runner.dutyState, lastSeenAt: runner.lastSeenAt,
      signalLost: runner.dutyState !== 'OFF_DUTY' &&
                  (!runner.lastSeenAt || new Date(runner.lastSeenAt).getTime() < stale)
    },

    now: loc.lat ? {
      lat: loc.lat, lng: loc.lng, at: loc.at,
      accuracy: loc.accuracy, speed: loc.speed, battery: loc.battery,
      nearest: nearestPlace(loc.lat, loc.lng, places)
    } : null,

    punchIn: session && session.inAt ? {
      at: session.inAt, lat: session.inLat, lng: session.inLng,
      odo: session.inOdo, photo: session.inOdoPhoto,
      nearest: nearestPlace(session.inLat, session.inLng, places)
    } : null,

    punchOut: session && session.outAt ? {
      at: session.outAt, lat: session.outLat, lng: session.outLng,
      odo: session.outOdo, photo: session.outOdoPhoto,
      nearest: nearestPlace(session.outLat, session.outLng, places)
    } : null,

    onDuty: !!openSession,
    sessions: (att && att.sessions || []).map(x => ({
      inAt: x.inAt, outAt: x.outAt, minutes: x.minutes,
      inNearest: nearestPlace(x.inLat, x.inLng, places),
      outNearest: nearestPlace(x.outLat, x.outLng, places)
    })),

    today: {
      minutes: att ? (att.sessions || []).reduce((sum, x) => sum + (x.outAt ? (x.minutes || 0) : 0), 0)
                     + (openSession ? Math.round((Date.now() - new Date(openSession.inAt).getTime()) / 60000) : 0)
                   : 0,
      trips: att ? att.tripsDone : 0,
      km: kmFromPings(pings),
      odoStart: att ? att.startOdo : 0
    },

    // The trail, so the card can draw where he has been today.
    trail: pings.map(p => [p.lat, p.lng]),
    serverTime: new Date()
  });
});

/*
 * The closest place the office has on file, with the road distance to it. Returns null when
 * nothing is within 25 km, because "nearest: Civil Hospital, 60 km" tells nobody anything.
 */
function nearestPlace(lat, lng, places) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || (!lat && !lng)) return null;

  let best = null;
  for (const p of places) {
    if (typeof p.lat !== 'number') continue;
    const km = roadKm(lat, lng, p.lat, p.lng);
    if (km === null) continue;
    if (!best || km < best.km) best = { name: p.name, area: p.area, city: p.city, type: p.type, km: km };
  }
  if (!best || best.km > 25) return null;

  // Under 300 metres he is effectively standing there, and saying "0.2 km from" is fussy.
  best.at = best.km <= 0.3;
  return best;
}

// The stop the runner is heading to, and the road distance from where he is now.
function toTarget(runner, trip) {
  if (!trip || !runner.lastLocation || !runner.lastLocation.lat) {
    return { targetName: null, targetKm: null, targetEtaMin: null };
  }
  const beforePickup = ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE_PICKUP', 'AT_PICKUP'].includes(trip.status);
  const target = beforePickup ? trip.pickupLocation : trip.dropLocation;
  if (!target || typeof target.lat !== 'number') {
    return { targetName: null, targetKm: null, targetEtaMin: null };
  }
  const km = roadKm(runner.lastLocation.lat, runner.lastLocation.lng, target.lat, target.lng);
  return { targetName: target.name, targetKm: km, targetEtaMin: etaMinutes(km) };
}

const RIGHT_KEYS = ['manageStaff', 'managePlaces', 'createCases', 'assignTrips', 'overrideStages', 'editSettings', 'viewReports'];

// Only somebody with manageStaff can create or change accounts, and only an admin can hand
// out rights. That split matters: a coordinator can add a new runner without being able to
// quietly give herself the reports screen.
router.post('/', can('manageStaff'), async (req, res) => {
  const { name, username, password, role, empCode, phone, vehicleNo, branch,
          shiftStart, shiftEnd, weekOff } = req.body || {};
  if (!name || !username || !password) return res.status(400).json({ error: 'Name, user ID and password are required' });

  const clean = normaliseUsername(username);
  if (!clean) return res.status(400).json({ error: 'User ID can only use letters, numbers, dot, dash and underscore' });
  if (await User.findOne({ username: clean })) {
    return res.status(409).json({ error: 'That user ID is already taken' });
  }

  const wanted = role || 'runner';
  if (wanted === 'admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only an admin can create another admin' });
  }

  const u = new User({ name, username: clean, role: wanted, empCode, phone, vehicleNo, branch,
                       shiftStart, shiftEnd, weekOff });
  // No applyRights call means no stored decision, which means the role's normal set applies.
  applyRights(u, req);
  u.setPassword(password);
  await u.save();
  res.status(201).json(u.publicJSON());
});

// User IDs are typed by runners with one thumb, so keep them simple and case-insensitive.
function normaliseUsername(raw) {
  const v = String(raw || '').toLowerCase().trim();
  return /^[a-z0-9._-]{3,30}$/.test(v) ? v : null;
}

// Rights are only writable by an admin. A non-admin editing a user leaves them untouched.
//
// The body carries an object of booleans because that is what a screen of checkboxes
// produces; it is turned into a granted list here, which is the only shape the model stores.
function applyRights(u, req) {
  if (req.user.role !== 'admin' || !req.body.rights) return;
  const on = RIGHT_KEYS.filter(k => !!req.body.rights[k]);
  u.setRights(on);
}

router.put('/:id', can('manageStaff'), async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'Staff member not found' });

  // The app user ID used to be fixed for life, which made a typo permanent. It can now be
  // changed - the account keeps its history because everything is linked by the record id,
  // not by the login name. The runner simply signs in with the new ID next time.
  if (req.body.username !== undefined && req.body.username !== u.username) {
    const clean = normaliseUsername(req.body.username);
    if (!clean) return res.status(400).json({ error: 'User ID can only use letters, numbers, dot, dash and underscore' });
    const taken = await User.findOne({ username: clean, _id: { $ne: u._id } });
    if (taken) return res.status(409).json({ error: 'That user ID is already taken' });
    u.username = clean;
  }

  ['name', 'empCode', 'phone', 'vehicleNo', 'branch', 'shiftStart', 'shiftEnd', 'weekOff'].forEach(f => {
    if (req.body[f] !== undefined) u[f] = req.body[f];
  });

  if (req.body.role !== undefined && req.body.role !== u.role) {
    if (req.body.role === 'admin' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can make someone an admin' });
    }
    if (u.role === 'admin' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can change an admin account' });
    }
    u.role = req.body.role;
    u.resetRights();   // a new role starts clean, on that role's normal set
  }

  // Nobody can switch off or demote their own account - that is how an office locks itself out.
  if (String(u._id) === String(req.user._id)) {
    if (req.body.active === false) return res.status(400).json({ error: 'You cannot switch off your own account' });
    if (req.body.rights) return res.status(400).json({ error: 'You cannot change your own rights' });
  } else if (req.body.active !== undefined) {
    u.active = !!req.body.active;
  }

  applyRights(u, req);
  if (req.body.password) u.setPassword(req.body.password);

  await u.save();
  res.json(u.publicJSON());
});

/*
 * Switching an account off is the normal thing to do when somebody leaves: they can no
 * longer sign in, and every job they ever ran still shows their name. That stays the default.
 *
 * ?hard=1 erases the person entirely, and is refused while any job still points at them -
 * a report full of jobs run by nobody is worse than a switched-off account.
 */
router.delete('/:id', can('manageStaff'), async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'Staff member not found' });
  if (String(u._id) === String(req.user._id)) {
    return res.status(400).json({ error: 'You cannot remove your own account' });
  }

  if (req.query.hard === '1') {
    if (!req.user.can('deleteRecords')) {
      return res.status(403).json({ error: 'You do not have rights to delete permanently. Ask an admin.' });
    }
    if (u.role === 'admin' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can remove an admin account' });
    }
    const jobs = await Trip.countDocuments({ runner: u._id });
    if (jobs) {
      return res.status(409).json({
        error: u.name + ' has ' + jobs + ' job' + (jobs > 1 ? 's' : '') + ' on record. Switch the account off instead of deleting.'
      });
    }
    await Attendance.deleteMany({ runner: u._id });
    await LocationPing.deleteMany({ runner: u._id });
    await User.deleteOne({ _id: u._id });
    console.warn('[delete] staff ' + u.username + ' removed by ' + req.user.username);
    return res.json({ ok: true, message: u.name + ' deleted' });
  }

  u.active = false;
  await u.save();
  res.json({ ok: true, message: u.name + ' switched off' });
});

module.exports = router;
