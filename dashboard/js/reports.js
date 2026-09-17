/* Trip-wise TAT sheet and the case-wise report behind it. */
const Reports = (function () {
  let tripRows = [];
  let caseRows = [];
  let bootedTrips = false;
  let bootedRep = false;

  async function bootTrips() {
    if (!bootedTrips) {
      bootedTrips = true;
      document.getElementById('tripFrom').value = F.today();
      document.getElementById('tripTo').value = F.today();
      document.getElementById('tripApply').addEventListener('click', loadTrips);
      document.getElementById('tripExport').addEventListener('click', exportTrips);

      const runners = await API.get('/api/users', { role: 'runner' });
      document.getElementById('tripRunner').innerHTML = '<option value="">Everyone</option>' +
        runners.map(r => '<option value="' + r.id + '">' + F.esc(r.name) + '</option>').join('');
    }
    await loadTrips();
  }

  async function loadTrips() {
    const data = await API.get('/api/reports/tat', {
      from: document.getElementById('tripFrom').value,
      to: document.getElementById('tripTo').value,
      runner: document.getElementById('tripRunner').value,
      type: document.getElementById('tripType').value
    });
    tripRows = data.rows;

    const s = data.summary;
    document.getElementById('tripSummary').innerHTML =
      '<div class="strip" style="border:1px solid var(--line);border-radius:var(--radius)">' +
      stat(s.trips, 'Trips') + stat(s.completed, 'Finished') +
      stat(s.onTimePercent === null ? '--' : s.onTimePercent + '%', 'On time', s.onTimePercent >= 80 ? 'is-good' : 'is-alert') +
      stat(s.breached, 'SLA missed', s.breached ? 'is-alert' : '') +
      stat(F.mins(s.avgAccept), 'Avg accept') + stat(F.mins(s.avgToPickup), 'Avg to pickup') +
      stat(F.mins(s.avgPickupDwell), 'Avg at pickup') + stat(F.mins(s.avgToDrop), 'Avg to drop') +
      stat(F.mins(s.avgTotal), 'Avg full trip') + '</div>';

    const host = document.getElementById('tripRows');
    if (!tripRows.length) { host.innerHTML = UI.emptyRow(13, 'No trips in this range'); return; }

    host.innerHTML = tripRows.map(r =>
      '<tr><td class="mono">' + F.esc(r.tripNo) + '</td>' +
      '<td class="mono" style="font-size:12px">' + F.esc(r.caseNo || '') + '</td>' +
      '<td>' + (r.type === 'SAMPLE_PICKUP' ? 'Sample' : 'Delivery') + '</td>' +
      '<td>' + F.esc(r.runner || '-') + '</td>' +
      '<td style="font-size:12px">' + F.esc(r.pickup) + ' &rarr; ' + F.esc(r.drop) + '</td>' +
      '<td><span class="chip ' + (r.status === 'COMPLETED' ? 'chip--green' : ['REJECTED', 'CANCELLED'].includes(r.status) ? 'chip--red' : 'chip--blue') + '">' +
      F.stageLabel(r.type, r.status) + '</span></td>' +
      cell(r.accept) + cell(r.toPickup) + cell(r.pickupDwell) + cell(r.toDrop) + cell(r.dropDwell) +
      '<td class="num ' + (r.grade === 'breach' ? 't-breach' : r.grade === 'warn' ? 't-warn' : 't-ok') + '"><b>' + F.mins(r.total) + '</b></td>' +
      '<td><button class="btn btn--ghost btn--sm" data-trip="' + F.esc(r.tripNo) + '">Open</button></td></tr>').join('');

    host.querySelectorAll('[data-trip]').forEach(b => b.addEventListener('click', async () => {
      const list = await API.get('/api/trips', { from: document.getElementById('tripFrom').value, to: document.getElementById('tripTo').value });
      const hit = list.find(t => t.tripNo === b.dataset.trip);
      if (hit) Live.openTrip(hit._id);
    }));
  }

  const cell = v => '<td class="num">' + F.mins(v) + '</td>';
  const stat = (value, label, cls) =>
    '<div class="stat ' + (cls || '') + '"><b class="mono">' + value + '</b><span>' + label + '</span></div>';

  function exportTrips() {
    UI.csv('ibs-trip-tat.csv',
      ['Trip', 'Case', 'Patient', 'Priority', 'Leg', 'Runner', 'Pickup', 'Drop', 'Stage', 'Assigned', 'Finished',
        'Accept min', 'To pickup min', 'At pickup min', 'To drop min', 'At drop min', 'Total min', 'SLA'],
      tripRows.map(r => [r.tripNo, r.caseNo, r.patient, r.priority, r.type, r.runner, r.pickup, r.drop, r.status,
        F.dateTime(r.assignedAt), F.dateTime(r.completedAt), r.accept, r.toPickup, r.pickupDwell, r.toDrop, r.dropDwell, r.total, r.grade]));
  }

  async function bootReports() {
    if (!bootedRep) {
      bootedRep = true;
      document.getElementById('repFrom').value = F.today();
      document.getElementById('repTo').value = F.today();
      document.getElementById('repApply').addEventListener('click', loadCases);
      document.getElementById('repExport').addEventListener('click', () =>
        UI.csv('ibs-case-tat.csv',
          ['Case', 'Patient', 'Hospital', 'Group', 'Component', 'Units', 'Priority', 'Stage', 'Raised', 'Closed',
            'To assign min', 'Sample leg min', 'Crossmatch min', 'Delivery leg min', 'Total min'],
          caseRows.map(r => [r.caseNo, r.patient, r.hospital, r.bloodGroup, r.component, r.units, r.priority, r.status,
            F.dateTime(r.createdAt), F.dateTime(r.closedAt), r.toAssign, r.sample, r.crossmatch, r.delivery, r.total])));
    }
    await loadCases();
  }

  async function loadCases() {
    const data = await API.get('/api/reports/case-tat', {
      from: document.getElementById('repFrom').value,
      to: document.getElementById('repTo').value
    });
    caseRows = data.rows;
    const s = data.summary;

    document.getElementById('repSummary').innerHTML =
      '<div class="strip" style="border:1px solid var(--line);border-radius:var(--radius)">' +
      stat(s.cases, 'Cases raised') + stat(s.delivered, 'Blood delivered') +
      stat(s.cancelled, 'Cancelled', s.cancelled ? 'is-alert' : '') +
      stat(F.mins(s.avgCrossmatch), 'Avg crossmatch') +
      stat(F.mins(s.avgTotal), 'Avg request to bag') +
      stat(s.onTimePercent === null ? '--' : s.onTimePercent + '%', 'On time', s.onTimePercent >= 80 ? 'is-good' : 'is-alert') + '</div>';

    const host = document.getElementById('repRows');
    if (!caseRows.length) { host.innerHTML = UI.emptyRow(11, 'No cases in this range'); return; }

    host.innerHTML = caseRows.map(r =>
      '<tr><td class="mono">' + F.esc(r.caseNo) + '</td>' +
      '<td>' + F.esc(r.patient) + '</td>' +
      '<td>' + F.esc(r.hospital || '') + '</td>' +
      '<td>' + F.esc(r.bloodGroup || '-') + '</td>' +
      '<td>' + UI.priorityChip(r.priority) + '</td>' +
      '<td>' + F.caseLabel(r.status) + '</td>' +
      cell(r.toAssign) + cell(r.sample) + cell(r.crossmatch) + cell(r.delivery) +
      '<td class="num ' + (r.grade === 'breach' ? 't-breach' : r.grade === 'warn' ? 't-warn' : 't-ok') + '"><b>' + F.mins(r.total) + '</b></td></tr>').join('');
  }

  return { bootTrips, bootReports };
})();
