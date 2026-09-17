const router = require('express').Router();
const Location = require('../models/Location');
const { auth, allow } = require('../middleware/auth');

router.use(auth);

// The dropdown the coordinator picks from when creating a case.
router.get('/', async (req, res) => {
  const q = {};
  if (req.query.type) q.type = req.query.type;
  if (req.query.all !== '1') q.active = true;
  if (req.query.search) q.name = new RegExp(String(req.query.search).trim(), 'i');
  const rows = await Location.find(q).sort({ type: 1, name: 1 });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await Location.findById(req.params.id);
  if (!row) return res.status(404).json({ error: 'Location not found' });
  res.json(row);
});

router.post('/', allow('admin', 'coordinator'), async (req, res) => {
  const { name, lat, lng } = req.body || {};
  if (!name || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'Name and map position are required' });
  }
  const row = await Location.create({ ...req.body, lat: Number(lat), lng: Number(lng) });
  res.status(201).json(row);
});

router.put('/:id', allow('admin', 'coordinator'), async (req, res) => {
  const row = await Location.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!row) return res.status(404).json({ error: 'Location not found' });
  res.json(row);
});

router.delete('/:id', allow('admin', 'coordinator'), async (req, res) => {
  const row = await Location.findByIdAndUpdate(req.params.id, { active: false }, { new: true });
  if (!row) return res.status(404).json({ error: 'Location not found' });
  res.json({ ok: true });
});

module.exports = router;
