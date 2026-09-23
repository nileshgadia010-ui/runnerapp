const router = require('express').Router();
const Location = require('../models/Location');
const Case = require('../models/Case');
const { auth, allow, can } = require('../middleware/auth');

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

router.post('/', can('managePlaces'), async (req, res) => {
  const { name, lat, lng } = req.body || {};
  if (!name || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'Name and map position are required' });
  }
  const row = await Location.create({ ...req.body, lat: Number(lat), lng: Number(lng) });
  res.status(201).json(row);
});

router.put('/:id', can('managePlaces'), async (req, res) => {
  const row = await Location.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!row) return res.status(404).json({ error: 'Location not found' });
  res.json(row);
});

/*
 * Switching a place off hides it from the dropdowns while every case that ever used it keeps
 * reading correctly. That is the right default, and it stays the default.
 *
 * ?hard=1 removes the record outright, and is refused while any case still points at it -
 * otherwise old cases would render with a blank hospital and nobody could tell why.
 */
router.delete('/:id', can('managePlaces'), async (req, res) => {
  const row = await Location.findById(req.params.id);
  if (!row) return res.status(404).json({ error: 'Location not found' });

  if (req.query.hard === '1') {
    if (!req.user.can('deleteRecords')) {
      return res.status(403).json({ error: 'You do not have rights to delete permanently. Ask an admin.' });
    }
    const used = await Case.countDocuments({
      $or: [{ hospital: row._id }, { bloodCenter: row._id }, { fromLocation: row._id }, { toLocation: row._id }]
    });
    if (used) {
      return res.status(409).json({
        error: used + ' case' + (used > 1 ? 's use' : ' uses') + ' this place. Switch it off instead of deleting.'
      });
    }
    await Location.deleteOne({ _id: row._id });
    console.warn('[delete] place ' + row.name + ' removed by ' + req.user.username);
    return res.json({ ok: true, message: F(row.name) + ' deleted' });
  }

  row.active = false;
  await row.save();
  res.json({ ok: true, message: F(row.name) + ' switched off' });
});

const F = n => '"' + n + '"';

module.exports = router;
