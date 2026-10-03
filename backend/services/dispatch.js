const Trip = require('../models/Trip');
const Case = require('../models/Case');
const User = require('../models/User');
const Location = require('../models/Location');
const Attendance = require('../models/Attendance');
const { nextNumber } = require('../models/Counter');
const { distanceM } = require('./geo');
const realtime = require('./realtime');

const ACTIVE = ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE_PICKUP', 'AT_PICKUP', 'PICKED', 'EN_ROUTE_DROP', 'AT_DROP'];

const STAGE_FIELD = {
  ACCEPTED: 'acceptedAt',
  EN_ROUTE_PICKUP: 'startedAt',
  AT_PICKUP: 'atPickupAt',
  PICKED: 'pickedAt',
  EN_ROUTE_DROP: 'dropStartedAt',
  AT_DROP: 'atDropAt',
  COMPLETED: 'completedAt'
};

/*
 * Forward-only, but a runner may skip ahead.
 *
 * The full machine has seven stops, and pressing a button at every one of them is more work
 * than the job deserves - a man on a bike in traffic should be telling us three things: he
 * arrived, he has the thing and is leaving, he handed it over. The two "on the way" stages
 * are inferred from the stages either side of them (see applyStage), so the timeline the TAT
 * report reads is still complete even though nobody pressed a button for them.
 *
 * The desk can still set any of these explicitly, which is why the intermediate stages
 * remain valid targets rather than being deleted.
 */
/*
 * REJECTED is allowed right up until he has the thing in his hand.
 *
 * It used to be allowed only before accepting, which does not match how a shift goes: a
 * runner accepts, sets off, and then the bike gives up or the hospital says come tomorrow.
 * With no way to give the job back he either held it all day or the desk had to notice and
 * cancel it. After PICKED it is deliberately NOT allowed - once a sample is in his bag it
 * has to be delivered, and putting it down is a conversation with the desk, not a button.
 */
const NEXT = {
  ASSIGNED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['EN_ROUTE_PICKUP', 'AT_PICKUP', 'REJECTED', 'CANCELLED'],
  EN_ROUTE_PICKUP: ['AT_PICKUP', 'REJECTED', 'CANCELLED'],
  AT_PICKUP: ['PICKED', 'REJECTED', 'CANCELLED'],
  PICKED: ['EN_ROUTE_DROP', 'AT_DROP', 'COMPLETED', 'CANCELLED'],
  EN_ROUTE_DROP: ['AT_DROP', 'COMPLETED', 'CANCELLED'],
  AT_DROP: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: []
};

/*
 * Forward is always allowed.
 *
 * NEXT above lists the single steps, but a runner's phone does not always send them one at a
 * time. The arrival photo travels in one upload queue and the "handed over" press in another,
 * so on a weak connection the handover can reach the server before the arrival does. The old
 * rule refused it ("cannot move from Accepted to Delivered"), the phone took the refusal as
 * final and threw the press away - and the job sat on the dashboard as running, and on the
 * runner's screen in front of every newer job, after he had already delivered it.
 *
 * Moving forward is never a lie the runner can tell to his own advantage: he is saying the
 * work is further along than we knew. So any forward move is accepted and the skipped
 * timestamps are filled in (see fillTimes). Backward moves remain impossible; going back to an
 * earlier stage is treated as the late replay it is (see routes/runner.js doStage).
 */
const FLOW = ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE_PICKUP', 'AT_PICKUP', 'PICKED', 'EN_ROUTE_DROP', 'AT_DROP', 'COMPLETED'];
const RANK = Object.fromEntries(FLOW.map((s, i) => [s, i]));
const isForward = (from, to) => RANK[from] !== undefined && RANK[to] !== undefined && RANK[to] > RANK[from];

