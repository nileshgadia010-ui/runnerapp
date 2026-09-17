const router = require('express').Router();
const path = require('path');
const multer = require('multer');
const Trip = require('../models/Trip');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const LocationPing = require('../models/LocationPing');
const Photo = require('../models/Photo');
const SLA = require('../config/sla');
const { auth, allow } = require('../middleware/auth');
const { tripTat } = require('../services/tat');
const { roadKm, etaMinutes, kmFromPings } = require('../services/geo');
const { applyStage, labelFor, ISTDate } = require('../services/dispatch');
const realtime = require('../services/realtime');

// Photos are held in memory just long enough to be written into MongoDB. Nothing touches
// the container filesystem, because that filesystem is wiped on every deploy - see
// models/Photo.js for why this matters more than it sounds.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

// Saves an uploaded file and returns the URL the dashboard should use, or undefined when
// there was no file. A failure here never takes down the stage change that carried it -
// losing the photo is bad, losing the delivery record would be worse.
async function storePhoto(file, meta) {
  if (!file || !file.buffer || !file.buffer.length) return undefined;
  try {
    const doc = await Photo.create({
      data: file.buffer,
      contentType: file.mimetype || 'image/jpeg',
      bytes: file.size || file.buffer.length,
      kind: meta.kind || 'OTHER',
      runner: meta.runner,
      trip: meta.trip || null,
      lat: meta.lat ? Number(meta.lat) : undefined,
      lng: meta.lng ? Number(meta.lng) : undefined,
      at: new Date()
    });
    return '/uploads/' + doc._id;
  } catch (e) {
    console.error('[photo] could not be stored:', e.message);
    return undefined;
  }
}

router.use(auth, allow('runner', 'admin'));

/* ------------------------------------------------------------------ *
 * Shared shapes
 * ------------------------------------------------------------------ */

const POP = [
  { path: 'case', select: 'caseNo patientName patientAge patientGender bloodGroup component unitsRequested priority wardBed attendantName attendantPhone remarks' },
  { path: 'pickupLocation', select: 'name address area phone lat lng contactPerson geofence' },
  { path: 'dropLocation', select: 'name address area phone lat lng contactPerson geofence' }
];

// The point the runner is heading to right now, given how far along the trip is.
function currentTarget(t) {
  const beforePickup = ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE_PICKUP', 'AT_PICKUP'].includes(t.status);
  return beforePickup ? t.pickupLocation : t.dropLocation;
}

function place(p) {
  if (!p) return null;
  return {
    name: p.name, address: p.address, area: p.area, phone: p.phone,
    lat: p.lat, lng: p.lng, contactPerson: p.contactPerson
  };
}

function tripCard(t, from) {
  const sample = t.type === 'SAMPLE_PICKUP';
  const target = currentTarget(t);
  let km = null, eta = null;
  if (target && from && from.lat && from.lng) {
    km = roadKm(Number(from.lat), Number(from.lng), target.lat, target.lng);
    eta = etaMinutes(km);
  }
  return {
    id: t._id,
    tripNo: t.tripNo,
    type: t.type,
    status: t.status,
    statusLabel: labelFor(t.type, t.status),
    headline: sample ? 'Collect sample' : 'Deliver blood',
    caseNo: t.case && t.case.caseNo,
    patientName: t.case && t.case.patientName,
    patientAge: t.case && t.case.patientAge,
    patientGender: t.case && t.case.patientGender,
    bloodGroup: t.case && t.case.bloodGroup,
    component: t.case && t.case.component,
    units: t.case && t.case.unitsRequested,
    priority: t.case && t.case.priority,
    wardBed: t.case && t.case.wardBed,
    attendantName: t.case && t.case.attendantName,
    attendantPhone: t.case && t.case.attendantPhone,
    remarks: t.case && t.case.remarks,
    pickup: place(t.pickupLocation),
    drop: place(t.dropLocation),
    target: place(target),
    targetKm: km,
    targetEtaMin: eta,
    assignedAt: t.assignedAt,
    acceptedAt: t.acceptedAt,
    atPickupAt: t.atPickupAt,
    pickedAt: t.pickedAt,
    atDropAt: t.atDropAt,
    completedAt: t.completedAt,
    proofPhoto: t.proofPhoto,
    sampleBarcode: t.sampleBarcode,
    tat: tripTat(t, new Date())
  };
}

