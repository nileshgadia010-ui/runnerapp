// Central SLA table. Every value is in minutes.
// These drive the colour coding on the dashboard and the breach flags in reports.
const n = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));

module.exports = {
  accept: n(process.env.SLA_ACCEPT, 3),
  reachPickup: n(process.env.SLA_REACH_PICKUP, 45),
  pickupDwell: n(process.env.SLA_PICKUP_DWELL, 10),
  reachDrop: n(process.env.SLA_REACH_DROP, 45),
  dropDwell: n(process.env.SLA_DROP_DWELL, 10),
  tripTotal: n(process.env.SLA_TRIP_TOTAL, 110),
  crossmatch: n(process.env.SLA_CROSSMATCH, 60),
  caseTotal: n(process.env.SLA_CASE_TOTAL, 240),
  pingInterval: n(process.env.PING_INTERVAL, 20),
  pollInterval: n(process.env.POLL_INTERVAL, 5)
};
