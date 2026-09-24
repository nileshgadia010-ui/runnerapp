/**
 * Factory reset.
 *
 * Wipes the working data so the system can be handed over clean after a testing round. It
 * exists because there is no other way to do it: Render's free plan gives no shell, and the
 * alternative is the office asking someone to open the Atlas console, which is worse.
 *
 * Everything here is written on the assumption that one day somebody will press this by
 * mistake, or that the code will leak. So the code is never the only thing standing between
 * a click and an empty database:
 *
 *   - the caller must already be signed in AS AN ADMIN with the delete right
 *   - the code lives on the server, never in the page, and can be changed with an env var
 *   - a phrase has to be typed out in full, which a stray click cannot produce
 *   - the account doing the wipe is always kept, so nobody can lock themselves out of a
 *     deployment they have no shell access to
 *
 * A wipe cannot be undone and there is no backup in the application. That is stated on the
 * screen, and it is why the confirm phrase is a sentence rather than a checkbox.
 */
const router = require('express').Router();
const mongoose = require('mongoose');
const Trip = require('../models/Trip');
const Case = require('../models/Case');
const User = require('../models/User');
const Location = require('../models/Location');
const Attendance = require('../models/Attendance');
const LocationPing = require('../models/LocationPing');
const Photo = require('../models/Photo');
const { auth, allow, can } = require('../middleware/auth');

const CODE = String(process.env.RESET_CODE || '2627');
const PHRASE = 'DELETE EVERYTHING';

// Wrong codes are counted per signed-in account and the door shuts for a while. Four digits
// is a short code; without this, guessing every one of them takes a script a few seconds.
const MAX_TRIES = 5;
const LOCK_MINUTES = 15;
const tries = new Map();

function gate(userId) {
  const rec = tries.get(String(userId));
  if (!rec) return null;
  if (rec.until && rec.until > Date.now()) {
    return Math.ceil((rec.until - Date.now()) / 60000);
  }
  if (rec.until && rec.until <= Date.now()) tries.delete(String(userId));
  return null;
}

function wrong(userId) {
  const key = String(userId);
  const rec = tries.get(key) || { n: 0, until: 0 };
  rec.n += 1;
  if (rec.n >= MAX_TRIES) { rec.until = Date.now() + LOCK_MINUTES * 60000; rec.n = 0; }
  tries.set(key, rec);
  return rec;
}

router.use(auth, allow('admin'), can('deleteRecords'));

/** What a reset would remove right now, so the screen can say it before anything happens. */
router.get('/preview', async (req, res, next) => {
  try {
    const [cases, trips, pings, photos, attendance, places, staff] = await Promise.all([
      Case.countDocuments({}), Trip.countDocuments({}), LocationPing.countDocuments({}),
      Photo.countDocuments({}), Attendance.countDocuments({}), Location.countDocuments({}),
      User.countDocuments({ _id: { $ne: req.user._id } })
    ]);
    res.json({
      data: { cases, trips, pings, photos, attendance },
      everything: { cases, trips, pings, photos, attendance, places, staff },
      keeps: { account: req.user.username, name: req.user.name }
    });
  } catch (e) { next(e); }
});

/**
 * Two scopes, because "start fresh" usually means two different things.
 *
 *   data        clears the day-to-day records and leaves the hospitals and the staff in
 *               place, so the office can go live the next morning without retyping its
 *               own address book. This is the one wanted after a testing round.
 *
 *   everything  also removes the hospitals, the blood centres and every other login. A
 *               genuinely empty system, as if it had just been installed.
 */
router.post('/reset', async (req, res, next) => {
  try {
    const locked = gate(req.user._id);
    if (locked) {
      return res.status(429).json({
        error: 'Too many wrong codes. Try again in ' + locked + ' minute' + (locked === 1 ? '' : 's') + '.'
      });
    }

    const { code, confirm, scope } = req.body || {};

    if (String(code || '') !== CODE) {
      const rec = wrong(req.user._id);
      const left = rec.until ? 0 : MAX_TRIES - rec.n;
      console.warn('[reset] wrong code from ' + req.user.username + ' (' + req.ip + ')');
      return res.status(403).json({
        error: 'That code is not right.' + (left ? ' ' + left + ' tries left.' : ' Locked for ' + LOCK_MINUTES + ' minutes.')
      });
    }
    tries.delete(String(req.user._id));

    if (String(confirm || '').trim().toUpperCase() !== PHRASE) {
      return res.status(400).json({ error: 'Type ' + PHRASE + ' exactly, to confirm.' });
    }
    if (scope !== 'data' && scope !== 'everything') {
      return res.status(400).json({ error: 'Choose what to clear' });
    }

    // The day-to-day records always go.
    const removed = {};
    const wipe = async (label, model, filter) => {
      const r = await model.deleteMany(filter || {});
      removed[label] = r.deletedCount || 0;
    };

    await wipe('photos', Photo);
    await wipe('pings', LocationPing);
    await wipe('trips', Trip);
    await wipe('cases', Case);
    await wipe('attendance', Attendance);

    if (scope === 'everything') {
      await wipe('places', Location);
      // Everyone except the person doing this. Deleting your own login on a deployment with
      // no shell is unrecoverable, so it is simply not allowed to happen.
      await wipe('staff', User, { _id: { $ne: req.user._id } });
    }

    // Case and trip numbers start from one again, which is what "fresh" is taken to mean.
    // The collection is not declared as a model file, so it is cleared directly.
    try {
      await mongoose.connection.collection('counters').deleteMany({});
      removed.counters = 'reset';
    } catch (e) {
      removed.counters = 'left alone (' + e.message + ')';
    }

    // Runners carry a pointer to the job they were on; with the jobs gone it has to go too,
    // or the phone keeps asking the server about a trip that no longer exists.
    await User.updateMany({ role: 'runner' },
      { $set: { dutyState: 'OFF_DUTY', activeTrip: null } });

    // Written to the server log rather than the database, because on an `everything` reset
    // anything written to the database would be deleted by the same request.
    console.warn('[reset] ' + scope.toUpperCase() + ' by ' + req.user.username +
      ' at ' + new Date().toISOString() + ' - ' + JSON.stringify(removed));

    res.json({
      ok: true,
      scope,
      removed,
      kept: scope === 'everything'
        ? 'Only your own login (' + req.user.username + ') was kept.'
        : 'Hospitals and staff were kept.',
      message: scope === 'everything'
        ? 'The system is empty. Add your hospitals and staff again to start.'
        : 'All cases, jobs, punches and photos are gone. Hospitals and staff are still here.'
    });
  } catch (e) { next(e); }
});

module.exports = router;
