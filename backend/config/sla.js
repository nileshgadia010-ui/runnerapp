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
  // Seconds between location uploads. 20 was too slow to watch someone ride across town -
  // a pin only moved three times a minute, which reads as standing still. 8 while carrying a
  // job is what makes the board look live; the app falls back to a slower rate when the
  // runner is idle so an empty shift does not drain his battery.
  pingInterval: n(process.env.PING_INTERVAL, 8),
  idlePingInterval: n(process.env.IDLE_PING_INTERVAL, 30),
  pollInterval: n(process.env.POLL_INTERVAL, 5)
};
