const SLA = require('../config/sla');

const MIN = 60000;
const mins = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / MIN * 10) / 10) : null);

// Grade a duration against its SLA target: ok / warn (>80%) / breach (>100%)
function grade(value, target) {
  if (value === null || value === undefined || !target) return 'na';
  if (value > target) return 'breach';
  if (value > target * 0.8) return 'warn';
  return 'ok';
}

// Full TAT breakdown of one trip. `liveNow` lets the dashboard show a running clock
// on a trip that is still in progress.
function tripTat(trip, liveNow = new Date()) {
  const running = !['COMPLETED', 'REJECTED', 'CANCELLED'].includes(trip.status);
  const end = s => s || (running ? liveNow : null);

  const accept = mins(trip.assignedAt, trip.acceptedAt || (running ? liveNow : null));
  const toPickup = mins(trip.acceptedAt, trip.atPickupAt || (trip.acceptedAt && running ? liveNow : null));
  const pickupDwell = mins(trip.atPickupAt, trip.pickedAt || (trip.atPickupAt && running ? liveNow : null));
  const toDrop = mins(trip.pickedAt, trip.atDropAt || (trip.pickedAt && running ? liveNow : null));
  const dropDwell = mins(trip.atDropAt, trip.completedAt || (trip.atDropAt && running ? liveNow : null));
  const total = mins(trip.assignedAt, trip.completedAt || (running ? liveNow : null));

  const parts = {
    accept: { value: accept, target: SLA.accept, grade: grade(accept, SLA.accept) },
    toPickup: { value: toPickup, target: SLA.reachPickup, grade: grade(toPickup, SLA.reachPickup) },
    pickupDwell: { value: pickupDwell, target: SLA.pickupDwell, grade: grade(pickupDwell, SLA.pickupDwell) },
    toDrop: { value: toDrop, target: SLA.reachDrop, grade: grade(toDrop, SLA.reachDrop) },
    dropDwell: { value: dropDwell, target: SLA.dropDwell, grade: grade(dropDwell, SLA.dropDwell) },
    total: { value: total, target: SLA.tripTotal, grade: grade(total, SLA.tripTotal) }
  };

  const order = ['breach', 'warn', 'ok', 'na'];
  const worst = Object.values(parts).map(p => p.grade).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];

  return { running, parts, worst, totalMinutes: total, endRef: end(trip.completedAt) };
}

// Case level TAT: inquiry to delivery, with the lab crossmatch measured separately.
function caseTat(kase, sampleTrip, deliveryTrip, liveNow = new Date()) {
  const running = !['CLOSED', 'CANCELLED', 'DELIVERED'].includes(kase.status);
  const now = running ? liveNow : null;

  const toAssign = mins(kase.createdAt, sampleTrip && sampleTrip.assignedAt ? sampleTrip.assignedAt : now);
  const sample = sampleTrip ? tripTat(sampleTrip, liveNow).totalMinutes : null;
  const crossmatch = mins(kase.crossmatch && kase.crossmatch.startedAt, (kase.crossmatch && kase.crossmatch.completedAt) || now);
  const delivery = deliveryTrip ? tripTat(deliveryTrip, liveNow).totalMinutes : null;
  const total = mins(kase.createdAt, kase.closedAt || (deliveryTrip && deliveryTrip.completedAt) || now);

  return {
    running,
    parts: {
      toAssign: { value: toAssign, target: SLA.accept * 2, grade: grade(toAssign, SLA.accept * 2) },
      samplePickup: { value: sample, target: SLA.tripTotal, grade: grade(sample, SLA.tripTotal) },
      crossmatch: { value: crossmatch, target: SLA.crossmatch, grade: grade(crossmatch, SLA.crossmatch) },
      delivery: { value: delivery, target: SLA.tripTotal, grade: grade(delivery, SLA.tripTotal) },
      total: { value: total, target: SLA.caseTotal, grade: grade(total, SLA.caseTotal) }
    },
    totalMinutes: total
  };
}

function fmt(m) {
  if (m === null || m === undefined) return '-';
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return h ? h + 'h ' + r + 'm' : r + 'm';
}

module.exports = { tripTat, caseTat, mins, grade, fmt, SLA };
