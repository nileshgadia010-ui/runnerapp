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
const { applyStage, labelFor, jobTitle, queueFor, currentOf, IN_HAND, ISTDate, ACTIVE, RANK, STAGE_FIELD, FLOW, PERISHABLE } = require('../services/dispatch');
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
  { path: 'case', select: 'caseNo jobType patientName reference patientAge patientGender bloodGroup component unitsRequested priority wardBed attendantName attendantPhone remarks amount amountAgainst packageDetails' },
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
    lat: p.lat, lng: p.lng, contactPerson: p.contactPerson,
    // The app uses this to tell the runner he has arrived, so it has to travel with the
    // place rather than being a constant baked into the phone. A small clinic and a
    // sprawling civil hospital do not deserve the same circle.
    geofence: p.geofence || 200
  };
}

// The runner needs the patient's name only when he is physically handing units to that
// patient's bedside - that is the check that stops the wrong bag reaching the wrong person.
// For a sample pickup or any of the errand jobs, the hospital, ward and reference are enough,
// so the name simply never leaves the office. Less patient data on a phone that lives in a
// pocket on a bike is the right default.
function runnerFacingName(t) {
  const c = t.case || {};
  if (t.type === 'BLOOD_DELIVERY') return c.patientName || c.reference || '';
  return c.reference || c.caseNo || '';
}

function tripCard(t, from) {
  const sample = t.type === 'SAMPLE_PICKUP';
  const blood = sample || t.type === 'BLOOD_DELIVERY';
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
    headline: jobTitle(t.type),
    jobType: t.case ? t.case.jobType : 'BLOOD',
    caseNo: t.case && t.case.caseNo,

    // "Who or what is this job for", already filtered for what the runner should see.
    patientName: runnerFacingName(t),
    reference: t.case && t.case.reference,

    // Only present on the job types that use them, so the phone can hide the rest.
    amount: t.case && t.case.amount ? t.case.amount : null,
    amountAgainst: t.case && t.case.amountAgainst,
    packageDetails: t.case && t.case.packageDetails,
    amountCollected: t.amountCollected,

    patientAge: blood && t.case ? t.case.patientAge : null,
    patientGender: blood && t.case ? t.case.patientGender : null,
    bloodGroup: blood && t.case ? t.case.bloodGroup : null,
    component: blood && t.case ? t.case.component : null,
    units: blood && t.case ? t.case.unitsRequested : null,
    priority: t.case && t.case.priority,
    wardBed: t.case && t.case.wardBed,
    attendantName: t.case && t.case.attendantName,
    attendantPhone: t.case && t.case.attendantPhone,
    remarks: t.case && t.case.remarks,
    pickup: place(t.pickupLocation),
    drop: place(t.dropLocation),
    // Ids, so the phone can tell that three jobs start at the same blood centre and offer to
    // collect them in one stop.
    pickupId: t.pickupLocation ? String(t.pickupLocation._id || t.pickupLocation) : null,
    dropId: t.dropLocation ? String(t.dropLocation._id || t.dropLocation) : null,
    // How many bottles / bags the job is for. Blood delivery and package delivery both carry
    // a count; it is what the runner confirms when he picks up.
    bottles: (t.type === 'BLOOD_DELIVERY' || t.type === 'PACKAGE_DELIVER')
      ? (t.unitsCarried || (t.case && t.case.unitsRequested) || null) : null,
    queueOrder: t.queueOrder,
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
  // A plain update, not a document save: the poll runs every few seconds per phone and a
  // full save re-validates and rewrites the whole user every time.
  User.updateOne({ _id: runner._id }, { lastSeenAt: new Date() }).catch(() => {});

  // Every job he holds, in his order, fully loaded in ONE query. This used to be four - the
  // queue, then the head again, then the ringing one again, then all of them again - and on
  // the free database tier each one is a noticeable wait.
  const full = await Trip.find({ runner: runner._id, status: { $in: ACTIVE } })
    .sort({ queueOrder: 1, assignedAt: 1 }).populate(POP).lean();

  // A runner can hold more than one job. Show him the one he is actually on - anything he
  // has in his hand beats anything merely assigned - and list every one of them.
  const trip = currentOf(full);

  // The one ringing is the oldest job he has not accepted yet - which is usually, but not
  // always, the one on screen.
  const ringing = full.find(t => t.status === 'ASSIGNED' && t.alertPending) || null;

  const cards = full.map((t, i) => Object.assign(tripCard(t, runner.lastLocation), {
    isCurrent: !!trip && String(t._id) === String(trip._id),
    waiting: t.status === 'ASSIGNED',
    inHand: IN_HAND.includes(t.status),
    position: i + 1
  }));

  const date = ISTDate();
  const [att, km] = await Promise.all([
    Attendance.findOne({ runner: runner._id, date }).lean(),
    kmTodayCached(runner._id, date)
  ]);

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

    // The phone rings for ANY job still waiting to be accepted, not only the one on screen.
    // A runner carrying a sample can be given the next errand while he rides, and he has to
    // hear about it then - which is the whole point of stacking work behind him.
    ring: !!ringing,
    ringTrip: ringing ? tripCard(ringing, runner.lastLocation) : null,

    trip: trip ? tripCard(trip, runner.lastLocation) : null,

    // Everything he is holding, in the order he means to do it, so the phone can show the
    // list and let him pick a different one to head for.
    queue: cards,
    jobsInHand: cards.length,
    queued: Math.max(0, cards.length - (trip ? 1 : 0)),
    config: { pingInterval: SLA.pingInterval, idlePingInterval: SLA.idlePingInterval, pollInterval: SLA.pollInterval }
  });
});

