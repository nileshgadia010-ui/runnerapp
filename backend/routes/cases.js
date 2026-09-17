const router = require('express').Router();
const Case = require('../models/Case');
const Trip = require('../models/Trip');
const { nextNumber } = require('../models/Counter');
const { auth, allow } = require('../middleware/auth');
const { caseTat } = require('../services/tat');
const realtime = require('../services/realtime');

router.use(auth);

const POP = [
  { path: 'hospital', select: 'name area city lat lng phone' },
  { path: 'bloodCenter', select: 'name area city lat lng phone' },
  { path: 'sampleTrip', populate: { path: 'runner', select: 'name phone' } },
  { path: 'deliveryTrip', populate: { path: 'runner', select: 'name phone' } }
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

router.post('/', allow('admin', 'coordinator'), async (req, res) => {
  const b = req.body || {};
  if (!b.patientName || !b.hospital || !b.bloodCenter) {
    return res.status(400).json({ error: 'Patient name, hospital and blood centre are required' });
  }
  const kase = await Case.create({
    ...b,
    caseNo: await nextNumber('IBS'),
    unitsRequested: Number(b.unitsRequested || 1),
    createdBy: req.user._id
  });
  realtime.emit('case:new', { caseId: String(kase._id) });
  res.status(201).json(await Case.findById(kase._id).populate(POP));
});

router.put('/:id', allow('admin', 'coordinator'), async (req, res) => {
  const b = { ...req.body };
  delete b.caseNo; delete b.status; delete b.sampleTrip; delete b.deliveryTrip;
  const kase = await Case.findByIdAndUpdate(req.params.id, b, { new: true }).populate(POP);
  if (!kase) return res.status(404).json({ error: 'Case not found' });
  res.json(kase);
});

// Crossmatch clock - this is the lab leg of the TAT, between the two runner trips.
router.post('/:id/crossmatch/start', allow('admin', 'coordinator'), async (req, res) => {
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

router.post('/:id/crossmatch/done', allow('admin', 'coordinator'), async (req, res) => {
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

router.post('/:id/close', allow('admin', 'coordinator'), async (req, res) => {
  const kase = await Case.findById(req.params.id);
  if (!kase) return res.status(404).json({ error: 'Case not found' });
  kase.status = 'CLOSED';
  kase.closedAt = kase.closedAt || new Date();
  await kase.save();
  realtime.emit('case:update', { caseId: String(kase._id), status: kase.status });
  res.json(kase);
});

router.post('/:id/cancel', allow('admin', 'coordinator'), async (req, res) => {
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

module.exports = router;
