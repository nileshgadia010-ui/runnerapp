const router = require('express').Router();
const Case = require('../models/Case');
const Trip = require('../models/Trip');
const { nextNumber } = require('../models/Counter');
const { auth, allow, can } = require('../middleware/auth');
const { purgeCase, describe } = require('../services/purge');
const { caseTat } = require('../services/tat');
const realtime = require('../services/realtime');
const { deskComplete, parseWhen, httpError, ACTIVE } = require('../services/dispatch');
const { upload, storeDeskPhoto } = require('../services/deskPhoto');

router.use(auth);

const POP = [
  { path: 'hospital', select: 'name area city lat lng phone' },
  { path: 'bloodCenter', select: 'name area city lat lng phone' },
  { path: 'fromLocation', select: 'name area city lat lng phone' },
  { path: 'toLocation', select: 'name area city lat lng phone' },
  { path: 'sampleTrip', populate: { path: 'runner', select: 'name phone' } },
  { path: 'deliveryTrip', populate: { path: 'runner', select: 'name phone' } },
  { path: 'jobTrip', populate: { path: 'runner', select: 'name phone' } }
];

router.get('/', async (req, res) => {
  const q = {};
  if (req.query.status) q.status = { $in: String(req.query.status).split(',') };
  if (req.query.open === '1') q.status = { $nin: ['CLOSED', 'CANCELLED'] };
  if (req.query.hospital) q.hospital = req.query.hospital;
  if (req.query.priority) q.priority = req.query.priority;
  if (req.query.search) {
    const rx = new RegExp(String(req.query.search).trim(), 'i');
    q.$or = [{ caseNo: rx }, { patientName: rx }, { attendantPhone: rx }];
  }
  if (req.query.from || req.query.to) {
    q.createdAt = {};
    if (req.query.from) q.createdAt.$gte = new Date(req.query.from + 'T00:00:00+05:30');
    if (req.query.to) q.createdAt.$lte = new Date(req.query.to + 'T23:59:59+05:30');
  }

  const rows = await Case.find(q).populate(POP).sort({ createdAt: -1 }).limit(Number(req.query.limit) || 300).lean();
  const now = new Date();
  res.json(rows.map(c => ({ ...c, tat: caseTat(c, c.sampleTrip, c.deliveryTrip, now) })));
});

router.get('/:id', async (req, res) => {
  const c = await Case.findById(req.params.id).populate(POP).lean();
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const trips = await Trip.find({ case: c._id })
    .populate('runner', 'name phone vehicleNo')
    .populate('pickupLocation dropLocation', 'name area lat lng')
    .sort({ createdAt: 1 }).lean();
  res.json({ ...c, trips, tat: caseTat(c, c.sampleTrip, c.deliveryTrip, new Date()) });
});

// What each job type must have before it can be created. A blood case is the only one that
// needs a patient; the other three are errands, and insisting on a patient name there would
// only teach the desk to type rubbish into the box.
const REQUIRED = {
  BLOOD: b => (!b.patientName ? 'Patient name is required for a blood case'
            : !b.hospital ? 'Choose the hospital'
            : !b.bloodCenter ? 'Choose the blood centre' : null),
  COLLECTION_SAMPLE: b => (!b.fromLocation ? 'Choose where the sample is collected from'
            : !b.toLocation ? 'Choose where it has to be taken' : null),
  PAYMENT_COLLECT: b => (!b.fromLocation ? 'Choose where the payment is collected from'
            : !b.toLocation ? 'Choose where it has to be brought'
            : !Number(b.amount) ? 'Enter the amount to collect' : null),
  PACKAGE_DELIVER: b => (!b.fromLocation ? 'Choose where the package is picked up'
            : !b.toLocation ? 'Choose where it has to be delivered'
            : !b.packageDetails ? 'Write what is in the package' : null)
};

router.post('/', can('createCases'), async (req, res) => {
  const b = req.body || {};
  const jobType = REQUIRED[b.jobType] ? b.jobType : 'BLOOD';

  const problem = REQUIRED[jobType](b);
  if (problem) return res.status(400).json({ error: problem });

  const kase = await Case.create({
    ...b,
    jobType,
    caseNo: await nextNumber('IBS'),
    unitsRequested: Number(b.unitsRequested || 1),
    amount: Number(b.amount || 0),
    createdBy: req.user._id
  });
  realtime.emit('case:new', { caseId: String(kase._id) });
  res.status(201).json(await Case.findById(kase._id).populate(POP));
});

/*
 * Editing a case.
 *
 * Anything the desk typed can be corrected - names, places, counts, remarks. What it cannot
 * touch is the bookkeeping (number, status, the trips hanging off it, who closed it); those
 * change only through the actions that own them.
 *
 * If a runner has been sent but has not picked anything up yet, a changed place is passed on
 * to his job too, so his phone navigates to the corrected address rather than the old one.
 * Once he has collected, the pickup is history and stays as it was.
 */
