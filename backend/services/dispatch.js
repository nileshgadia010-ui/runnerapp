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

// The runner app can only move forward, one step at a time (skipping ahead is blocked).
const NEXT = {
  ASSIGNED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['EN_ROUTE_PICKUP', 'AT_PICKUP', 'CANCELLED'],
  EN_ROUTE_PICKUP: ['AT_PICKUP', 'CANCELLED'],
  AT_PICKUP: ['PICKED', 'CANCELLED'],
  PICKED: ['EN_ROUTE_DROP', 'AT_DROP', 'CANCELLED'],
  EN_ROUTE_DROP: ['AT_DROP', 'CANCELLED'],
  AT_DROP: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: []
};

const ISTDate = (d = new Date()) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);

function labelFor(type, stage) {
  const sample = type === 'SAMPLE_PICKUP';
  return ({
    ASSIGNED: 'New job assigned',
    ACCEPTED: 'Job accepted',
    EN_ROUTE_PICKUP: sample ? 'On the way to hospital' : 'On the way to blood centre',
    AT_PICKUP: sample ? 'Reached hospital' : 'Reached blood centre',
    PICKED: sample ? 'Sample collected' : 'Blood units loaded',
    EN_ROUTE_DROP: sample ? 'Returning to blood centre' : 'On the way to hospital',
    AT_DROP: sample ? 'Reached blood centre' : 'Reached hospital',
    COMPLETED: sample ? 'Sample handed over' : 'Blood delivered',
    REJECTED: 'Job declined',
    CANCELLED: 'Job cancelled'
  })[stage] || stage;
}

async function assignTrip({ caseId, type, runnerId, assignedBy }) {
  const kase = await Case.findById(caseId);
  if (!kase) throw httpError(404, 'Case not found');

  const runner = await User.findById(runnerId);
  if (!runner || runner.role !== 'runner' || !runner.active) throw httpError(400, 'Pick an active runner');

  const busy = await Trip.findOne({ runner: runner._id, status: { $in: ACTIVE } });
  if (busy) throw httpError(409, runner.name + ' is already on trip ' + busy.tripNo);

  if (type === 'SAMPLE_PICKUP' && kase.sampleTrip) {
    const old = await Trip.findById(kase.sampleTrip);
    if (old && ACTIVE.includes(old.status)) throw httpError(409, 'A sample pickup is already running for this case');
  }
  if (type === 'BLOOD_DELIVERY') {
    if (!kase.crossmatch || !kase.crossmatch.completedAt) throw httpError(400, 'Finish the crossmatch before sending blood out');
    const old = kase.deliveryTrip ? await Trip.findById(kase.deliveryTrip) : null;
    if (old && ACTIVE.includes(old.status)) throw httpError(409, 'A delivery is already running for this case');
  }

  const pickup = type === 'SAMPLE_PICKUP' ? kase.hospital : kase.bloodCenter;
  const drop = type === 'SAMPLE_PICKUP' ? kase.bloodCenter : kase.hospital;
  const now = new Date();

  const trip = await Trip.create({
    tripNo: await nextNumber(type === 'SAMPLE_PICKUP' ? 'SPK' : 'DLV'),
    case: kase._id,
    type,
    runner: runner._id,
    pickupLocation: pickup,
    dropLocation: drop,
    status: 'ASSIGNED',
    assignedAt: now,
    assignedBy,
    alertPending: true,
    events: [{ status: 'ASSIGNED', at: now, note: labelFor(type, 'ASSIGNED'), by: 'desk' }]
  });

  runner.activeTrip = trip._id;
  runner.dutyState = 'ON_TRIP';
  await runner.save();

  if (type === 'SAMPLE_PICKUP') { kase.sampleTrip = trip._id; kase.status = 'SAMPLE_TRIP'; }
  else { kase.deliveryTrip = trip._id; kase.status = 'DELIVERY_TRIP'; }
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

  // Catch up any stage the runner jumped over so the TAT maths never has a hole.
  if (stage === 'AT_PICKUP' && !trip.startedAt) trip.startedAt = trip.acceptedAt || now;
  if (stage === 'AT_DROP' && !trip.dropStartedAt) trip.dropStartedAt = trip.pickedAt || now;

  trip.status = stage;
  if (stage === 'REJECTED') { trip.rejectedAt = now; trip.rejectReason = opts.note || ''; }
  if (stage === 'CANCELLED') { trip.cancelledAt = now; trip.rejectReason = opts.note || ''; }
  if (opts.barcode) trip.sampleBarcode = opts.barcode;
  if (opts.units !== undefined && opts.units !== null && opts.units !== '') trip.unitsCarried = Number(opts.units);
  if (opts.proofPhoto) trip.proofPhoto = opts.proofPhoto;
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
    if (runner) {
      runner.activeTrip = null;
      runner.dutyState = runner.dutyState === 'OFF_DUTY' ? 'OFF_DUTY' : 'AVAILABLE';
      await runner.save();
    }
    if (stage === 'COMPLETED' && runner) {
      const date = ISTDate(now);
      await Attendance.updateOne({ runner: runner._id, date }, { $inc: { tripsDone: 1 } }, { upsert: true });
    }
  }

  if (kase) {
    if (stage === 'COMPLETED') {
      if (trip.type === 'SAMPLE_PICKUP') kase.status = 'SAMPLE_AT_CENTER';
      else { kase.status = 'DELIVERED'; kase.closedAt = kase.closedAt || now; }
    } else if (['REJECTED', 'CANCELLED'].includes(stage)) {
      kase.status = trip.type === 'SAMPLE_PICKUP' ? 'NEW' : 'READY';
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

module.exports = { assignTrip, applyStage, labelFor, ACTIVE, ISTDate, httpError };