/**
 * Gives every stage between where the trip was and where it is now a timestamp, so the TAT
 * report never has a hole and never runs backwards.
 *
 *  - a skipped "on the way" stage is stamped with the moment he left the previous place
 *    (he set off when he accepted; he left the pickup when he picked up);
 *  - a skipped arrival is stamped with the next moment we do know (if he says he picked it
 *    up at 3:10 and never said when he arrived, he arrived at 3:10);
 *  - times the desk typed in (`manual`) win over anything inferred;
 *  - finally the whole run is made non-decreasing, because a phone clock a minute out must
 *    not produce a negative ride time.
 */
function fillTimes(trip, fromStatus, stage, now, manual) {
  manual = manual || {};
  const stages = FLOW.slice(1); // ACCEPTED .. COMPLETED
  const known = {};
  stages.forEach(s => { const v = trip[STAGE_FIELD[s]]; if (v) known[s] = new Date(v); });
  Object.keys(manual).forEach(s => { if (manual[s] && STAGE_FIELD[s]) known[s] = new Date(manual[s]); });
  if (!known[stage]) known[stage] = now;

  const lo = RANK[fromStatus] === undefined ? 0 : RANK[fromStatus];
  const hi = RANK[stage];
  const span = stages.filter(s => RANK[s] > lo && RANK[s] <= hi);

  const prevKnown = s => {
    for (let i = RANK[s] - 1; i >= 1; i--) if (known[FLOW[i]]) return known[FLOW[i]];
    return trip.assignedAt ? new Date(trip.assignedAt) : null;
  };
  const nextKnown = s => {
    for (let i = RANK[s] + 1; i <= hi; i++) if (known[FLOW[i]]) return known[FLOW[i]];
    return now;
  };

  span.forEach(s => {
    if (known[s]) return;
    const onTheWay = s === 'EN_ROUTE_PICKUP' || s === 'EN_ROUTE_DROP';
    known[s] = onTheWay ? (prevKnown(s) || nextKnown(s)) : nextKnown(s);
  });

  // Non-decreasing, oldest first.
  let last = trip.assignedAt ? new Date(trip.assignedAt) : null;
  stages.forEach(s => {
    if (!known[s]) return;
    if (last && known[s] < last) known[s] = new Date(last);
    last = known[s];
  });

  // Write back the span (and anything the desk typed), never touching what is outside it.
  stages.forEach(s => {
    const f = STAGE_FIELD[s];
    if (span.includes(s) || manual[s]) {
      if (!trip[f] || manual[s] || new Date(trip[f]).getTime() !== known[s].getTime()) trip[f] = known[s];
    }
  });
}

const ISTDate = (d = new Date()) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);

// What each job type is called, and what the runner is actually carrying.
const JOB = {
  SAMPLE_PICKUP:     { title: 'Collect sample',  counter: 'SPK', carry: 'Sample collected',        handover: 'Sample handed over' },
  BLOOD_DELIVERY:    { title: 'Deliver blood',   counter: 'DLV', carry: 'Blood units loaded',      handover: 'Blood delivered' },
  COLLECTION_SAMPLE: { title: 'Collect sample',  counter: 'COL', carry: 'Sample collected',        handover: 'Sample handed over' },
  PAYMENT_COLLECT:   { title: 'Collect payment', counter: 'PAY', carry: 'Payment collected',       handover: 'Payment handed over' },
  PACKAGE_DELIVER:   { title: 'Deliver package', counter: 'PKG', carry: 'Package picked up',       handover: 'Package delivered' }
};

function jobTitle(type) { return (JOB[type] || {}).title || 'Job'; }

function labelFor(type, stage) {
  const j = JOB[type] || JOB.SAMPLE_PICKUP;
  return ({
    ASSIGNED: 'New job assigned',
    ACCEPTED: 'Job accepted',
    EN_ROUTE_PICKUP: 'On the way to pick up',
    AT_PICKUP: 'Reached the pickup point',
    PICKED: j.carry,
    EN_ROUTE_DROP: 'On the way to drop',
    AT_DROP: 'Reached the drop point',
    COMPLETED: j.handover,
    REJECTED: 'Job declined',
    CANCELLED: 'Job cancelled'
  })[stage] || stage;
}