// Only these can be edited. A list of what is ALLOWED, not of what is forbidden: a body like
// {"$set": {"status": "CLOSED"}} or {"crossmatch.completedAt": ...} must not get through.
const EDITABLE = ['jobType', 'patientName', 'patientAge', 'patientGender', 'bloodGroup', 'component',
  'unitsRequested', 'hospital', 'bloodCenter', 'wardBed', 'doctorName', 'attendantName', 'attendantPhone',
  'reference', 'fromLocation', 'toLocation', 'amount', 'amountAgainst', 'packageDetails', 'priority',
  'remarks', 'source'];

router.put('/:id', can('editRecords'), async (req, res, next) => {
  try {
    const b = {};
    EDITABLE.forEach(k => {
      const v = req.body ? req.body[k] : undefined;
      if (v === undefined) return;
      if (v !== null && typeof v === 'object') return; // no operators, no nested objects
      b[k] = v;
    });
    ['hospital', 'bloodCenter', 'fromLocation', 'toLocation'].forEach(k => { if (b[k] === '') b[k] = null; });
    if (b.unitsRequested !== undefined) b.unitsRequested = Math.max(0, Number(b.unitsRequested) || 0);
    if (b.amount !== undefined) b.amount = Number(b.amount) || 0;

    const before = await Case.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ error: 'Case not found' });
    if (b.jobType && b.jobType !== before.jobType && before.status !== 'NEW') {
      return res.status(400).json({ error: 'The job type can only be changed before a runner is sent' });
    }

    const kase = await Case.findByIdAndUpdate(req.params.id, b, { new: true, runValidators: true });

    // Before pickup both ends can move; once he is carrying it only the drop can - the place he
    // collected from is history, but where he is taking it is still ahead of him.
    const running = await Trip.find({ case: kase._id, status: { $in: ACTIVE } });
    for (const t of running) {
      let pickup, drop;
      if (t.type === 'SAMPLE_PICKUP') { pickup = kase.hospital; drop = kase.bloodCenter; }
      else if (t.type === 'BLOOD_DELIVERY') { pickup = kase.bloodCenter; drop = kase.hospital; }
      else { pickup = kase.fromLocation; drop = kase.toLocation; }
      let moved = false;
      const collected = ['PICKED', 'EN_ROUTE_DROP', 'AT_DROP'].includes(t.status);
      if (!collected && pickup && String(pickup) !== String(t.pickupLocation)) { t.pickupLocation = pickup; moved = true; }
      if (drop && String(drop) !== String(t.dropLocation)) { t.dropLocation = drop; moved = true; }
      if (moved) {
        t.events.push({ status: t.status, at: new Date(), note: 'Address changed by the desk', by: req.user.name });
        await t.save();
        realtime.emit('trip:update', { tripId: String(t._id), status: t.status, runnerId: String(t.runner) });
      }
    }

    realtime.emit('case:update', { caseId: String(kase._id), status: kase.status });
    res.json(await Case.findById(kase._id).populate(POP));
  } catch (e) { next(e); }
});

/*
 * Complete a case from the portal.
 *
 * If a runner is out on it, that job is finished (with the time and photo the desk gives) and
 * the case moves on exactly as if the phone had done it - a sample leg lands the case at the
 * blood centre, a delivery or errand closes it.
 *
 * If nobody was sent - the hospital collected it themselves, or it was handled by phone - the
 * case is closed directly and the record says so: completion.via = 'PORTAL', who, when.
 */
router.post('/:id/complete', can('overrideStages'), upload.single('photo'), async (req, res, next) => {
  try {
    const kase = await Case.findById(req.params.id);
    if (!kase) return res.status(404).json({ error: 'Case not found' });
    if (['CANCELLED'].includes(kase.status)) return res.status(400).json({ error: 'This case was cancelled' });
    const b = req.body || {};

    const running = await Trip.findOne({ case: kase._id, status: { $in: ACTIVE } });
    const photo = await storeDeskPhoto(req.file, { trip: running ? running._id : null, runner: running ? running.runner : null });

    if (running) {
      await deskComplete(running, {
        at: b.at, pickedAt: b.pickedAt, units: b.units, amount: b.amount,
        paymentMode: b.paymentMode, note: b.note, photo, user: req.user
      });
      return res.json({ ok: true, trip: String(running._id), case: await Case.findById(kase._id).populate(POP) });
    }

    const now = new Date();
    const when = parseWhen(b.at, 'Completed at') || now;
    if (when.getTime() > now.getTime() + 2 * 60000) throw httpError(400, 'Completed at cannot be in the future');
    if (kase.createdAt && when < new Date(kase.createdAt)) throw httpError(400, 'Completed at cannot be before the case was created');

    const blood = !kase.jobType || kase.jobType === 'BLOOD';
    kase.status = blood ? 'DELIVERED' : 'JOB_DONE';
    kase.closedAt = when;
    kase.completion = {
      via: 'PORTAL', at: when, byName: req.user.name, by: req.user._id,
      photo, note: String(b.note || '').trim(),
      units: b.units !== undefined && b.units !== '' ? Number(b.units) : undefined,
      recordedAt: now
    };
    if (kase.jobType === 'PAYMENT_COLLECT' && b.amount) {
      kase.collectedAmount = Number(b.amount);
      kase.paymentMode = b.paymentMode || kase.paymentMode || 'CASH';
    }
    await kase.save();
    realtime.emit('case:update', { caseId: String(kase._id), status: kase.status });
    res.json({ ok: true, case: await Case.findById(kase._id).populate(POP) });
  } catch (e) { next(e); }
});

