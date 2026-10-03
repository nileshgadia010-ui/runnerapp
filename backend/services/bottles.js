/*
 * Bottles delivered.
 *
 * IBS sends blood out two ways: as the delivery leg of a blood case, and - from a blood
 * centre straight to a hospital - as a "Deliver package" job. Both are bottles in a box, and
 * the office counts them the same way, so the figure adds both.
 *
 * The count for one job is, in order of trust:
 *   1. what the runner confirmed on his phone when he picked up (unitsCarried),
 *   2. what the desk typed on the case (unitsRequested),
 *   3. one - a delivery happened, so at least one bottle moved.
 */
const BOTTLE_JOBS = ['BLOOD_DELIVERY', 'PACKAGE_DELIVER'];

function bottlesOf(trip) {
  if (!trip || trip.status !== 'COMPLETED' || !BOTTLE_JOBS.includes(trip.type)) return 0;
  const carried = Number(trip.unitsCarried);
  if (carried > 0) return carried;
  const asked = trip.case && typeof trip.case === 'object' ? Number(trip.case.unitsRequested) : 0;
  if (asked > 0) return asked;
  return 1;
}

function bottleTotals(trips) {
  const done = (trips || []).filter(t => t.status === 'COMPLETED' && BOTTLE_JOBS.includes(t.type));
  return {
    bottles: done.reduce((n, t) => n + bottlesOf(t), 0),
    bottleJobs: done.length
  };
}

module.exports = { bottlesOf, bottleTotals, BOTTLE_JOBS };
