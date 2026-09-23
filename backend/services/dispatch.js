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
const NEXT = {
  ASSIGNED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['EN_ROUTE_PICKUP', 'AT_PICKUP', 'CANCELLED'],
  EN_ROUTE_PICKUP: ['AT_PICKUP', 'CANCELLED'],
  AT_PICKUP: ['PICKED', 'CANCELLED'],
  PICKED: ['EN_ROUTE_DROP', 'AT_DROP', 'COMPLETED', 'CANCELLED'],
  EN_ROUTE_DROP: ['AT_DROP', 'COMPLETED', 'CANCELLED'],
  AT_DROP: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: []
};

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

// Picks the trip the app should be showing. In-progress beats waiting, and among equals the
// oldest wins - a runner should finish what he started before the next one appears.
function currentOf(queue) {
  return queue.find(t => t.status !== 'ASSIGNED') || queue[0] || null;
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

// How many jobs one runner may hold at once. The desk can line up the next errand while he
// is still out, but not bury him - past three, whoever is assigning has lost the plot.
const MAX_QUEUE = 3;

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

  if (!pickup || !drop) throw httpError(400, 'This job needs both a pickup and a drop point');

  const now = new Date();
  const trip = await Trip.create({
    tripNo: await nextNumber((JOB[type] || {}).counter || 'JOB'),
    case: kase._id,
    type,
    runner: runner._id,
    pickupLocation: pickup,
    dropLocation: drop,
    status: 'ASSIGNED',
    queueOrder: queue.length,
    assignedAt: now,
    assignedBy,
    // Only ring straight away if this is the job he will actually be doing next. A job
    // stacked behind a running one rings when its turn comes, not while he is riding.
    alertPending: queue.length === 0,
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
  if (!allowed.includes(stage)) {
    throw httpError(400, 'Cannot move from ' + labelFor(trip.type, trip.status) + ' to ' + labelFor(trip.type, stage));
  }

  const now = opts.at ? new Date(opts.at) : new Date();
  const field = STAGE_FIELD[stage];
  if (field && !trip[field]) trip[field] = now;

  /*
   * Fill in whatever the runner skipped, so the TAT maths never has a hole.
   *
   * The report measures five spans - accept, ride to pickup, wait at pickup, ride to drop,
   * wait at drop - and each needs a timestamp at both ends. When a stage is skipped its
   * timestamp is taken from the stage it was between, which is the honest reading: if he
   * says he reached the hospital and never said when he set off, he set off when he
   * accepted. The spans stay truthful; only the button presses disappear.
   */
  if (stage === 'AT_PICKUP' && !trip.startedAt) trip.startedAt = trip.acceptedAt || now;
  if (stage === 'PICKED' && !trip.atPickupAt) trip.atPickupAt = now;
  if (stage === 'AT_DROP' && !trip.dropStartedAt) trip.dropStartedAt = trip.pickedAt || now;

  // Handing over in one tap: he was on the way from the moment he picked up, and he arrived
  // at the moment he handed over. Dwell at the drop reads as zero, which is what happened.
  if (stage === 'COMPLETED') {
    if (!trip.dropStartedAt) trip.dropStartedAt = trip.pickedAt || now;
    if (!trip.atDropAt) trip.atDropAt = now;
  }

  trip.status = stage;
  if (stage === 'REJECTED') { trip.rejectedAt = now; trip.rejectReason = opts.note || ''; }
  if (stage === 'CANCELLED') { trip.cancelledAt = now; trip.rejectReason = opts.note || ''; }
  if (opts.barcode) trip.sampleBarcode = opts.barcode;
  if (opts.units !== undefined && opts.units !== null && opts.units !== '') trip.unitsCarried = Number(opts.units);
  if (opts.proofPhoto) trip.proofPhoto = opts.proofPhoto;
  if (opts.amount !== undefined && opts.amount !== null && opts.amount !== '') trip.amountCollected = Number(opts.amount);
  if (opts.paymentMode) trip.paymentMode = opts.paymentMode;
  if (opts.paymentRef) trip.paymentRef = opts.paymentRef;
  if (opts.note && !['REJECTED', 'CANCELLED'].includes(stage)) trip.runnerNote = opts.note;

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

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { assignTrip, applyStage, labelFor, jobTitle, JOB, queueFor, currentOf,
                   promoteNext, ACTIVE, MAX_QUEUE, ISTDate, httpError };
