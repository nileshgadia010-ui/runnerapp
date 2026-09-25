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
const { daySheets } = require('../services/movement');
const XL = require('../services/workbook');

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

// One query, used by both the on-screen TAT table and the Excel download, so the two can
// never disagree about which trips fall in a range.
function tatQuery(req) {
  const { from, to } = range(req);
  const q = { assignedAt: { $gte: from, $lte: to } };
  if (req.query.runner) q.runner = req.query.runner;
  if (req.query.type) q.type = req.query.type;
  return Trip.find(q)
    .populate('runner', 'name empCode')
    .populate('case', 'caseNo patientName priority hospital')
    .populate('pickupLocation dropLocation', 'name area')
    .sort({ assignedAt: -1 }).lean();
}

const LEG = {
  SAMPLE_PICKUP: 'Sample pickup',
  BLOOD_DELIVERY: 'Blood delivery',
  COLLECTION_SAMPLE: 'Collection sample',
  PAYMENT_COLLECT: 'Payment collect',
  PACKAGE_DELIVER: 'Package deliver'
};

const STAGE_WORDS = {
  ASSIGNED: 'Waiting to accept', ACCEPTED: 'Accepted', EN_ROUTE_PICKUP: 'Riding to pickup',
  AT_PICKUP: 'At pickup', PICKED: 'Collected', EN_ROUTE_DROP: 'Riding to drop',
  AT_DROP: 'At drop', COMPLETED: 'Finished', REJECTED: 'Rejected', CANCELLED: 'Cancelled'
};

// Rows shaped for the workbook: words instead of codes, blanks instead of nulls, and a
// breach flag beside every timing so the sheet can paint the late ones red.
async function tatRows(req, fromStr, toStr) {
  const trips = await tatQuery(req);
  const now = new Date();

  const rows = trips.map(t => {
    const tat = tripTat(t, now);
    const p = tat.parts;
    const cell = v => (v === null || v === undefined ? '' : XL.hm(v));
    return {
      date: XL.day(t.assignedAt),
      tripNo: t.tripNo || '',
      caseNo: (t.case && t.case.caseNo) || '',
      leg: LEG[t.type] || t.type,
      runner: (t.runner && t.runner.name) || 'Unassigned',
      route: [t.pickupLocation && t.pickupLocation.name, t.dropLocation && t.dropLocation.name]
        .filter(Boolean).join('  to  '),
      stage: STAGE_WORDS[t.status] || t.status,
      accept: cell(p.accept.value), acceptBreach: p.accept.grade === 'breach',
      toPickup: cell(p.toPickup.value), toPickupBreach: p.toPickup.grade === 'breach',
      atPickup: cell(p.pickupDwell.value), atPickupBreach: p.pickupDwell.grade === 'breach',
      toDrop: cell(p.toDrop.value), toDropBreach: p.toDrop.grade === 'breach',
      atDrop: cell(p.dropDwell.value), atDropBreach: p.dropDwell.grade === 'breach',
      total: cell(p.total.value), totalBreach: p.total.grade === 'breach',
      _status: t.status, _worst: tat.worst, _parts: p
    };
  });

  const done = rows.filter(r => r._status === 'COMPLETED');
  const num = key => avg(done.map(r => r._parts[key].value).filter(v => v !== null));

  return {
    from: fromStr, to: toStr,
    rows: rows.map(({ _status, _worst, _parts, ...keep }) => keep),
    summary: {
      trips: rows.length,
      completed: done.length,
      rejected: rows.filter(r => r._status === 'REJECTED').length,
      breaches: rows.filter(r => r._worst === 'breach').length,
      onTimePct: done.length ? Math.round((done.filter(r => r._worst !== 'breach').length / done.length) * 100) : null,
      avgAccept: num('accept'),
      avgToPickup: num('toPickup'),
      avgTotal: num('total')
    }
  };
}

