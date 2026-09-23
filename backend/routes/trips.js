const router = require('express').Router();
const Trip = require('../models/Trip');
const User = require('../models/User');
const LocationPing = require('../models/LocationPing');
const { auth, allow, can } = require('../middleware/auth');
const { purgeTrip, describe } = require('../services/purge');
const { tripTat } = require('../services/tat');
const { assignTrip, applyStage } = require('../services/dispatch');
const realtime = require('../services/realtime');

router.use(auth);

const POP = [
  { path: 'case', populate: [{ path: 'hospital', select: 'name area lat lng phone' }] },
  { path: 'runner', select: 'name phone vehicleNo empCode lastLocation dutyState' },
  { path: 'pickupLocation', select: 'name area address lat lng phone geofence' },
  { path: 'dropLocation', select: 'name area address lat lng phone geofence' }
];

router.get('/', async (req, res) => {
  const q = {};
  if (req.query.active === '1') q.status = { $nin: ['COMPLETED', 'REJECTED', 'CANCELLED'] };
  if (req.query.status) q.status = { $in: String(req.query.status).split(',') };
  if (req.query.runner) q.runner = req.query.runner;
  if (req.query.type) q.type = req.query.type;
  if (req.query.from || req.query.to) {
    q.assignedAt = {};
    if (req.query.from) q.assignedAt.$gte = new Date(req.query.from + 'T00:00:00+05:30');
    if (req.query.to) q.assignedAt.$lte = new Date(req.query.to + 'T23:59:59+05:30');
  }
  const rows = await Trip.find(q).populate(POP).sort({ assignedAt: -1 }).limit(Number(req.query.limit) || 300).lean();
  const now = new Date();
  res.json(rows.map(t => ({ ...t, tat: tripTat(t, now) })));
});

router.get('/:id', async (req, res) => {
  const t = await Trip.findById(req.params.id).populate(POP).lean();
  if (!t) return res.status(404).json({ error: 'Trip not found' });
  res.json({ ...t, tat: tripTat(t, new Date()) });
});

// Breadcrumb trail for the map - live trips replay the whole route.
router.get('/:id/route', async (req, res) => {
  const pings = await LocationPing.find({ trip: req.params.id }).sort({ at: 1 }).select('lat lng at speed').lean();
  res.json(pings);
});

router.post('/assign', can('assignTrips'), async (req, res, next) => {
  try {
    const { caseId, type, runnerId } = req.body || {};
    const trip = await assignTrip({ caseId, type, runnerId, assignedBy: req.user._id });
    res.status(201).json(await Trip.findById(trip._id).populate(POP));
  } catch (e) { next(e); }
});

// Take the job off one runner and hand it to another - the new runner's phone rings.
router.post('/:id/reassign', can('assignTrips'), async (req, res, next) => {
  try {
    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(trip.status)) {
      return res.status(400).json({ error: 'This trip is already finished' });
    }
    await applyStage(trip, 'CANCELLED', { note: 'Reassigned by the desk', by: req.user.name });
    const fresh = await assignTrip({ caseId: trip.case, type: trip.type, runnerId: req.body.runnerId, assignedBy: req.user._id });
    res.json(await Trip.findById(fresh._id).populate(POP));
  } catch (e) { next(e); }
});

router.post('/:id/cancel', can('assignTrips'), async (req, res, next) => {
  try {
    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    await applyStage(trip, 'CANCELLED', { note: (req.body && req.body.reason) || 'Cancelled by the desk', by: req.user.name });
    res.json(await Trip.findById(trip._id).populate(POP));
  } catch (e) { next(e); }
});

// Desk override - used when a runner's phone is dead and he reports by call.
router.post('/:id/stage', can('overrideStages'), async (req, res, next) => {
  try {
    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    await applyStage(trip, req.body.stage, { note: req.body.note, by: req.user.name + ' (desk)' });
    res.json(await Trip.findById(trip._id).populate(POP));
  } catch (e) { next(e); }
});

// Make the phone ring again if the runner missed the first alarm.
router.post('/:id/reping', can('assignTrips'), async (req, res) => {
  const trip = await Trip.findById(req.params.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (trip.status !== 'ASSIGNED') return res.status(400).json({ error: 'The runner has already accepted this job' });
  trip.alertPending = true;
  trip.alertShownAt = null;
  await trip.save();
  res.json({ ok: true });
});

/*
 * Removes one job and its trail. A running job has to be cancelled first - cancelling tells
 * the runner's phone, deleting would not.
 */
router.delete('/:id', can('deleteRecords'), async (req, res, next) => {
  try {
    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ error: 'Job not found' });
    if (!['COMPLETED', 'REJECTED', 'CANCELLED'].includes(trip.status)) {
      return res.status(409).json({ error: 'This job is still running. Cancel it first, then delete.' });
    }
    const no = trip.tripNo;
    const removed = await purgeTrip(trip._id);
    console.warn('[delete] trip ' + no + ' removed by ' + req.user.username + ' - ' + describe(removed));
    realtime.emit('trip:update', { tripId: String(req.params.id), status: 'DELETED' });
    res.json({ ok: true, removed, message: describe(removed) });
  } catch (e) { next(e); }
});

module.exports = router;