/*
 * Today's kilometres, remembered for a minute.
 *
 * Working them out means reading every location point of the day and cleaning the trail -
 * thousands of rows by the afternoon. The poll used to do that on every call, from two loops
 * on the phone, every five seconds, which is a large part of why a stage change took so long
 * to show: the server was busy recounting the morning's ride. A figure a minute old is fine
 * for a counter on the home screen.
 */
const kmCache = new Map();
async function kmTodayCached(runnerId, date) {
  const key = String(runnerId) + '|' + date;
  const hit = kmCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.km;
  const km = await kmToday(runnerId, date);
  kmCache.set(key, { at: Date.now(), km });
  if (kmCache.size > 500) kmCache.delete(kmCache.keys().next().value);
  return km;
}

async function kmToday(runnerId, date) {
  const pings = await LocationPing.find({
    runner: runnerId,
    at: { $gte: istDayStart(date), $lt: istDayEnd(date) }
  }).select('lat lng at accuracy mock').sort({ at: 1 }).lean();
  return kmFromPings(pings);
}

// The app calls this once the alarm screen has actually opened, so it does not ring twice.
router.post('/alert-seen', async (req, res) => {
  await Trip.updateOne({ _id: req.body.tripId, runner: req.user._id }, { alertPending: false, alertShownAt: new Date() });
  res.json({ ok: true });
});

router.get('/trip/active', async (req, res) => {
  const head = currentOf(await queueFor(req.user._id));
  const trip = head ? await Trip.findById(head._id).populate(POP).lean() : null;
  res.json(trip ? tripCard(trip, req.user.lastLocation) : null);
});

/*
 * One particular job of his.
 *
 * The trip screen used to load "/trip/active" whatever job it was opened for - so tapping
 * the Nirogyam job in his list opened the Sahyog job, because Sahyog was the one at the
 * front. Every job in the list now opens itself.
 */
router.get('/trip/:id', async (req, res, next) => {
  try {
    let t = null;
    try { t = await Trip.findById(req.params.id).populate(POP).lean(); }
    catch (e) { if (e.name !== 'CastError') throw e; }
    if (!t || String(t.runner) !== String(req.user._id)) return res.status(404).json({ error: 'Job not found' });
    res.json(Object.assign(tripCard(t, req.user.lastLocation), {
      closed: ['COMPLETED', 'REJECTED', 'CANCELLED'].includes(t.status)
    }));
  } catch (e) { next(e); }
});

/**
 * Giving a job back.
 *
 * A shift does not always go the way the desk planned it: the bike gives up, the hospital
 * says come tomorrow, he is sent home sick. Until now the only way out was for somebody at
 * the desk to notice and cancel it, so jobs sat on a runner all day looking active.
 *
 * He may hand back anything he has not yet collected. Once a sample or a bag of units is in
 * his hand the button is gone - that is a phone call to the desk, not a tap, because
 * something perishable is now somewhere the system would stop tracking.
 */