// Trip-wise TAT sheet: one row per journey with every stage split out.
router.get('/tat', async (req, res) => {
  const trips = await tatQuery(req);

  const rows = trips.map(t => {
    const tat = tripTat(t, new Date());
    return {
      id: t._id,
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
      id: c._id,
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
    // One calculation for the whole system. This used to keep its own rule - anything over
    // 20 m counts - which both disagreed with every other screen and still let a parked
    // phone's jitter through.
    const pings = await LocationPing.find({ runner: r._id, at: { $gte: from, $lte: to } })
      .sort({ at: 1 }).select('lat lng at accuracy mock').lean();
    const km = kmFromPings(pings);

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
      distanceKm: km
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
      id: r._id,
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

// A day's punch record, thrown away. Test punches and duplicate days are the reason this
// exists: the office needs to clear them without a database console. The jobs the runner did
// that day are separate records and are deliberately left alone.
router.delete('/attendance/:id', can('deleteRecords'), async (req, res, next) => {
  try {
    const row = await Attendance.findById(req.params.id).populate('runner', 'name').lean();
    if (!row) return res.status(404).json({ error: 'That attendance record is already gone' });
    if (row.open) {
      return res.status(409).json({
        error: 'This runner is still punched in on that day. Ask him to punch out first.'
      });
    }
    await Attendance.deleteOne({ _id: req.params.id });
    res.json({
      ok: true,
      message: 'Deleted the ' + row.date + ' record for ' + ((row.runner && row.runner.name) || 'that runner')
    });
  } catch (e) { next(e); }
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
// Shared by the on-screen route log and its Excel download, so the sheet always says exactly
// what the screen said.
async function routeRows(req) {
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
    .select('trip lat lng at accuracy mock').sort({ at: 1 }).lean();

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

  return {
    from: fromStr, to: toStr,
    trailKeptDays: 45,
    rows,
    totals: {
      trips: rows.length,
      km: Math.round(rows.reduce((s, r) => s + r.km, 0) * 10) / 10,
      withTrail: rows.filter(r => r.hasTrail).length
    }
  };
}

router.get('/routes', async (req, res, next) => {
  try { res.json(await routeRows(req)); } catch (e) { next(e); }
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
    .select('lat lng at speed accuracy mock').sort({ at: 1 }).lean();

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

/* ------------------------------------------------------------------ *
 * Day sheet - punch in, every stop, punch out
 * ------------------------------------------------------------------ */

router.get('/movement', async (req, res) => {
  const { fromStr, toStr } = range(req);
  const sheets = await daySheets({ from: fromStr, to: toStr, runnerId: req.query.runner || null });

  res.json({
    from: fromStr, to: toStr,
    rows: sheets,
    totals: summarise(sheets)
  });
});

function summarise(sheets) {
  const done = sheets.filter(s => s.punchIn);
  return {
    days: sheets.length,
    runners: new Set(sheets.map(s => s.runnerId)).size,
    hours: Math.round(sheets.reduce((n, s) => n + s.minutes, 0) / 6) / 10,
    km: Math.round(sheets.reduce((n, s) => n + s.km, 0) * 10) / 10,
    stops: sheets.reduce((n, s) => n + s.stopCount, 0),
    stillOn: sheets.filter(s => s.stillOn).length,
    jobs: sheets.reduce((n, s) => n + s.jobsDone, 0),
    avgKm: done.length ? Math.round(sheets.reduce((n, s) => n + s.km, 0) / done.length * 10) / 10 : 0,
    avgStops: done.length ? Math.round(sheets.reduce((n, s) => n + s.stopCount, 0) / done.length * 10) / 10 : 0
  };
}

/* ------------------------------------------------------------------ *
 * Excel downloads
 *
 * Each of these is a workbook rather than a CSV for one reason: the office wants the answer
 * at the top and the evidence underneath, and a CSV can only carry the evidence. See
 * services/workbook.js for the shared layout.
 * ------------------------------------------------------------------ */

router.get('/movement.xlsx', async (req, res, next) => {
  try {
    const { fromStr, toStr } = range(req);
    const sheets = await daySheets({ from: fromStr, to: toStr, runnerId: req.query.runner || null });
    const t = summarise(sheets);

    const wb = XL.newBook();
    const ws = wb.addWorksheet('Day sheet');

    const start = XL.header(ws, 'Runner day sheet',
      period(fromStr, toStr) + (sheets.length ? '' : '  -  no activity in this range'),
      [
        { label: 'Runner days', value: t.days },
        { label: 'Hours on duty', value: t.hours },
        { label: 'Distance ridden', value: t.km + ' km' },
        { label: 'Stops made', value: t.stops },
        { label: 'Jobs finished', value: t.jobs },
        { label: 'Avg km a day', value: t.avgKm }
      ], 14);

    XL.table(ws, start, [
      { key: 'date', label: 'Date', width: 12 },
      { key: 'runner', label: 'Runner', width: 20 },
      { key: 'vehicleNo', label: 'Vehicle', width: 15 },
      { key: 'inAt', label: 'Punch in', width: 11 },
      { key: 'inPlace', label: 'Punched in at', width: 30 },
      { key: 'outAt', label: 'Punch out', width: 11 },
      { key: 'outPlace', label: 'Punched out at', width: 30 },
      { key: 'hours', label: 'On duty', width: 10, align: 'right' },
      { key: 'stopCount', label: 'Stops', width: 8, align: 'right' },
      { key: 'placesVisited', label: 'Places', width: 8, align: 'right' },
      { key: 'jobsDone', label: 'Jobs done', width: 10, align: 'right' },
      { key: 'km', label: 'GPS km', width: 10, align: 'right', numFmt: '0.0' },
      { key: 'odoKm', label: 'Meter km', width: 10, align: 'right' },
      { key: 'gap', label: 'Gap', width: 10, align: 'right',
        flag: r => Math.abs(Number(r.gap) || 0) >= 15 }
    ], sheets.map(s => ({
      date: s.date,
      runner: s.runner,
      vehicleNo: s.vehicleNo || '',
      inAt: s.punchIn ? XL.clock(s.punchIn.at) : '',
      inPlace: s.punchIn ? s.punchIn.place : 'Not punched in',
      outAt: s.punchOut ? XL.clock(s.punchOut.at) : (s.stillOn ? 'still on duty' : ''),
      outPlace: s.punchOut ? s.punchOut.place : '',
      hours: XL.hm(s.minutes),
      stopCount: s.stopCount,
      placesVisited: s.placesVisited,
      jobsDone: s.jobsDone,
      km: s.km,
      odoKm: s.odoKm || '',
      gap: s.odoKm && s.km ? Math.round((s.odoKm - s.km) * 10) / 10 : ''
    })));

    // Every individual stop, so the summary above can be checked line by line.
    const stopsSheet = wb.addWorksheet('Every stop');
    const rows = [];
    sheets.forEach(s => s.stops.forEach(st => rows.push({
      date: s.date, runner: s.runner,
      at: XL.clock(st.at),
      place: st.place,
      area: st.area || '',
      did: st.did,
      leftAt: st.leftAt ? XL.clock(st.leftAt) : '',
      minutes: st.minutes === null ? '' : st.minutes,
      tripNo: st.tripNo,
      what: st.what || ''
    })));

    const s2 = XL.header(stopsSheet, 'Every stop', period(fromStr, toStr), [
      { label: 'Stops', value: rows.length },
      { label: 'Runner days', value: t.days },
      { label: 'Jobs finished', value: t.jobs }
    ], 10);

    XL.table(stopsSheet, s2, [
      { key: 'date', label: 'Date', width: 12 },
      { key: 'runner', label: 'Runner', width: 20 },
      { key: 'at', label: 'Reached', width: 11 },
      { key: 'leftAt', label: 'Left', width: 11 },
      { key: 'minutes', label: 'Minutes there', width: 14, align: 'right',
        flag: r => Number(r.minutes) >= 30 },
      { key: 'place', label: 'Place', width: 32 },
      { key: 'area', label: 'Area', width: 18 },
      { key: 'did', label: 'What happened', width: 26 },
      { key: 'tripNo', label: 'Job', width: 22 },
      { key: 'what', label: 'For', width: 24 }
    ], rows);

    await XL.send(res, wb, 'ibs-day-sheet-' + fromStr + '-to-' + toStr + '.xlsx');
  } catch (e) { next(e); }
});

router.get('/tat.xlsx', async (req, res, next) => {
  try {
    const { fromStr, toStr } = range(req);
    const data = await tatRows(req, fromStr, toStr);

    const wb = XL.newBook();
    const ws = wb.addWorksheet('Trip TAT');
    const s = data.summary;

    const start = XL.header(ws, 'Trip TAT', period(fromStr, toStr), [
      { label: 'Trips', value: s.trips },
      { label: 'Finished', value: s.completed },
      { label: 'On time', value: (s.onTimePct === null ? '-' : s.onTimePct + '%') },
      { label: 'SLA missed', value: s.breaches, alert: s.breaches > 0 },
      { label: 'Avg accept', value: XL.hm(s.avgAccept) },
      { label: 'Avg to pickup', value: XL.hm(s.avgToPickup) },
      { label: 'Avg full trip', value: XL.hm(s.avgTotal) }
    ], 14);

    XL.table(ws, start, [
      { key: 'date', label: 'Date', width: 12 },
      { key: 'tripNo', label: 'Trip', width: 22 },
      { key: 'caseNo', label: 'Case', width: 18 },
      { key: 'leg', label: 'Leg', width: 18 },
      { key: 'runner', label: 'Runner', width: 20 },
      { key: 'route', label: 'From to', width: 40 },
      { key: 'stage', label: 'Stage', width: 24 },
      { key: 'accept', label: 'Accept', width: 10, align: 'right', flag: r => r.acceptBreach },
      { key: 'toPickup', label: 'To pickup', width: 11, align: 'right', flag: r => r.toPickupBreach },
      { key: 'atPickup', label: 'At pickup', width: 11, align: 'right', flag: r => r.atPickupBreach },
      { key: 'toDrop', label: 'To drop', width: 10, align: 'right', flag: r => r.toDropBreach },
      { key: 'atDrop', label: 'At drop', width: 10, align: 'right', flag: r => r.atDropBreach },
      { key: 'total', label: 'Total', width: 10, align: 'right', flag: r => r.totalBreach }
    ], data.rows);

    await XL.send(res, wb, 'ibs-trip-tat-' + fromStr + '-to-' + toStr + '.xlsx');
  } catch (e) { next(e); }
});

router.get('/routes.xlsx', async (req, res, next) => {
  try {
    const { fromStr, toStr } = range(req);

    const data = await routeRows(req);

    const wb = XL.newBook();
    const ws = wb.addWorksheet('Route log');
    const start = XL.header(ws, 'Route log', period(fromStr, toStr), [
      { label: 'Jobs', value: data.totals.trips },
      { label: 'Distance ridden', value: data.totals.km + ' km' },
      { label: 'With GPS trail', value: data.totals.withTrail },
      { label: 'SLA missed', value: data.rows.filter(r => r.grade === 'breach').length,
        alert: data.rows.some(r => r.grade === 'breach') },
      { label: 'Avg km a job', value: data.rows.length
        ? Math.round((data.totals.km / data.rows.length) * 10) / 10 : 0 }
    ], 16);

    XL.table(ws, start, [
      { key: 'date', label: 'Date', width: 12 },
      { key: 'runner', label: 'Runner', width: 20 },
      { key: 'vehicleNo', label: 'Vehicle', width: 14 },
      { key: 'punchIn', label: 'Punched in', width: 12 },
      { key: 'tripNo', label: 'Job', width: 20 },
      { key: 'leg', label: 'Leg', width: 18 },
      { key: 'what', label: 'For', width: 24 },
      { key: 'from', label: 'From', width: 28 },
      { key: 'to', label: 'To', width: 28 },
      { key: 'assigned', label: 'Given', width: 11 },
      { key: 'reachedPickup', label: 'At pickup', width: 11 },
      { key: 'reachedDrop', label: 'At drop', width: 11 },
      { key: 'finished', label: 'Finished', width: 11 },
      { key: 'minutes', label: 'Took', width: 10, align: 'right',
        flag: r => r._breach },
      { key: 'km', label: 'Km ridden', width: 11, align: 'right', numFmt: '0.0' },
      { key: 'stage', label: 'Stage', width: 20 }
    ], data.rows.map(r => ({
      date: r.date,
      runner: r.runner || 'Unassigned',
      vehicleNo: r.vehicleNo || '',
      punchIn: r.punchInAt ? XL.clock(r.punchInAt) : '',
      tripNo: r.tripNo || '',
      leg: LEG[r.type] || r.type,
      what: r.what || '',
      from: r.from || '',
      to: r.to || '',
      assigned: XL.clock(r.assignedAt),
      reachedPickup: XL.clock(r.atPickupAt),
      reachedDrop: XL.clock(r.atDropAt),
      finished: XL.clock(r.completedAt),
      minutes: XL.hm(r.minutes),
      km: r.km,
      stage: STAGE_WORDS[r.status] || r.status,
      _breach: r.grade === 'breach'
    })));

    await XL.send(res, wb, 'ibs-route-log-' + fromStr + '-to-' + toStr + '.xlsx');
  } catch (e) { next(e); }
});

const period = (a, b) => a === b ? 'For ' + a : a + '  to  ' + b;

module.exports = router;
