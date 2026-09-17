const router = require('express').Router();
const User = require('../models/User');
const Trip = require('../models/Trip');
const { auth, allow } = require('../middleware/auth');

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

    trip: r.activeTrip ? byId[String(r.activeTrip)] || null : null
  })));
});

router.post('/', allow('admin', 'coordinator'), async (req, res) => {
  const { name, username, password, role, empCode, phone, vehicleNo, branch } = req.body || {};
  if (!name || !username || !password) return res.status(400).json({ error: 'Name, user ID and password are required' });
  if (await User.findOne({ username: String(username).toLowerCase().trim() })) {
    return res.status(409).json({ error: 'That user ID is already taken' });
  }
  const u = new User({ name, username: String(username).toLowerCase().trim(), role: role || 'runner', empCode, phone, vehicleNo, branch });
  u.setPassword(password);
  await u.save();
  res.status(201).json(u.publicJSON());
});

router.put('/:id', allow('admin', 'coordinator'), async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'Staff member not found' });

  ['name', 'empCode', 'phone', 'vehicleNo', 'branch', 'role'].forEach(f => {
    if (req.body[f] !== undefined) u[f] = req.body[f];
  });
  if (req.body.active !== undefined) u.active = !!req.body.active;
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