// A runner's queue, oldest first. The one he is working on is whichever has moved past
// ASSIGNED; if none has, it is the oldest one waiting.
async function queueFor(runnerId) {
  return Trip.find({ runner: runnerId, status: { $in: ACTIVE } })
    .sort({ queueOrder: 1, assignedAt: 1 }).lean();
}

/**
 * Picks the trip the app should be showing.
 *
 * Anything already in his hand wins outright - he cannot be carrying a sample and doing a
 * different job at the same time, so that one stays on screen until he puts it down.
 *
 * Beyond that it is simply the front of the queue. The order is the runner's to change (see
 * the focus endpoint): he is the one who knows which place is on his way, and a desk that
 * insists on its own order just sends him across town twice.
 */
const IN_HAND = ['PICKED', 'EN_ROUTE_DROP', 'AT_DROP'];

// What cannot wait in a bag: samples, blood, and the "package" jobs - which at IBS are
// mostly bottles from a blood centre. Cash can wait; it does not spoil.
const PERISHABLE = ['SAMPLE_PICKUP', 'BLOOD_DELIVERY', 'COLLECTION_SAMPLE', 'PACKAGE_DELIVER'];

function currentOf(queue) {
  return queue.find(t => IN_HAND.includes(t.status) && PERISHABLE.includes(t.type)) || queue[0] || null;
}

// After a trip ends, whatever is next in the queue becomes the live one and the phone rings
// for it. Without this the runner would finish a job and sit idle with work already assigned.
async function promoteNext(runner) {
  if (!runner) return null;
  const queue = await queueFor(runner._id);
  const next = currentOf(queue);

  if (!next) {
    runner.activeTrip = null;
    runner.dutyState = runner.dutyState === 'OFF_DUTY' ? 'OFF_DUTY' : 'AVAILABLE';
    await runner.save();
    realtime.emit('runner:status', { runnerId: String(runner._id), dutyState: runner.dutyState });
    return null;
  }

  runner.activeTrip = next._id;
  runner.dutyState = runner.dutyState === 'OFF_DUTY' ? 'OFF_DUTY' : 'ON_TRIP';
  await runner.save();

  // Ring for it, but only if he has not already started it.
  if (next.status === 'ASSIGNED') {
    await Trip.updateOne({ _id: next._id }, { alertPending: true });
  }
  realtime.emit('trip:update', { tripId: String(next._id), status: next.status, runnerId: String(runner._id) });
  return next;
}

// How many jobs one runner may hold at once. A runner leaving a blood centre with a box of
// bottles for six hospitals really is holding six jobs, so this is a guard against a stuck
// screen rather than a working limit.
const MAX_QUEUE = 10;

