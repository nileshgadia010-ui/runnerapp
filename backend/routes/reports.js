const router = require('express').Router();
const Trip = require('../models/Trip');
const Case = require('../models/Case');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const LocationPing = require('../models/LocationPing');
const { auth, allow, can } = require('../middleware/auth');
const { tripTat, caseTat, fmt, SLA } = require('../services/tat');
const { ISTDate } = require('../services/dispatch');
const { distanceM, kmFromPings } = require('../services/geo');

// Everyone signed in needs the counter strip - it sits on the live board, which is the one
// screen every desk person opens. It is a set of counts, not a report, so it is deliberately
// above the reports gate; without this, a coordinator without reports access watches the top
// of her own dashboard fail with a 403 every fifteen seconds.
router.use(auth);

router.get('/today', async (req, res) => {
  const start = new Date(new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10) + 'T00:00:00+05:30');
  const [openCases, activeTrips, runners] = await Promise.all([
    Case.countDocuments({ status: { $nin: ['CLOSED', 'CANCELLED'] } }),
    Trip.find({ status: { $nin: ['COMPLETED', 'REJECTED', 'CANCELLED'] } }).lean(),
    User.find({ role: 'runner', active: true }).lean()
  ]);
  const doneToday = await Trip.find({ completedAt: { $gte: start } }).lean();
  const tats = doneToday.map(t => tripTat(t));

  res.json({
    openCases,
    activeTrips: activeTrips.length,
    awaitingAccept: activeTrips.filter(t => t.status === 'ASSIGNED').length,
    runnersAvailable: runners.filter(r => r.dutyState === 'AVAILABLE').length,
    runnersOnTrip: runners.filter(r => r.dutyState === 'ON_TRIP').length,
    runnersOffDuty: runners.filter(r => r.dutyState === 'OFF_DUTY').length,
    runnersOnBreak: runners.filter(r => r.dutyState === 'BREAK').length,
    completedToday: doneToday.length,
    avgTatToday: avg(tats.map(t => t.totalMinutes).filter(v => v !== null)),
    breachedToday: tats.filter(t => t.worst === 'breach').length,
    liveBreaches: activeTrips.map(t => tripTat(t)).filter(t => t.worst === 'breach').length
  });
});

// Everything below is a report proper and needs the right.
router.use(can('viewReports'));

function range(req) {
  const to = req.query.to || new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const from = req.query.from || to;
  return { from: new Date(from + 'T00:00:00+05:30'), to: new Date(to + 'T23:59:59+05:30'), fromStr: from, toStr: to };
}

const avg = arr => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null);

// Trip-wise TAT sheet: one row per journey with every stage split out.
router.get('/tat', async (req, res) => {
  const { from, to } = range(req);
  const q = { assignedAt: { $gte: from, $lte: to } };
  if (req.query.runner) q.runner = req.query.runner;
  if (req.query.type) q.type = req.query.type;

  const trips = await Trip.find(q)
    .populate('runner', 'name empCode')
    .populate('case', 'caseNo patientName priority hospital')
    .populate('pickupLocation dropLocation', 'name area')
    .sort({ assignedAt: -1 }).lean();

  const rows = trips.map(t => {
    const tat = tripTat(t, new Date());
    return {
      tripNo: t.tripNo,
      caseNo: t.case && t.case.caseNo,
      patient: t.case && t.case.patientName,
      priority: t.case && t.case.priority,
      type: t.type,
      runner: t.runner && t.runner.name,
      pickup: t.pickupLocation && t.pickupLocation.name,
      drop: t.dropLocation && t.dropLocation.name,
      status: t.status,
      assignedAt: t.assignedAt,
      completedAt: t.completedAt,
      accept: tat.parts.accept.value,
      toPickup: tat.parts.toPickup.value,
      pickupDwell: tat.parts.pickupDwell.value,
      toDrop: tat.parts.toDrop.value,
      dropDwell: tat.parts.dropDwell.value,
      total: tat.parts.total.value,
      grade: tat.worst
    };
  });

  const done = rows.filter(r => r.status === 'COMPLETED');
  res.json({
    sla: SLA,
    rows,
    summary: {
      trips: rows.length,
      completed: done.length,
      rejected: rows.filter(r => r.status === 'REJECTED').length,
      breached: rows.filter(r => r.grade === 'breach').length,
      onTimePercent: done.length ? Math.round((done.filter(r => r.grade !== 'breach').length / done.length) * 100) : null,
      avgAccept: avg(done.map(r => r.accept).filter(v => v !== null)),
      avgToPickup: avg(done.map(r => r.toPickup).filter(v => v !== null)),
      avgPickupDwell: avg(done.map(r => r.pickupDwell).filter(v => v !== null)),
      avgToDrop: avg(done.map(r => r.toDrop).filter(v => v !== null)),
      avgDropDwell: avg(done.map(r => r.dropDwell).filter(v => v !== null)),
      avgTotal: avg(done.map(r => r.total).filter(v => v !== null))
    }
  });
});

