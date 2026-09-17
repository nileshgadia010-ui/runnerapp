const router = require('express').Router();
const User = require('../models/User');
const Trip = require('../models/Trip');
const Attendance = require('../models/Attendance');
const { roadKm, etaMinutes } = require('../services/geo');
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

    // How far he still has to ride to the point he is heading for right now. The desk asks
    // this constantly ("kitna door hai?"), so the board answers it without anyone calling.
    ...toTarget(r, r.activeTrip ? byId[String(r.activeTrip)] : null),

    trip: r.activeTrip ? byId[String(r.activeTrip)] || null : null
  })));
});

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

router.delete('/:id', allow('admin'), async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'Staff member not found' });
  u.active = false;
  await u.save();
  res.json({ ok: true });
});

module.exports = router;
