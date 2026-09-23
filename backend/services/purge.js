const Trip = require('../models/Trip');
const Case = require('../models/Case');
const LocationPing = require('../models/LocationPing');
const Photo = require('../models/Photo');
const { ACTIVE, httpError } = require('./dispatch');

/**
 * Permanent deletion.
 *
 * Everything else in this system is reversible - a stage can be corrected, a case reopened,
 * an account switched off. This is not, so the rules are deliberately strict:
 *
 *  - a record with a job still running is never deleted. Cancel it first; that way the
 *    runner's phone is told, instead of the job silently vanishing from under him.
 *  - deleting a case takes its trips, their breadcrumb trails and their photos with it.
 *    Leaving orphans behind would quietly corrupt every report that counts trips.
 *  - the caller always learns exactly what went, so a mistaken click can be described
 *    accurately rather than guessed at.
 */

async function purgeTrip(tripId) {
  const removed = { trips: 0, pings: 0, photos: 0 };

  const trip = await Trip.findById(tripId);
  if (!trip) return removed;

  const pings = await LocationPing.deleteMany({ trip: trip._id });
  removed.pings += pings.deletedCount || 0;

  // Proof shots live in the database, keyed by the id inside their URL.
  if (trip.proofPhoto) {
    const id = String(trip.proofPhoto).split('/').pop();
    if (/^[a-f0-9]{24}$/i.test(id)) {
      const r = await Photo.deleteOne({ _id: id });
      removed.photos += r.deletedCount || 0;
    }
  }
  const byTrip = await Photo.deleteMany({ trip: trip._id });
  removed.photos += byTrip.deletedCount || 0;

  // Unhook it from its case so no dangling reference points at nothing.
  await Case.updateOne({ _id: trip.case }, { $unset: caseRef(trip) }).catch(() => {});

  await Trip.deleteOne({ _id: trip._id });
  removed.trips = 1;
  return removed;
}

function caseRef(trip) {
  if (trip.type === 'SAMPLE_PICKUP') return { sampleTrip: 1 };
  if (trip.type === 'BLOOD_DELIVERY') return { deliveryTrip: 1 };
  return { jobTrip: 1 };
}

async function purgeCase(caseId) {
  const kase = await Case.findById(caseId);
  if (!kase) throw httpError(404, 'Case not found');

  const trips = await Trip.find({ case: kase._id }).select('_id status type').lean();
  const running = trips.find(t => ACTIVE.includes(t.status));
  if (running) {
    throw httpError(409, 'A runner is still on this case. Cancel the job first, then delete.');
  }

  const removed = { cases: 1, trips: 0, pings: 0, photos: 0 };
  for (const t of trips) {
    const r = await purgeTrip(t._id);
    removed.trips += r.trips; removed.pings += r.pings; removed.photos += r.photos;
  }
  await Case.deleteOne({ _id: kase._id });
  return removed;
}

/** A one-line description of what was destroyed, for the message the user sees. */
function describe(removed) {
  const bits = [];
  const plural = (n, word) => n + ' ' + word + (n > 1 ? 's' : '');
  if (removed.cases) bits.push(plural(removed.cases, 'case'));
  if (removed.trips) bits.push(plural(removed.trips, 'job'));
  if (removed.pings) bits.push(plural(removed.pings, 'location point'));
  if (removed.photos) bits.push(plural(removed.photos, 'photo'));
  return bits.length ? bits.join(', ') + ' deleted' : 'Nothing to delete';
}

module.exports = { purgeTrip, purgeCase, describe };