// Case-wise TAT: inquiry to delivery, including the crossmatch leg.
router.get('/case-tat', async (req, res) => {
  const { from, to } = range(req);
  const cases = await Case.find({ createdAt: { $gte: from, $lte: to } })
    .populate('hospital', 'name area')
    .populate('sampleTrip deliveryTrip')
    .sort({ createdAt: -1 }).lean();

  const rows = cases.map(c => {
    const t = caseTat(c, c.sampleTrip, c.deliveryTrip, new Date());
    return {
      caseNo: c.caseNo, patient: c.patientName, hospital: c.hospital && c.hospital.name,
      bloodGroup: c.bloodGroup, component: c.component, units: c.unitsRequested,
      priority: c.priority, status: c.status, createdAt: c.createdAt, closedAt: c.closedAt,
      toAssign: t.parts.toAssign.value, sample: t.parts.samplePickup.value,
      crossmatch: t.parts.crossmatch.value, delivery: t.parts.delivery.value,
      total: t.parts.total.value, grade: t.parts.total.grade
    };
  });

  const done = rows.filter(r => ['DELIVERED', 'CLOSED'].includes(r.status));
  res.json({
    rows,
    summary: {
      cases: rows.length,
      delivered: done.length,
      cancelled: rows.filter(r => r.status === 'CANCELLED').length,
      avgTotal: avg(done.map(r => r.total).filter(v => v !== null)),
      avgCrossmatch: avg(rows.map(r => r.crossmatch).filter(v => v !== null)),
      onTimePercent: done.length ? Math.round((done.filter(r => r.grade !== 'breach').length / done.length) * 100) : null
    }
  });
});

// Runner scorecard: hours on duty, trips, distance, on-time share.
router.get('/runners', async (req, res) => {
  const { from, to, fromStr, toStr } = range(req);
  const runners = await User.find({ role: 'runner', active: true }).sort({ name: 1 }).lean();
  const trips = await Trip.find({ assignedAt: { $gte: from, $lte: to } }).lean();
  const att = await Attendance.find({ date: { $gte: fromStr, $lte: toStr } }).lean();

  const rows = [];
  for (const r of runners) {
    const mine = trips.filter(t => String(t.runner) === String(r._id));
    const done = mine.filter(t => t.status === 'COMPLETED').map(t => tripTat(t));
    const myAtt = att.filter(a => String(a.runner) === String(r._id));
    const pings = await LocationPing.find({ runner: r._id, at: { $gte: from, $lte: to } }).sort({ at: 1 }).select('lat lng').lean();

    let km = 0;
    for (let i = 1; i < pings.length; i++) {
      const d = distanceM(pings[i - 1].lat, pings[i - 1].lng, pings[i].lat, pings[i].lng) || 0;
      if (d > 20 && d < 5000) km += d / 1000;
    }

    rows.push({
      runner: r.name, empCode: r.empCode, vehicleNo: r.vehicleNo,
      daysWorked: myAtt.filter(a => a.totalMinutes > 0).length,
      dutyHours: Math.round(myAtt.reduce((s, a) => s + a.totalMinutes, 0) / 6) / 10,
      trips: mine.length,
      completed: done.length,
      rejected: mine.filter(t => t.status === 'REJECTED').length,
      avgAccept: avg(done.map(t => t.parts.accept.value).filter(v => v !== null)),
      avgTrip: avg(done.map(t => t.totalMinutes).filter(v => v !== null)),
      onTimePercent: done.length ? Math.round((done.filter(t => t.worst !== 'breach').length / done.length) * 100) : null,
      distanceKm: Math.round(km * 10) / 10
    });
  }
  res.json({ rows });
});