router.post('/trip/:id/handback', async (req, res, next) => {
  try {
    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ error: 'Job not found' });
    if (String(trip.runner) !== String(req.user._id)) {
      return res.status(403).json({ error: 'This job is not assigned to you' });
    }
    if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(trip.status)) {
      return res.status(400).json({ error: 'This job is already closed' });
    }
    if (IN_HAND.includes(trip.status)) {
      return res.status(409).json({
        error: 'You are already carrying this one. Deliver it, or call the desk.'
      });
    }

    const reason = String((req.body && req.body.reason) || '').trim();
    if (reason.length < 3) {
      return res.status(400).json({ error: 'Say why, so the desk can send someone else' });
    }

    await applyStage(trip, 'REJECTED', {
      note: reason, at: safeTime(req.body && req.body.at), by: 'runner'
    });

    res.json({ ok: true, message: 'Given back. The desk can send someone else.' });
  } catch (e) { next(e); }
});

/**
 * "Do this one next."
 *
 * A runner holding two jobs knows the roads better than the desk does. If the second place
 * is on his way and the first is not, letting him take it first saves a leg - so he can move
 * any waiting job to the front and the app will start navigating to it.
 *
 * The one thing he may NOT do is walk away from something he is already carrying. Once a
 * sample or a bag of units is in his hand it is on a clock and, for blood, on a temperature
 * limit; wandering off to collect a payment with it is exactly the failure the TAT report
 * exists to catch. Errands that carry nothing perishable have no such restriction.
 */