// Minutes of a punch session that is still open right now.
function openMinutes(att) {
  const s = ((att && att.sessions) || []).find(x => x.inAt && !x.outAt);
  return s ? Math.round((Date.now() - new Date(s.inAt).getTime()) / 60000) : 0;
}
function openSince(att) {
  const s = ((att && att.sessions) || []).find(x => x.inAt && !x.outAt);
  return s ? s.inAt : null;
}
// Minutes from sessions that are already closed today.
function closedMinutes(att) {
  return ((att && att.sessions) || []).reduce((sum, x) => sum + (x.outAt ? (x.minutes || 0) : 0), 0);
}

const istDayStart = (dateStr) => new Date(dateStr + 'T00:00:00+05:30');
const istDayEnd = (dateStr) => new Date(istDayStart(dateStr).getTime() + 24 * 3600 * 1000);

/* ------------------------------------------------------------------ *
 * Poll - the heartbeat of the app
 * ------------------------------------------------------------------ */

// The app hits this every few seconds. It carries everything the home screen needs so the
// phone never has to make a second call: duty clock anchors, today's numbers, the live job.
//
// IMPORTANT for the app's timers: we send serverTime plus the *anchor timestamps*
// (dutyStartedAt, assignedAt) rather than a pre-computed "minutes so far". The app keeps a
// clock offset and ticks locally, so the on-screen watch never jumps backwards when a new
// poll lands in the middle of a minute.
router.get('/poll', async (req, res) => {
  const runner = req.user;
  runner.lastSeenAt = new Date();
  await runner.save();

  const trip = await Trip.findOne({ runner: runner._id, status: { $nin: ['COMPLETED', 'REJECTED', 'CANCELLED'] } })
    .populate(POP).lean();

  const date = ISTDate();
  const att = await Attendance.findOne({ runner: runner._id, date }).lean();
  const km = await kmToday(runner._id, date);

  res.json({
    serverTime: new Date(),
    dutyState: runner.dutyState,
    onDuty: !!(att && att.open),

    // Clock anchors - the app ticks from these, it does not trust its own wall clock.
    dutyStartedAt: openSince(att),
    dutyMinutesBefore: closedMinutes(att),
    dutyMinutesToday: att ? closedMinutes(att) + openMinutes(att) : 0,

    tripsToday: att ? att.tripsDone : 0,
    kmToday: km,
    odoStart: att ? att.startOdo : 0,

    ring: !!(trip && trip.status === 'ASSIGNED' && trip.alertPending),
    trip: trip ? tripCard(trip, runner.lastLocation) : null,
    config: { pingInterval: SLA.pingInterval, pollInterval: SLA.pollInterval }
  });
});

async function kmToday(runnerId, date) {
  const pings = await LocationPing.find({
    runner: runnerId,
    at: { $gte: istDayStart(date), $lt: istDayEnd(date) }
  }).select('lat lng at').sort({ at: 1 }).lean();
  return kmFromPings(pings);
}

// The app calls this once the alarm screen has actually opened, so it does not ring twice.
router.post('/alert-seen', async (req, res) => {
  await Trip.updateOne({ _id: req.body.tripId, runner: req.user._id }, { alertPending: false, alertShownAt: new Date() });
  res.json({ ok: true });
});

router.get('/trip/active', async (req, res) => {
  const trip = await Trip.findOne({ runner: req.user._id, status: { $nin: ['COMPLETED', 'REJECTED', 'CANCELLED'] } }).populate(POP).lean();
  res.json(trip ? tripCard(trip, req.user.lastLocation) : null);
});

/* ------------------------------------------------------------------ *
 * Job lists - today and the recent days
 * ------------------------------------------------------------------ */