async function assignTrip({ caseId, type, runnerId, assignedBy }) {
  const kase = await Case.findById(caseId);
  if (!kase) throw httpError(404, 'Case not found');

  const runner = await User.findById(runnerId);
  if (!runner || runner.role !== 'runner' || !runner.active) throw httpError(400, 'Pick an active runner');

  // A busy runner is no longer a refusal - the new job simply lines up behind the others.
  const queue = await queueFor(runner._id);
  if (queue.length >= MAX_QUEUE) {
    throw httpError(409, runner.name + ' already has ' + queue.length + ' jobs in hand. Finish or reassign one first.');
  }

  const blood = type === 'SAMPLE_PICKUP' || type === 'BLOOD_DELIVERY';

  if (type === 'SAMPLE_PICKUP' && kase.sampleTrip) {
    const old = await Trip.findById(kase.sampleTrip);
    if (old && ACTIVE.includes(old.status)) throw httpError(409, 'A sample pickup is already running for this case');
  }
  if (type === 'BLOOD_DELIVERY') {
    if (!kase.crossmatch || !kase.crossmatch.completedAt) throw httpError(400, 'Finish the crossmatch before sending blood out');
    const old = kase.deliveryTrip ? await Trip.findById(kase.deliveryTrip) : null;
    if (old && ACTIVE.includes(old.status)) throw httpError(409, 'A delivery is already running for this case');
  }
  if (!blood && kase.jobTrip) {
    const old = await Trip.findById(kase.jobTrip);
    if (old && ACTIVE.includes(old.status)) throw httpError(409, 'This job already has a runner on it');
  }

  // Which way round the journey runs.
  let pickup, drop;
  if (type === 'SAMPLE_PICKUP') { pickup = kase.hospital; drop = kase.bloodCenter; }
  else if (type === 'BLOOD_DELIVERY') { pickup = kase.bloodCenter; drop = kase.hospital; }
  else { pickup = kase.fromLocation; drop = kase.toLocation; }

  if (!pickup || !drop) {
    // Name the actual gap. The old wording - "this job needs both a pickup and a drop point"
    // - sent whoever read it hunting round the assign screen for a field to fill, when the
    // real fault is elsewhere: either a blood leg is being asked of a case that is not a
    // blood case (so hospital and blood centre were never set on it), or the case really was
    // saved without one of its places.
    if (blood && kase.jobType !== 'BLOOD') {
      throw httpError(400, 'Case ' + kase.caseNo + ' is a ' +
        (jobTitle(kase.jobType) || 'single errand').toLowerCase() +
        ' job, not a blood case. Send it as that job instead of a blood leg.');
    }
    const missing = blood
      ? [!pickup && type === 'SAMPLE_PICKUP' ? 'hospital' : null,
         !drop && type === 'SAMPLE_PICKUP' ? 'blood centre' : null,
         !pickup && type === 'BLOOD_DELIVERY' ? 'blood centre' : null,
         !drop && type === 'BLOOD_DELIVERY' ? 'hospital' : null].filter(Boolean)
      : [!pickup ? 'pickup place' : null, !drop ? 'drop place' : null].filter(Boolean);

    throw httpError(400, 'Case ' + kase.caseNo + ' has no ' + missing.join(' and ') +
      ' saved on it. Open the case, set it, then send the runner.');
  }

  const now = new Date();
  const trip = await Trip.create({
    tripNo: await nextNumber((JOB[type] || {}).counter || 'JOB'),
    case: kase._id,
    type,
    runner: runner._id,
    pickupLocation: pickup,
    dropLocation: drop,
    status: 'ASSIGNED',
    // Behind everything he already holds. Using the queue LENGTH here gave two jobs the same
    // number as soon as one in the middle had finished, and the tie was then broken by
    // whatever order the database felt like - which is how a newer job could jump an older one.
    queueOrder: queue.reduce((m, t) => Math.max(m, Number(t.queueOrder) || 0), -1) + 1,
    assignedAt: now,
    assignedBy,
    // Every new job rings, even one that lines up behind a job already in hand. The runner
    // needs to know the work exists while he can still plan his route round it - telling him
    // only after he finishes the current one is the same as not telling him.
    alertPending: true,
    events: [{ status: 'ASSIGNED', at: now, note: labelFor(type, 'ASSIGNED'), by: 'desk' }]
  });

  if (!runner.activeTrip || queue.length === 0) {
    runner.activeTrip = trip._id;
    runner.dutyState = runner.dutyState === 'OFF_DUTY' ? 'OFF_DUTY' : 'ON_TRIP';
    await runner.save();
  }

  if (type === 'SAMPLE_PICKUP') { kase.sampleTrip = trip._id; kase.status = 'SAMPLE_TRIP'; }
  else if (type === 'BLOOD_DELIVERY') { kase.deliveryTrip = trip._id; kase.status = 'DELIVERY_TRIP'; }
  else { kase.jobTrip = trip._id; kase.status = 'JOB_TRIP'; }
  await kase.save();

  realtime.emit('trip:update', { tripId: String(trip._id), status: 'ASSIGNED', runnerId: String(runner._id) });
  realtime.emit('case:update', { caseId: String(kase._id), status: kase.status });
  return trip;
}