router.post('/trip/:id/focus', async (req, res, next) => {
  try {
    const queue = await queueFor(req.user._id);
    const wanted = queue.find(t => String(t._id) === String(req.params.id));
    if (!wanted) return res.status(404).json({ error: 'That job is not in your list' });

    const current = currentOf(queue);
    if (current && String(current._id) === String(wanted._id)) {
      return res.json({ ok: true, unchanged: true });
    }

    const perishable = t => PERISHABLE.includes(t.type);

    // Switching between two things he is already carrying is fine - both are in his bag
    // either way, and the order he drops them is his call.
    if (current && IN_HAND.includes(current.status) && perishable(current) && !IN_HAND.includes(wanted.status)) {
      return res.status(409).json({
        error: 'Finish ' + (current.tripNo || 'the job in your hand') +
          ' first - you are carrying something that has to be delivered. Drop it, then this one opens up.'
      });
    }

    // Renumber so the chosen job sits at the front and the rest keep their order behind it.
    const rest = queue.filter(t => String(t._id) !== String(wanted._id));
    await Trip.updateOne({ _id: wanted._id }, { queueOrder: 0 });
    for (let i = 0; i < rest.length; i++) {
      await Trip.updateOne({ _id: rest[i]._id }, { queueOrder: i + 1 });
    }

    req.user.activeTrip = wanted._id;
    await req.user.save();

    realtime.emit('trip:update', {
      tripId: String(wanted._id), status: wanted.status, runnerId: String(req.user._id)
    });

    const fresh = await Trip.findById(wanted._id).populate(POP).lean();
    res.json({ ok: true, trip: tripCard(fresh, req.user.lastLocation) });
  } catch (e) { next(e); }
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
    .select('lat lng at accuracy mock').sort({ at: 1 }).lean();

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

// Hands this job's arrival photo to the jobs that were collected together with it and are
// still without one.
async function shareArrivalPhoto(trip) {
  if (!trip || !trip.arrivalPhoto) return;
  await Trip.updateMany(
    { collectedWith: trip._id, runner: trip.runner, $or: [{ arrivalPhoto: null }, { arrivalPhoto: '' }] },
    { $set: { arrivalPhoto: trip.arrivalPhoto } });
}

/*
 * Moves one stage's time earlier, keeping the whole run in order: anything before it that is
 * now later is pulled back to it, and anything after it that was stamped at the same moment
 * (because it was inferred from it) moves with it.
 */
function moveEarlier(trip, stage, at) {
  const f = STAGE_FIELD[stage];
  if (!f) return false;
  const old = trip[f] ? new Date(trip[f]).getTime() : null;
  if (old !== null && at.getTime() >= old) return false;
  trip[f] = at;
  FLOW.slice(1).forEach(s => {
    const g = STAGE_FIELD[s];
    if (!g || g === f || !trip[g]) return;
    const v = new Date(trip[g]).getTime();
    if (RANK[s] < RANK[stage] && v > at.getTime()) trip[g] = at;
    if (RANK[s] > RANK[stage] && old !== null && v === old) trip[g] = at;
  });
  return true;
}

// Fills in what a late replay knows and the trip does not. Returns true if anything changed.
async function backfill(trip, body) {
  let changed = false;
  if (body.proofPhoto) {
    if (body.stage === 'AT_PICKUP' && !trip.arrivalPhoto) { trip.arrivalPhoto = body.proofPhoto; changed = true; }
    else if (body.stage !== 'AT_PICKUP' && !trip.proofPhoto) { trip.proofPhoto = body.proofPhoto; changed = true; }
  }
  if (body.units !== undefined && body.units !== null && body.units !== '' && !trip.unitsCarried) {
    trip.unitsCarried = Number(body.units); changed = true;
  }
  if (body.amount !== undefined && body.amount !== null && body.amount !== '' && !trip.amountCollected) {
    trip.amountCollected = Number(body.amount);
    if (body.paymentMode) trip.paymentMode = body.paymentMode;
    changed = true;
  }
  if (body.barcode && !trip.sampleBarcode) { trip.sampleBarcode = body.barcode; changed = true; }

  // The real moment beats an inferred one. Only ever earlier, never later, so a replay
  // cannot stretch a span that was already right - and never out of order (moveEarlier).
  const at = body.at ? safeTime(body.at) : null;
  const stamps = body.andPicked ? ['AT_PICKUP', 'PICKED'] : [body.stage];
  if (at) stamps.forEach(s => { if (moveEarlier(trip, s, at)) changed = true; });
  if (changed && trip.events) {
    trip.events.push({ status: body.andPicked ? 'PICKED' : body.stage, at: at || new Date(),
      note: 'Late upload from the phone', by: 'runner' });
  }
  return changed;
}

async function doStage(user, tripId, body) {
  const trip = await Trip.findById(tripId);
  if (!trip) return { error: 'Job not found', code: 404 };
  if (String(trip.runner) !== String(user._id)) return { error: 'This job is not assigned to you', code: 403 };

  const done = async (duplicate) => {
    const fresh = await Trip.findById(trip._id).populate(POP).lean();
    return { trip: tripCard(fresh, user.lastLocation), duplicate: !!duplicate };
  };

  // A job the desk took back. Say so plainly, so the phone drops it instead of retrying.
  if (['CANCELLED', 'REJECTED'].includes(trip.status)) {
    return { error: 'This job was ' + (trip.status === 'CANCELLED' ? 'cancelled by the desk' : 'given back') +
      ' and is no longer yours', code: 409 };
  }

  /*
   * A stage that is not ahead of where the trip already is: a late replay.
   *
   * The phone has two upload queues, and the arrival photo can land after the handover - or
   * after the desk finished the job from the portal. That is not an error and must never be
   * answered with one, or the phone gives up on it. Report success, and keep whatever the late
   * press carried that the trip does not have yet: the arrival photo, the count, the cash, and
   * the real time he arrived if all we had was a guess.
   */
  const target = body.andPicked ? 'PICKED' : body.stage;
  if (RANK[trip.status] !== undefined && RANK[body.stage] !== undefined && RANK[target] <= RANK[trip.status]) {
    if (await backfill(trip, body)) await trip.save();
    await shareArrivalPhoto(trip);
    return done(true);
  }

  // "Reached, and I have it" on a trip already standing at the pickup (the desk set it, or an
  // older build stopped there): the arrival part is already true, so file the picture against
  // it and move on to the collection.
  if (body.andPicked && trip.status === 'AT_PICKUP') {
    if (await backfill(trip, Object.assign({}, body, { andPicked: false, stage: 'AT_PICKUP' }))) await trip.save();
    await applyStage(trip, 'PICKED', {
      lat: body.lat, lng: body.lng, note: body.note, barcode: body.barcode, units: body.units,
      amount: body.amount, paymentMode: body.paymentMode, paymentRef: body.paymentRef,
      at: safeTime(body.at), by: 'runner'
    });
    await shareArrivalPhoto(trip);
    return done(false);
  }

  if (body.stage === 'COMPLETED' && trip.type === 'BLOOD_DELIVERY' && !body.proofPhoto && !trip.proofPhoto) {
    return { error: 'Take a photo of the handed-over pack to finish', code: 400 };
  }

  /*
   * The arrival photo is compulsory in the APP, not here.
   *
   * It was enforced here first, and that was a mistake: a phone still running the previous
   * build cannot send one, so every runner who had not yet updated was simply unable to
   * record that he had arrived. A rule that stops real work in a blood service is worse
   * than the gap it closes.
   *
   * So the app is what insists - the camera opens and there is no way past it - and the
   * server records honestly whether a picture actually came. An arrival with no photo is
   * accepted, marked, and visible on the dashboard, which is the useful outcome: the work
   * continues and the office can see whose phone needs updating.
   */

  const opts = {
    lat: body.lat, lng: body.lng, note: body.note,
    barcode: body.barcode, units: body.units,
    amount: body.amount, paymentMode: body.paymentMode, paymentRef: body.paymentRef,
    proofPhoto: body.proofPhoto,
    at: safeTime(body.at), by: 'runner'
  };

  await applyStage(trip, body.stage, opts);

  /*
   * One tap, two stages.
   *
   * The runner presses "I have reached X" once; standing in a hospital corridor pressing a
   * second button to say he is now leaving with the thing is work the job does not deserve.
   * So the arrival and the collection are stamped together, from a single request - which
   * also means one round trip on a phone in traffic, and one entry in the offline queue
   * instead of two that could be split by a dropped connection.
   *
   * The cost is that "time spent at the pickup" is now always zero. That is honest: with one
   * button there is nothing left to measure it with. Every other TAT figure is unchanged.
   */
  if (body.andPicked && trip.status === 'AT_PICKUP') {
    // The picture belongs to the arrival and has already been filed there. Passing it again
    // would write it a second time as the handover proof, and the real handover photo taken
    // an hour later would then look like a correction rather than a separate moment.
    await applyStage(trip, 'PICKED', Object.assign({}, opts, { proofPhoto: undefined }));
  }

  // Collected together with another job at the same counter: one photo was taken, for that
  // one. Remember the link, and use that picture here - now if it has already arrived, or
  // later, when it does (see shareArrivalPhoto), since the photo usually uploads after these.
  if (body.withTrip) {
    const other = await Trip.findById(body.withTrip).select('arrivalPhoto runner').lean();
    if (other && String(other.runner) === String(user._id)) {
      trip.collectedWith = other._id;
      if (!trip.arrivalPhoto && other.arrivalPhoto) trip.arrivalPhoto = other.arrivalPhoto;
      await trip.save();
    }
  }
  await shareArrivalPhoto(trip);

  return done(false);
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
    // A picture was sent but could not be kept. Say "try again" rather than recording the
    // stage without it - the phone still has the file and will resend it.
    if (req.file && req.file.buffer && req.file.buffer.length && !proofPhoto) {
      return res.status(503).json({ error: 'The photo could not be saved just now. It will be sent again.', retry: true });
    }
    const result = await doStage(req.user, req.params.id, {
      stage: req.body.stage,
      lat: req.body.lat, lng: req.body.lng, note: req.body.note,
      barcode: req.body.barcode, units: req.body.units,
      amount: req.body.amount, paymentMode: req.body.paymentMode, paymentRef: req.body.paymentRef,
      at: req.body.at,
      // Sent as a form field, so it arrives as the string "1" rather than a boolean.
      andPicked: req.body.andPicked === '1' || req.body.andPicked === true || req.body.andPicked === 'true',
      withTrip: req.body.withTrip,
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
  // Read it fresh: in an offline batch the job's "handed over" is applied a moment earlier in
  // the same request, on a different copy of this user, and the copy the request started with
  // would still say he is on a job.
  const fresh = await User.findById(user._id).select('activeTrip').lean();
  if (fresh && fresh.activeTrip) return { error: 'Finish your running job before punching out' };

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
      // A refusal with a reason (e.status) is final. Anything else - the database blinked,
      // a timeout - is not the runner's fault, and the phone must keep it and try again.
      results.push({ id, ok: false, error: e.message, retry: !e.status });
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

/*
 * Attaches a detail to a trip after the fact, without moving its stage.
 *
 * The sample barcode used to block the runner in a hospital corridor: he could not tell us
 * he was leaving until he had typed a tube number. Now the stage goes first and the barcode
 * arrives here a moment later, if he has it. Nothing about the trip's timeline moves.
 */
router.post('/trip/:id/note', async (req, res) => {
  const trip = await Trip.findById(req.params.id);
  if (!trip) return res.status(404).json({ error: 'Job not found' });
  if (String(trip.runner) !== String(req.user._id)) {
    return res.status(403).json({ error: 'This job is not assigned to you' });
  }

  if (req.body.barcode) trip.sampleBarcode = String(req.body.barcode).slice(0, 60);
  if (req.body.note) trip.runnerNote = String(req.body.note).slice(0, 300);
  await trip.save();

  realtime.emit('trip:update', {
    tripId: String(trip._id), status: trip.status,
    runnerId: String(req.user._id), caseId: String(trip.case)
  });
  res.json({ ok: true, serverTime: new Date() });
});

// Plain clock endpoint. The app calls it on start so its timers are anchored to the
// server even when the phone's own date and time are wrong.
router.get('/time', (req, res) => res.json({ serverTime: new Date() }));

module.exports = router;