// GET /api/runner/trips?days=5  -> today first, then the previous days.
// The app shows today's list open and the older days collapsed.
router.get('/trips', async (req, res) => {
  const days = Math.min(14, Math.max(1, Number(req.query.days) || 5));
  const today = ISTDate();
  const from = new Date(istDayStart(today).getTime() - (days - 1) * 24 * 3600 * 1000);

  const trips = await Trip.find({ runner: req.user._id, assignedAt: { $gte: from } })
    .populate(POP).sort({ assignedAt: -1 }).lean();

  // Group by IST date so the app does not have to do date maths.
  const groups = {};
  for (const t of trips) {
    const d = ISTDate(new Date(t.assignedAt));
    if (!groups[d]) groups[d] = [];
    groups[d].push(tripCard(t, req.user.lastLocation));
  }

  const out = Object.keys(groups).sort().reverse().map(d => ({
    date: d,
    isToday: d === today,
    trips: groups[d],
    done: groups[d].filter(x => x.status === 'COMPLETED').length,
    total: groups[d].length
  }));

  res.json({ days: out, today });
});

// Kept for older app builds.
router.get('/trips/today', async (req, res) => {
  const from = istDayStart(ISTDate());
  const trips = await Trip.find({ runner: req.user._id, assignedAt: { $gte: from } }).populate(POP).sort({ assignedAt: -1 }).lean();
  res.json(trips.map(t => tripCard(t, req.user.lastLocation)));
});

/* ------------------------------------------------------------------ *
 * Day summary - hours and kilometres, for the runner's own screen
 * ------------------------------------------------------------------ */

// GET /api/runner/summary?days=5
router.get('/summary', async (req, res) => {
  const days = Math.min(31, Math.max(1, Number(req.query.days) || 5));
  const today = ISTDate();
  const dates = [];
  for (let i = 0; i < days; i++) {
    // Noon offset keeps the date arithmetic safe across the IST boundary.
    dates.push(ISTDate(new Date(istDayStart(today).getTime() - i * 24 * 3600 * 1000 + 12 * 3600 * 1000)));
  }

  const rows = await Attendance.find({ runner: req.user._id, date: { $in: dates } }).lean();
  const byDate = {};
  rows.forEach(r => { byDate[r.date] = r; });

  const from = istDayStart(dates[dates.length - 1]);
  const pings = await LocationPing.find({ runner: req.user._id, at: { $gte: from } })
    .select('lat lng at').sort({ at: 1 }).lean();

  const bucket = {};
  pings.forEach(p => {
    const d = ISTDate(new Date(p.at));
    if (!bucket[d]) bucket[d] = [];
    bucket[d].push(p);
  });
  const kmByDate = {};
  Object.keys(bucket).forEach(d => { kmByDate[d] = kmFromPings(bucket[d]); });

  const out = dates.map(d => {
    const a = byDate[d];
    const minutes = a ? closedMinutes(a) + (d === today ? openMinutes(a) : 0) : 0;
    return {
      date: d,
      isToday: d === today,
      minutes,
      hours: Math.round((minutes / 60) * 10) / 10,
      trips: a ? a.tripsDone : 0,
      km: kmByDate[d] || 0,
      odoKm: a ? a.odoKm : 0,
      startOdo: a ? a.startOdo : 0,
      endOdo: a ? a.endOdo : 0,
      open: !!(a && a.open)
    };
  });

  const totals = out.reduce((s, r) => ({
    minutes: s.minutes + r.minutes,
    trips: s.trips + r.trips,
    km: Math.round((s.km + r.km) * 10) / 10
  }), { minutes: 0, trips: 0, km: 0 });

  res.json({ serverTime: new Date(), today: out[0], days: out, totals });
});

/* ------------------------------------------------------------------ *
 * Stage changes
 * ------------------------------------------------------------------ */

// A phone clock can be wrong or deliberately changed. Accept a stated time only if it is
// in the past and within the last 24 hours; anything else falls back to server time.
function safeTime(raw) {
  if (!raw) return new Date();
  const t = new Date(raw);
  if (isNaN(t.getTime())) return new Date();
  const now = Date.now();
  if (t.getTime() > now + 60000) return new Date();
  if (now - t.getTime() > 24 * 3600 * 1000) return new Date();
  return t;
}