router.get('/attendance', async (req, res) => {
  const { fromStr, toStr } = range(req);
  const q = { date: { $gte: fromStr, $lte: toStr } };
  if (req.query.runner) q.runner = req.query.runner;
  const rows = await Attendance.find(q).populate('runner', 'name empCode').sort({ date: -1 }).lean();
  res.json({
    rows: rows.map(r => ({
      date: r.date,
      runner: r.runner && r.runner.name,
      empCode: r.runner && r.runner.empCode,
      firstIn: r.sessions[0] && r.sessions[0].inAt,
      lastOut: r.sessions.length ? r.sessions[r.sessions.length - 1].outAt : null,
      sessions: r.sessions.length,
      hours: Math.round(r.totalMinutes / 6) / 10,
      tripsDone: r.tripsDone,
      open: r.open,
      punchInPlace: r.sessions[0] ? (r.sessions[0].inAddress || (r.sessions[0].inLat + ', ' + r.sessions[0].inLng)) : '',

      // Odometer versus GPS. Two independent measures of the same day - when they disagree
      // by a lot, that is the row worth asking about.
      startOdo: r.startOdo || 0,
      endOdo: r.endOdo || 0,
      odoKm: r.odoKm || 0,
      gpsKm: r.distanceKm || 0,
      odoGap: r.odoKm && r.distanceKm ? Math.round((r.odoKm - r.distanceKm) * 10) / 10 : null,
      startOdoPhoto: r.startOdoPhoto || '',
      endOdoPhoto: r.endOdoPhoto || ''
    }))
  });
});

// Numbers for the strip across the top of the control room screen.


/*
 * The route log: every job a runner actually rode, with the path he took.
 *
 * The board answers "where is he now". This answers the question that comes afterwards -
 * which day, which sample, which way did he go, when did he punch in, how far did he ride.
 * The breadcrumb trail was already being stored for the live map; it is worth far more as a
 * record than as a moving dot, because it is the only thing that can settle an argument
 * about a route weeks later.
 *
 * Trails are kept for 45 days (the TTL on LocationPing), so a row older than that reports
 * its times and stages but no path. That is stated in the response rather than left for
 * someone to puzzle over.
 */
