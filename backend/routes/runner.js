const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const Trip = require('../models/Trip');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const LocationPing = require('../models/LocationPing');
const SLA = require('../config/sla');
const { auth, allow } = require('../middleware/auth');
const { tripTat } = require('../services/tat');
const { applyStage, labelFor, ISTDate } = require('../services/dispatch');
const realtime = require('../services/realtime');

// UPLOAD_DIR lets a host mount a persistent disk (e.g. Render disk at /var/data/uploads).
// Without it, photos go to backend/uploads which is fine on a VPS but wiped on every
// redeploy on ephemeral hosts like Render's default filesystem.
// UPLOAD_DIR lets a host mount a persistent disk (e.g. Render disk at /var/data/uploads).
// If that path is not writable - disk not mounted yet, wrong permissions - fall back to the
// local folder instead of crashing the whole server over a photo directory.
const localUploads = path.join(__dirname, '..', 'uploads');
function resolveUploadDir() {
  const wanted = process.env.UPLOAD_DIR || localUploads;
  try {
    if (!fs.existsSync(wanted)) fs.mkdirSync(wanted, { recursive: true });
    fs.accessSync(wanted, fs.constants.W_OK);
    return wanted;
  } catch (e) {
    console.warn('[uploads] cannot use ' + wanted + ' (' + e.code + '), falling back to ' + localUploads);
    if (!fs.existsSync(localUploads)) fs.mkdirSync(localUploads, { recursive: true });
    return localUploads;
  }
}
const uploadDir = resolveUploadDir();
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e5) + path.extname(file.originalname || '.jpg'))
  }),
  limits: { fileSize: 8 * 1024 * 1024 }
});

router.use(auth, allow('runner', 'admin'));

function tripCard(t) {
  const sample = t.type === 'SAMPLE_PICKUP';
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
    pickup: t.pickupLocation && {
      name: t.pickupLocation.name, address: t.pickupLocation.address, area: t.pickupLocation.area,
      phone: t.pickupLocation.phone, lat: t.pickupLocation.lat, lng: t.pickupLocation.lng,
      contactPerson: t.pickupLocation.contactPerson
    },
    drop: t.dropLocation && {
      name: t.dropLocation.name, address: t.dropLocation.address, area: t.dropLocation.area,
      phone: t.dropLocation.phone, lat: t.dropLocation.lat, lng: t.dropLocation.lng,
      contactPerson: t.dropLocation.contactPerson
    },
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

const POP = [
  { path: 'case', select: 'caseNo patientName patientAge patientGender bloodGroup component unitsRequested priority wardBed attendantName attendantPhone remarks' },
  { path: 'pickupLocation', select: 'name address area phone lat lng contactPerson geofence' },
  { path: 'dropLocation', select: 'name address area phone lat lng contactPerson geofence' }
];

// The app hits this every few seconds. It is the only endpoint that matters when the
// phone is idle: it answers "is there a new job, and is my shift still open".
router.get('/poll', async (req, res) => {
  const runner = req.user;
  runner.lastSeenAt = new Date();
  await runner.save();

  const trip = await Trip.findOne({ runner: runner._id, status: { $nin: ['COMPLETED', 'REJECTED', 'CANCELLED'] } })
    .populate(POP).lean();

  const date = ISTDate();
  const att = await Attendance.findOne({ runner: runner._id, date }).lean();

  res.json({
    serverTime: new Date(),
    dutyState: runner.dutyState,
    onDuty: !!(att && att.open),
    dutyMinutesToday: att ? att.totalMinutes + openMinutes(att) : 0,
    tripsToday: att ? att.tripsDone : 0,
    ring: !!(trip && trip.status === 'ASSIGNED' && trip.alertPending),
    trip: trip ? tripCard(trip) : null,
    config: { pingInterval: SLA.pingInterval, pollInterval: SLA.pollInterval }
  });
});

function openMinutes(att) {
  const s = (att.sessions || []).find(x => x.inAt && !x.outAt);
  return s ? Math.round((Date.now() - new Date(s.inAt).getTime()) / 60000) : 0;
}

// The app calls this once the alarm screen has actually opened, so it does not ring twice.
router.post('/alert-seen', async (req, res) => {
  await Trip.updateOne({ _id: req.body.tripId, runner: req.user._id }, { alertPending: false, alertShownAt: new Date() });
  res.json({ ok: true });
});

router.get('/trip/active', async (req, res) => {
  const trip = await Trip.findOne({ runner: req.user._id, status: { $nin: ['COMPLETED', 'REJECTED', 'CANCELLED'] } }).populate(POP).lean();
  res.json(trip ? tripCard(trip) : null);
});

router.get('/trips/today', async (req, res) => {
  const from = new Date(ISTDate() + 'T00:00:00+05:30');
  const trips = await Trip.find({ runner: req.user._id, assignedAt: { $gte: from } }).populate(POP).sort({ assignedAt: -1 }).lean();
  res.json(trips.map(tripCard));
});

// Every stage button in the app lands here: accept, reject, reached, collected, delivered.
router.post('/trip/:id/stage', upload.single('photo'), async (req, res, next) => {
  try {
    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ error: 'Job not found' });
    if (String(trip.runner) !== String(req.user._id)) return res.status(403).json({ error: 'This job is not assigned to you' });

    const stage = req.body.stage;
    if (stage === 'COMPLETED' && trip.type === 'BLOOD_DELIVERY' && !req.file && !trip.proofPhoto) {
      return res.status(400).json({ error: 'Take a photo of the handed-over pack to finish' });
    }

    await applyStage(trip, stage, {
      lat: req.body.lat, lng: req.body.lng, note: req.body.note,
      barcode: req.body.barcode, units: req.body.units,
      proofPhoto: req.file ? '/uploads/' + req.file.filename : undefined,
      at: req.body.at, by: 'runner'
    });

    const fresh = await Trip.findById(trip._id).populate(POP).lean();
    res.json(tripCard(fresh));
  } catch (e) { next(e); }
});

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
      at: p.at ? new Date(p.at) : new Date()
    }));

  if (clean.length) {
    await LocationPing.insertMany(clean, { ordered: false }).catch(() => {});
    const last = clean.sort((a, b) => a.at - b.at)[clean.length - 1];
    req.user.lastLocation = { lat: last.lat, lng: last.lng, accuracy: last.accuracy, speed: last.speed, battery: last.battery, at: last.at };
    req.user.lastSeenAt = new Date();
    await req.user.save();
    realtime.emit('runner:location', {
      runnerId: String(req.user._id), name: req.user.name,
      dutyState: req.user.dutyState, ...req.user.lastLocation
    });
  }
  res.json({ ok: true, saved: clean.length });
});