async function applyStage(trip, stage, opts = {}) {
  const allowed = NEXT[trip.status] || [];
  if (!allowed.includes(stage) && !isForward(trip.status, stage)) {
    throw httpError(400, 'Cannot move from ' + labelFor(trip.type, trip.status) + ' to ' + labelFor(trip.type, stage));
  }

  const now = opts.at ? new Date(opts.at) : new Date();
  const fromStatus = trip.status;

  // Every stage he skipped gets a time, so the TAT spans stay complete (see fillTimes).
  if (RANK[stage] !== undefined) fillTimes(trip, fromStatus, stage, now, opts.times);

  trip.status = stage;
  if (stage === 'REJECTED') { trip.rejectedAt = now; trip.rejectReason = opts.note || ''; }
  if (stage === 'CANCELLED') { trip.cancelledAt = now; trip.rejectReason = opts.note || ''; }
  if (opts.barcode) trip.sampleBarcode = opts.barcode;
  if (opts.units !== undefined && opts.units !== null && opts.units !== '') trip.unitsCarried = Number(opts.units);
  // Arriving and handing over are two different moments and two different pictures.
  if (opts.proofPhoto) {
    if (stage === 'AT_PICKUP') trip.arrivalPhoto = opts.proofPhoto;
    else trip.proofPhoto = opts.proofPhoto;
  }
  if (opts.amount !== undefined && opts.amount !== null && opts.amount !== '') trip.amountCollected = Number(opts.amount);
  if (opts.paymentMode) trip.paymentMode = opts.paymentMode;
  if (opts.paymentRef) trip.paymentRef = opts.paymentRef;
  const portal = opts.via === 'PORTAL';
  if (opts.note && !['REJECTED', 'CANCELLED'].includes(stage)) {
    if (portal) trip.deskNote = opts.note; else trip.runnerNote = opts.note;
  }
  // Who closed it, and from where. A job finished from the portal is a different kind of
  // record from one the runner finished on his phone - the office has to be able to tell.
  if (stage === 'COMPLETED') {
    trip.closedVia = portal ? 'PORTAL' : 'APP';
    trip.closedByName = opts.byName || (portal ? 'Desk' : '');
  }

  let distanceToTarget = null;
  if (opts.lat && opts.lng) {
    const targetId = ['ACCEPTED', 'EN_ROUTE_PICKUP', 'AT_PICKUP', 'PICKED'].includes(stage) ? trip.pickupLocation : trip.dropLocation;
    const target = await Location.findById(targetId).lean();
    if (target) distanceToTarget = Math.round(distanceM(Number(opts.lat), Number(opts.lng), target.lat, target.lng) || 0);
  }

  trip.events.push({
    status: stage,
    at: now,
    lat: opts.lat ? Number(opts.lat) : undefined,
    lng: opts.lng ? Number(opts.lng) : undefined,
    distanceToTargetM: distanceToTarget,
    note: opts.note || labelFor(trip.type, stage),
    by: opts.by || 'runner'
  });
  await trip.save();

  const kase = await Case.findById(trip.case);
  const runner = await User.findById(trip.runner);

  if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(stage)) {
    // Whatever is waiting behind this one becomes live and rings. If nothing is waiting the
    // runner goes back to AVAILABLE, which is what promoteNext does when the queue is empty.
    await promoteNext(runner);

    if (stage === 'COMPLETED' && runner) {
      const date = ISTDate(now);
      await Attendance.updateOne({ runner: runner._id, date }, { $inc: { tripsDone: 1 } }, { upsert: true });
    }
  }

  if (kase) {
    const blood = trip.type === 'SAMPLE_PICKUP' || trip.type === 'BLOOD_DELIVERY';
    if (stage === 'COMPLETED') {
      if (trip.type === 'SAMPLE_PICKUP') kase.status = 'SAMPLE_AT_CENTER';
      else if (trip.type === 'BLOOD_DELIVERY') { kase.status = 'DELIVERED'; kase.closedAt = kase.closedAt || now; }
      else {
        kase.status = 'JOB_DONE';
        kase.closedAt = kase.closedAt || now;
        if (trip.type === 'PAYMENT_COLLECT' && trip.amountCollected) {
          kase.collectedAmount = trip.amountCollected;
          kase.paymentMode = trip.paymentMode || kase.paymentMode;
          kase.paymentRef = trip.paymentRef || kase.paymentRef;
        }
      }
    } else if (['REJECTED', 'CANCELLED'].includes(stage)) {
      kase.status = blood ? (trip.type === 'SAMPLE_PICKUP' ? 'NEW' : 'READY') : 'NEW';
    }
    await kase.save();
    realtime.emit('case:update', { caseId: String(kase._id), status: kase.status });
  }

  realtime.emit('trip:update', {
    tripId: String(trip._id), status: trip.status,
    runnerId: trip.runner ? String(trip.runner) : null,
    caseId: String(trip.case)
  });

  return trip;
}