router.get('/routes', async (req, res) => {
  const { fromStr, toStr } = range(req);
  const from = new Date(fromStr + 'T00:00:00+05:30');
  const to = new Date(new Date(toStr + 'T00:00:00+05:30').getTime() + 24 * 3600 * 1000);

  const q = { assignedAt: { $gte: from, $lt: to } };
  if (req.query.runner) q.runner = req.query.runner;
  if (req.query.status) q.status = { $in: String(req.query.status).split(',') };

  const trips = await Trip.find(q)
    .populate('case', 'caseNo jobType patientName reference bloodGroup component')
    .populate('runner', 'name empCode vehicleNo')
    .populate('pickupLocation dropLocation', 'name area')
    .sort({ assignedAt: -1 }).limit(500).lean();

  // One query for every trail in the range, rather than one per trip.
  const ids = trips.map(t => t._id);
  const pings = await LocationPing.find({ trip: { $in: ids } })
    .select('trip lat lng at').sort({ at: 1 }).lean();

  const byTrip = {};
  pings.forEach(p => { (byTrip[String(p.trip)] = byTrip[String(p.trip)] || []).push(p); });

  // Punch-in time for each runner on each day, so the row can show when his shift started.
  const dates = Array.from(new Set(trips.map(t => ISTDate(new Date(t.assignedAt)))));
  const runnerIds = Array.from(new Set(trips.map(t => t.runner && String(t.runner._id)).filter(Boolean)));
  const attendance = await Attendance.find({ runner: { $in: runnerIds }, date: { $in: dates } })
    .select('runner date sessions startOdo').lean();

  const attKey = {};
  attendance.forEach(a => { attKey[String(a.runner) + '|' + a.date] = a; });

  const rows = trips.map(t => {
    const trail = byTrip[String(t._id)] || [];
    const day = ISTDate(new Date(t.assignedAt));
    const att = t.runner ? attKey[String(t.runner._id) + '|' + day] : null;
    const firstIn = att && att.sessions && att.sessions.length ? att.sessions[0].inAt : null;
    const tat = tripTat(t, new Date());

    return {
      id: t._id,
      date: day,
      tripNo: t.tripNo,
      type: t.type,
      status: t.status,
      caseNo: t.case && t.case.caseNo,
      jobType: t.case && t.case.jobType,
      what: t.case ? (t.case.patientName || t.case.reference || t.case.caseNo) : '',
      bloodGroup: t.case && t.case.bloodGroup,
      component: t.case && t.case.component,

      runner: t.runner && t.runner.name,
      runnerId: t.runner && t.runner._id,
      empCode: t.runner && t.runner.empCode,
      vehicleNo: t.runner && t.runner.vehicleNo,

      from: t.pickupLocation && t.pickupLocation.name,
      to: t.dropLocation && t.dropLocation.name,

      punchInAt: firstIn,
      assignedAt: t.assignedAt,
      acceptedAt: t.acceptedAt,
      atPickupAt: t.atPickupAt,
      pickedAt: t.pickedAt,
      atDropAt: t.atDropAt,
      completedAt: t.completedAt,

      // Distance actually ridden on this job, from the trail rather than the straight line.
      km: kmFromPings(trail),
      points: trail.length,
      hasTrail: trail.length > 1,

      minutes: tat.totalMinutes,
      grade: tat.worst
    };
  });

  res.json({
    from: fromStr, to: toStr,
    trailKeptDays: 45,
    rows,
    totals: {
      trips: rows.length,
      km: Math.round(rows.reduce((s, r) => s + r.km, 0) * 10) / 10,
      withTrail: rows.filter(r => r.hasTrail).length
    }
  });
});

/** The path one job actually took, with the stage markers laid on top of it. */
router.get('/routes/:id', async (req, res) => {
  const trip = await Trip.findById(req.params.id)
    .populate('case', 'caseNo jobType patientName reference bloodGroup component unitsRequested')
    .populate('runner', 'name empCode phone vehicleNo')
    .populate('pickupLocation dropLocation', 'name area lat lng geofence')
    .lean();
  if (!trip) return res.status(404).json({ error: 'Job not found' });

  const trail = await LocationPing.find({ trip: trip._id })
    .select('lat lng at speed').sort({ at: 1 }).lean();

  res.json({
    trip: {
      id: trip._id, tripNo: trip.tripNo, type: trip.type, status: trip.status,
      caseNo: trip.case && trip.case.caseNo,
      what: trip.case ? (trip.case.patientName || trip.case.reference || trip.case.caseNo) : '',
      runner: trip.runner && trip.runner.name,
      vehicleNo: trip.runner && trip.runner.vehicleNo,
      pickup: trip.pickupLocation, drop: trip.dropLocation,
      assignedAt: trip.assignedAt, acceptedAt: trip.acceptedAt,
      atPickupAt: trip.atPickupAt, pickedAt: trip.pickedAt,
      atDropAt: trip.atDropAt, completedAt: trip.completedAt,
      events: trip.events || []
    },
    trail: trail.map(p => ({ lat: p.lat, lng: p.lng, at: p.at, speed: p.speed })),
    km: kmFromPings(trail),
    tat: tripTat(trip, new Date())
  });
});

module.exports = router;