async function doStage(user, tripId, body) {
  const trip = await Trip.findById(tripId);
  if (!trip) return { error: 'Job not found', code: 404 };
  if (String(trip.runner) !== String(user._id)) return { error: 'This job is not assigned to you', code: 403 };

  // Replaying the same stage after an offline sync is not an error - just report success.
  if (trip.status === body.stage) {
    const same = await Trip.findById(trip._id).populate(POP).lean();
    return { trip: tripCard(same, user.lastLocation), duplicate: true };
  }

  if (body.stage === 'COMPLETED' && trip.type === 'BLOOD_DELIVERY' && !body.proofPhoto && !trip.proofPhoto) {
    return { error: 'Take a photo of the handed-over pack to finish', code: 400 };
  }

  await applyStage(trip, body.stage, {
    lat: body.lat, lng: body.lng, note: body.note,
    barcode: body.barcode, units: body.units,
    proofPhoto: body.proofPhoto,
    at: safeTime(body.at), by: 'runner'
  });

  const fresh = await Trip.findById(trip._id).populate(POP).lean();
  return { trip: tripCard(fresh, user.lastLocation) };
}

// Every stage button in the app lands here: accept, reject, reached, collected, delivered.
// `at` is the time the runner actually pressed the button. When a stage was pressed offline
// and synced later, that original time is what gets stamped - not the upload time - so the
// TAT report stays honest.
router.post('/trip/:id/stage', upload.single('photo'), async (req, res, next) => {
  try {
    const proofPhoto = await storePhoto(req.file, {
      kind: 'PROOF', runner: req.user._id, trip: req.params.id,
      lat: req.body.lat, lng: req.body.lng
    });
    const result = await doStage(req.user, req.params.id, {
      stage: req.body.stage,
      lat: req.body.lat, lng: req.body.lng, note: req.body.note,
      barcode: req.body.barcode, units: req.body.units,
      at: req.body.at,
      proofPhoto
    });
    if (result.error) return res.status(result.code || 400).json({ error: result.error });
    res.json(result.trip);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ *
 * Attendance - punch in / punch out with an odometer photo
 * ------------------------------------------------------------------ */

async function punchIn(user, body) {
  const date = ISTDate();
  let att = await Attendance.findOne({ runner: user._id, date });
  if (!att) att = new Attendance({ runner: user._id, date, sessions: [] });
  if (att.sessions.some(s => s.inAt && !s.outAt)) return { error: 'You are already punched in' };
  if (!body.lat || !body.lng) return { error: 'Turn on location to punch in' };

  const odo = Number(body.odo || 0);
  const firstOfDay = att.sessions.length === 0;
  if (firstOfDay && !odo) return { error: 'Enter the bike meter reading to start the day' };

  // The meter only moves forward. A reading below today's close is a typing mistake.
  if (odo && att.endOdo && odo < att.endOdo) {
    return { error: 'Meter reading cannot be less than ' + att.endOdo };
  }

  const at = safeTime(body.at);
  att.sessions.push({
    inAt: at, inLat: Number(body.lat), inLng: Number(body.lng), inAddress: body.address || '',
    inOdo: odo || undefined, inOdoPhoto: body.odoPhoto || undefined
  });
  if (firstOfDay || !att.startOdo) {
    att.startOdo = odo || att.startOdo;
    att.startOdoPhoto = body.odoPhoto || att.startOdoPhoto;
  }
  att.open = true;
  await att.save();

  user.dutyState = user.activeTrip ? 'ON_TRIP' : 'AVAILABLE';
  user.lastLocation = { lat: Number(body.lat), lng: Number(body.lng), at };
  user.lastSeenAt = new Date();
  await user.save();
  realtime.emit('runner:status', { runnerId: String(user._id), dutyState: user.dutyState });

  return { ok: true, at, dutyState: user.dutyState, startOdo: att.startOdo };
}

async function punchOut(user, body) {
  const date = ISTDate();
  const att = await Attendance.findOne({ runner: user._id, date });
  const open = att && att.sessions.find(s => s.inAt && !s.outAt);
  if (!open) return { error: 'You are not punched in' };
  if (user.activeTrip) return { error: 'Finish your running job before punching out' };

  const odo = Number(body.odo || 0);
  if (!odo) return { error: 'Enter the bike meter reading to close the day' };
  if (att.startOdo && odo < att.startOdo) {
    return { error: 'Meter reading cannot be less than the morning reading (' + att.startOdo + ')' };
  }

  const at = safeTime(body.at);
  open.outAt = at;
  open.outLat = Number(body.lat || 0);
  open.outLng = Number(body.lng || 0);
  open.outAddress = body.address || '';
  open.outOdo = odo;
  open.outOdoPhoto = body.odoPhoto || undefined;
  open.minutes = Math.max(0, Math.round((open.outAt - new Date(open.inAt)) / 60000));

  att.totalMinutes = att.sessions.reduce((s, x) => s + (x.minutes || 0), 0);
  att.endOdo = odo;
  att.endOdoPhoto = body.odoPhoto || att.endOdoPhoto;
  att.odoKm = att.startOdo && odo > att.startOdo ? odo - att.startOdo : att.odoKm;
  att.distanceKm = await kmToday(user._id, date);
  att.open = false;
  await att.save();

  user.dutyState = 'OFF_DUTY';
  await user.save();
  realtime.emit('runner:status', { runnerId: String(user._id), dutyState: 'OFF_DUTY' });

  return { ok: true, minutes: open.minutes, totalMinutes: att.totalMinutes, odoKm: att.odoKm, gpsKm: att.distanceKm };
}

async function setBreak(user, on) {
  if (on && user.activeTrip) throw new Error('Finish your running job before taking a break');
  user.dutyState = on ? 'BREAK' : (user.activeTrip ? 'ON_TRIP' : 'AVAILABLE');
  await user.save();
  realtime.emit('runner:status', { runnerId: String(user._id), dutyState: user.dutyState });
  return user.dutyState;
}

router.post('/punch-in', upload.single('photo'), async (req, res) => {
  const odoPhoto = await storePhoto(req.file, {
    kind: 'ODO_IN', runner: req.user._id, lat: req.body.lat, lng: req.body.lng
  });
  const r = await punchIn(req.user, {
    lat: req.body.lat, lng: req.body.lng, address: req.body.address,
    odo: req.body.odo, at: req.body.at, odoPhoto
  });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(Object.assign({ message: 'Punch in done' }, r));
});

router.post('/punch-out', upload.single('photo'), async (req, res) => {
  const odoPhoto = await storePhoto(req.file, {
    kind: 'ODO_OUT', runner: req.user._id, lat: req.body.lat, lng: req.body.lng
  });
  const r = await punchOut(req.user, {
    lat: req.body.lat, lng: req.body.lng, address: req.body.address,
    odo: req.body.odo, at: req.body.at, odoPhoto
  });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(Object.assign({ message: 'Punch out done' }, r));
});

// Break lets the desk see he is off the pool without ending the shift.
router.post('/break', async (req, res) => {
  try {
    const dutyState = await setBreak(req.user, !!req.body.on);
    res.json({ ok: true, dutyState });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/attendance', async (req, res) => {
  const rows = await Attendance.find({ runner: req.user._id }).sort({ date: -1 }).limit(60).lean();
  res.json(rows.map(r => Object.assign({}, r, { liveMinutes: closedMinutes(r) + openMinutes(r) })));
});

/* ------------------------------------------------------------------ *
 * Offline sync
 * ------------------------------------------------------------------ */

// The app keeps every action it could not send in a queue on the phone and posts the whole
// queue here the moment the network comes back. Each entry carries the time it actually
// happened. Entries are applied in order and each one reports its own result, so one bad
// entry never blocks the rest - the app drops the ones that succeeded and retries the others.
//
// Photos cannot travel in this JSON queue; a stage that needs a photo stays queued in the
// app and is sent through /trip/:id/stage as multipart once there is a network.
router.post('/sync', async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 200) : [];
  const results = [];

  for (const item of items) {
    const id = item.id || null;
    try {
      if (item.kind === 'stage') {
        const r = await doStage(req.user, item.tripId, item);
        results.push({ id, ok: !r.error, error: r.error || null, duplicate: !!r.duplicate });
      } else if (item.kind === 'punch-in') {
        const r = await punchIn(req.user, item);
        results.push({ id, ok: !r.error, error: r.error || null });
      } else if (item.kind === 'punch-out') {
        const r = await punchOut(req.user, item);
        results.push({ id, ok: !r.error, error: r.error || null });
      } else if (item.kind === 'break') {
        await setBreak(req.user, !!item.on);
        results.push({ id, ok: true, error: null });
      } else {
        results.push({ id, ok: false, error: 'Unknown action' });
      }
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }

  res.json({ ok: true, serverTime: new Date(), results });
});

/* ------------------------------------------------------------------ *
 * Location pings
 * ------------------------------------------------------------------ */

// Location batch. The app queues pings offline and flushes them when the network returns.
router.post('/ping', async (req, res) => {
  const list = Array.isArray(req.body.pings) ? req.body.pings : [req.body];
  const clean = list
    .filter(p => p && p.lat && p.lng)
    .map(p => ({
      runner: req.user._id,
      trip: p.tripId || req.user.activeTrip || null,
      lat: Number(p.lat), lng: Number(p.lng),
      accuracy: Number(p.accuracy || 0), speed: Number(p.speed || 0),
      battery: Number(p.battery || 0),
      mock: !!p.mock,
      at: p.at ? new Date(p.at) : new Date()
    }));

  if (clean.length) {
    await LocationPing.insertMany(clean, { ordered: false }).catch(() => {});
    const sorted = clean.slice().sort((a, b) => a.at - b.at);
    const last = sorted[sorted.length - 1];
    req.user.lastLocation = { lat: last.lat, lng: last.lng, accuracy: last.accuracy, speed: last.speed, battery: last.battery, at: last.at };
    req.user.lastSeenAt = new Date();

    // A fake-GPS app marks its fixes as mock. Record it and let the desk see it.
    const anyMock = clean.some(p => p.mock);
    if (anyMock) await flagIntegrity(req.user, { mockLocation: true });
    else await req.user.save();

    realtime.emit('runner:location', Object.assign({
      runnerId: String(req.user._id), name: req.user.name,
      dutyState: req.user.dutyState, mock: anyMock
    }, req.user.lastLocation));
  }
  res.json({ ok: true, saved: clean.length, serverTime: new Date() });
});

/* ------------------------------------------------------------------ *
 * Integrity signals
 * ------------------------------------------------------------------ */

async function flagIntegrity(user, flags) {
  const before = user.integrity || {};
  const now = new Date();
  const raised = Object.keys(flags).some(k => flags[k] && !before[k]);

  user.integrity = {
    vpn: flags.vpn !== undefined ? !!flags.vpn : !!before.vpn,
    mockLocation: flags.mockLocation !== undefined ? !!flags.mockLocation : !!before.mockLocation,
    rooted: flags.rooted !== undefined ? !!flags.rooted : !!before.rooted,
    devMode: flags.devMode !== undefined ? !!flags.devMode : !!before.devMode,
    at: now,
    lastFlaggedAt: (flags.vpn || flags.mockLocation || flags.rooted) ? now : before.lastFlaggedAt,
    flagCount: (before.flagCount || 0) + (raised ? 1 : 0)
  };
  await user.save();

  if (raised) {
    realtime.emit('runner:integrity', Object.assign({
      runnerId: String(user._id), name: user.name
    }, user.integrity));
  }
  return user.integrity;
}

// The app reports what it can see about its own environment. These are hints for the desk,
// never a lock: a client side check can always be defeated, so the value is in the record,
// not in the blocking.
router.post('/integrity', async (req, res) => {
  const integrity = await flagIntegrity(req.user, {
    vpn: !!req.body.vpn,
    mockLocation: !!req.body.mockLocation,
    rooted: !!req.body.rooted,
    devMode: !!req.body.devMode
  });
  if (req.body.appVersion) {
    req.user.appVersion = String(req.body.appVersion).slice(0, 30);
    await req.user.save();
  }
  res.json({ ok: true, integrity, serverTime: new Date() });
});

// Plain clock endpoint. The app calls it on start so its timers are anchored to the
// server even when the phone's own date and time are wrong.
router.get('/time', (req, res) => res.json({ serverTime: new Date() }));

module.exports = router;