// Crossmatch clock - this is the lab leg of the TAT, between the two runner trips.
router.post('/:id/crossmatch/start', can('editSettings'), async (req, res) => {
  const kase = await Case.findById(req.params.id);
  if (!kase) return res.status(404).json({ error: 'Case not found' });
  if (kase.status !== 'SAMPLE_AT_CENTER' && kase.status !== 'CROSSMATCH') {
    return res.status(400).json({ error: 'The sample has not reached the blood centre yet' });
  }
  kase.crossmatch.startedAt = kase.crossmatch.startedAt || new Date();
  kase.crossmatch.by = req.user._id;
  kase.status = 'CROSSMATCH';
  await kase.save();
  realtime.emit('case:update', { caseId: String(kase._id), status: kase.status });
  res.json(kase);
});

router.post('/:id/crossmatch/done', can('editSettings'), async (req, res) => {
  const kase = await Case.findById(req.params.id);
  if (!kase) return res.status(404).json({ error: 'Case not found' });
  const { result, unitsReady, bagNumbers, remarks } = req.body || {};
  if (!result) return res.status(400).json({ error: 'Select the crossmatch result' });

  kase.crossmatch.startedAt = kase.crossmatch.startedAt || new Date();
  kase.crossmatch.completedAt = new Date();
  kase.crossmatch.result = result;
  kase.crossmatch.unitsReady = Number(unitsReady || 0);
  kase.crossmatch.bagNumbers = bagNumbers || '';
  kase.crossmatch.remarks = remarks || '';
  kase.crossmatch.by = req.user._id;
  kase.status = result === 'INCOMPATIBLE' ? 'SAMPLE_AT_CENTER' : 'READY';
  await kase.save();
  realtime.emit('case:update', { caseId: String(kase._id), status: kase.status });
  res.json(kase);
});

router.post('/:id/close', can('editSettings'), async (req, res) => {
  const kase = await Case.findById(req.params.id);
  if (!kase) return res.status(404).json({ error: 'Case not found' });
  kase.status = 'CLOSED';
  kase.closedAt = kase.closedAt || new Date();
  await kase.save();
  realtime.emit('case:update', { caseId: String(kase._id), status: kase.status });
  res.json(kase);
});

router.post('/:id/cancel', can('editSettings'), async (req, res) => {
  const kase = await Case.findById(req.params.id);
  if (!kase) return res.status(404).json({ error: 'Case not found' });
  const running = await Trip.findOne({ case: kase._id, status: { $nin: ['COMPLETED', 'REJECTED', 'CANCELLED'] } });
  if (running) return res.status(409).json({ error: 'Cancel the running trip first' });
  kase.status = 'CANCELLED';
  kase.cancelReason = (req.body && req.body.reason) || '';
  kase.closedAt = new Date();
  await kase.save();
  realtime.emit('case:update', { caseId: String(kase._id), status: kase.status });
  res.json(kase);
});

/*
 * Permanently removes a case and everything that hangs off it - its jobs, their location
 * trails and their photos. Refused while a runner is still out on it, because a job that
 * disappears from under someone is worse than one that stays.
 */
router.delete('/:id', can('deleteRecords'), async (req, res, next) => {
  try {
    const kase = await Case.findById(req.params.id).lean();
    if (!kase) return res.status(404).json({ error: 'Case not found' });

    const removed = await purgeCase(req.params.id);
    console.warn('[delete] case ' + kase.caseNo + ' removed by ' + req.user.username + ' - ' + describe(removed));
    realtime.emit('case:update', { caseId: String(req.params.id), status: 'DELETED' });
    res.json({ ok: true, removed, message: describe(removed) });
  } catch (e) { next(e); }
});

module.exports = router;