router.post('/punch-in', async (req, res) => {
  const date = ISTDate();
  let att = await Attendance.findOne({ runner: req.user._id, date });
  if (!att) att = new Attendance({ runner: req.user._id, date, sessions: [] });
  if (att.sessions.some(s => s.inAt && !s.outAt)) return res.status(400).json({ error: 'You are already punched in' });
  if (!req.body.lat || !req.body.lng) return res.status(400).json({ error: 'Turn on location to punch in' });

  att.sessions.push({ inAt: new Date(), inLat: Number(req.body.lat), inLng: Number(req.body.lng), inAddress: req.body.address || '' });
  att.open = true;
  await att.save();

  req.user.dutyState = req.user.activeTrip ? 'ON_TRIP' : 'AVAILABLE';
  req.user.lastLocation = { lat: Number(req.body.lat), lng: Number(req.body.lng), at: new Date() };
  req.user.lastSeenAt = new Date();
  await req.user.save();
  realtime.emit('runner:status', { runnerId: String(req.user._id), dutyState: req.user.dutyState });

  res.json({ ok: true, message: 'Punch in done', at: new Date(), dutyState: req.user.dutyState });
});

router.post('/punch-out', async (req, res) => {
  const date = ISTDate();
  const att = await Attendance.findOne({ runner: req.user._id, date });
  const open = att && att.sessions.find(s => s.inAt && !s.outAt);
  if (!open) return res.status(400).json({ error: 'You are not punched in' });
  if (req.user.activeTrip) return res.status(400).json({ error: 'Finish your running job before punching out' });

  open.outAt = new Date();
  open.outLat = Number(req.body.lat || 0);
  open.outLng = Number(req.body.lng || 0);
  open.outAddress = req.body.address || '';
  open.minutes = Math.round((open.outAt - new Date(open.inAt)) / 60000);
  att.totalMinutes = att.sessions.reduce((s, x) => s + (x.minutes || 0), 0);
  att.open = false;
  await att.save();

  req.user.dutyState = 'OFF_DUTY';
  await req.user.save();
  realtime.emit('runner:status', { runnerId: String(req.user._id), dutyState: 'OFF_DUTY' });

  res.json({ ok: true, message: 'Punch out done', minutes: open.minutes, totalMinutes: att.totalMinutes });
});

// Break lets the desk see he is off the pool without ending the shift.
router.post('/break', async (req, res) => {
  const on = !!req.body.on;
  if (on && req.user.activeTrip) return res.status(400).json({ error: 'Finish your running job before taking a break' });
  req.user.dutyState = on ? 'BREAK' : (req.user.activeTrip ? 'ON_TRIP' : 'AVAILABLE');
  await req.user.save();
  realtime.emit('runner:status', { runnerId: String(req.user._id), dutyState: req.user.dutyState });
  res.json({ ok: true, dutyState: req.user.dutyState });
});

router.get('/attendance', async (req, res) => {
  const rows = await Attendance.find({ runner: req.user._id }).sort({ date: -1 }).limit(60).lean();
  res.json(rows.map(r => ({ ...r, liveMinutes: r.totalMinutes + openMinutes(r) })));
});

module.exports = router;