/**
 * Finishing a job from the portal.
 *
 * Used when the runner did the work but the phone did not say so - a dead battery, a
 * basement with no signal, an old build, or he simply forgot to press. The desk types in when
 * it really happened, can attach the handover photo the runner sent on WhatsApp, and the job
 * is closed with closedVia = 'PORTAL' so nobody later mistakes it for a phone record.
 *
 * On a job that is already finished this corrects it instead: a wrong delivery time or a
 * missing photo can be fixed without inventing a second completion. The correction is stamped
 * (amendedAt / amendedByName) and written into the job's own history.
 */
async function deskComplete(trip, input) {
  const { user } = input;
  const name = (user && user.name) || 'Desk';
  const now = new Date();

  const when = parseWhen(input.at, 'Delivered at') || now;
  let picked = parseWhen(input.pickedAt, 'Picked up at');

  // A job closed from the portal with no pickup time has its pickup stamped at the same
  // moment as the delivery. When that delivery time is corrected, the pickup was never a
  // separate fact - it moves with it, instead of blocking the correction.
  if (!picked && trip.status === 'COMPLETED' && trip.pickedAt && trip.completedAt &&
      new Date(trip.pickedAt).getTime() === new Date(trip.completedAt).getTime()) {
    picked = when;
  }

  if (when.getTime() > now.getTime() + 2 * 60000) throw httpError(400, 'Delivered at cannot be in the future');
  if (trip.assignedAt && when < new Date(trip.assignedAt)) {
    throw httpError(400, 'Delivered at cannot be before the job was assigned (' +
      new Date(trip.assignedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ')');
  }
  if (picked && picked > when) throw httpError(400, 'Picked up at must be before Delivered at');
  if (picked && trip.assignedAt && picked < new Date(trip.assignedAt)) {
    throw httpError(400, 'Picked up at cannot be before the job was assigned');
  }

  if (['REJECTED', 'CANCELLED'].includes(trip.status)) {
    throw httpError(400, 'This job was ' + trip.status.toLowerCase() + '. Send a runner again instead of completing it.');
  }
  // Delivered before it was picked up cannot be right. Say so, rather than quietly moving
  // one of the two times to make them fit.
  // (An accept stamped at the very moment of an earlier portal close was inferred, not
  // measured, so it does not count here - it moves with the correction below.)
  const acceptInferred = trip.acceptedAt && trip.completedAt &&
    new Date(trip.acceptedAt).getTime() === new Date(trip.completedAt).getTime();
  if (picked && trip.acceptedAt && !acceptInferred && picked < new Date(trip.acceptedAt) && trip.status !== 'ASSIGNED') {
    throw httpError(400, 'Picked up at cannot be before the runner accepted (' +
      new Date(trip.acceptedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ')');
  }
  const pickedEff = picked || (trip.pickedAt ? new Date(trip.pickedAt) : null);
  if (pickedEff && when < pickedEff) {
    throw httpError(400, 'Delivered at cannot be before it was picked up (' +
      pickedEff.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + '). Change "Picked up at" too.');
  }

  const note = String(input.note || '').trim();

  if (trip.status === 'COMPLETED') {
    // A correction, not a second completion. Only what the desk actually changed moves, and
    // the times that were measured separately (arrival at the drop, leaving the pickup) are
    // kept unless the new times would put them out of order.
    const t0 = ms => (ms ? new Date(ms).getTime() : null);
    // Stages that were stamped at the same instant as the old completion were inferred from
    // it (a portal close fills them that way), so they move with the new time.
    if (input.at) {
      const was = t0(trip.completedAt);
      FLOW.slice(1, RANK.COMPLETED).forEach(st => {
        const f = STAGE_FIELD[st];
        if (trip[f] && t0(trip[f]) === was) trip[f] = (picked && RANK[st] <= RANK.PICKED) ? picked : when;
      });
    }
    if (input.at) {
      const oldDone = t0(trip.completedAt);
      trip.completedAt = when;
      if (!trip.atDropAt || t0(trip.atDropAt) === oldDone || t0(trip.atDropAt) > when.getTime()) trip.atDropAt = when;
    }
    if (picked) {
      const oldPicked = t0(trip.pickedAt);
      trip.pickedAt = picked;
      if (!trip.atPickupAt || t0(trip.atPickupAt) === oldPicked || t0(trip.atPickupAt) > picked.getTime()) trip.atPickupAt = picked;
      if (!trip.dropStartedAt || t0(trip.dropStartedAt) === oldPicked || t0(trip.dropStartedAt) < picked.getTime()) trip.dropStartedAt = picked;
    }
    if (trip.dropStartedAt && trip.atDropAt && t0(trip.dropStartedAt) > t0(trip.atDropAt)) trip.dropStartedAt = trip.atDropAt;
    if (input.photo) trip.proofPhoto = input.photo;
    if (input.units !== undefined && input.units !== '' && input.units !== null) trip.unitsCarried = Number(input.units);
    if (note) trip.deskNote = note;
    trip.amendedAt = now;
    trip.amendedByName = name;
    trip.events.push({ status: 'COMPLETED', at: now, note: 'Corrected from the portal' + (note ? ': ' + note : ''), by: name + ' (portal)' });
    await trip.save();
    realtime.emit('trip:update', { tripId: String(trip._id), status: trip.status, caseId: String(trip.case) });
    return trip;
  }

  return applyStage(trip, 'COMPLETED', {
    at: when,
    times: picked ? { AT_PICKUP: picked, PICKED: picked } : undefined,
    proofPhoto: input.photo,
    units: input.units,
    amount: input.amount,
    paymentMode: input.paymentMode,
    note: note || 'Completed from the portal',
    by: name + ' (portal)',
    via: 'PORTAL',
    byName: name
  });
}

// datetime-local from the browser arrives as "2026-10-03T16:40" with no zone; the desk is in
// India, so that is read as IST rather than as the server's UTC.
function parseWhen(raw, label) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) s += '+05:30';
  const d = new Date(s);
  if (isNaN(d.getTime())) throw httpError(400, label + ' is not a valid date and time');
  return d;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { assignTrip, applyStage, labelFor, jobTitle, JOB, queueFor, currentOf, IN_HAND,
                   promoteNext, ACTIVE, MAX_QUEUE, ISTDate, httpError, RANK, FLOW, isForward,
                   STAGE_FIELD, fillTimes, deskComplete, parseWhen, PERISHABLE };
