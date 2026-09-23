/*
 * Route log - what each runner actually rode, after the fact.
 *
 * The live board answers "where is he now". This answers everything that gets asked later:
 * which day, which sample, which way did he go, when did his shift start, how far did he
 * ride for that one job. The breadcrumb trail was already being kept for the moving dot; it
 * is worth more as a record than as an animation, because weeks later it is the only thing
 * that can settle an argument about a route.
 */
const Routes = (function () {
  let rows = [];
  let booted = false;
  let map = null, layer = null;

  async function boot() {
    if (!booted) {
      booted = true;
      document.getElementById('rtFrom').value = F.today();
      document.getElementById('rtTo').value = F.today();
      document.getElementById('rtApply').addEventListener('click', load);
      document.getElementById('rtExport').addEventListener('click', exportCsv);
      document.getElementById('rtExcel').addEventListener('click', function () {
        UI.download('/api/reports/routes.xlsx', {
          from: document.getElementById('rtFrom').value,
          to: document.getElementById('rtTo').value,
          runner: document.getElementById('rtRunner').value
        }, this);
      });
      UI.wireDelete('rtRows', load);
      await fillRunners();
    }
    await load();
  }

  async function fillRunners() {
    const staff = await API.get('/api/users', { role: 'runner', active: 'all' });
    document.getElementById('rtRunner').innerHTML =
      '<option value="">Every runner</option>' +
      staff.map(r => '<option value="' + r.id + '">' + F.esc(r.name) + '</option>').join('');
  }

  async function load() {
    const data = await API.get('/api/reports/routes', {
      from: document.getElementById('rtFrom').value,
      to: document.getElementById('rtTo').value,
      runner: document.getElementById('rtRunner').value
    });
    rows = data.rows;

    document.getElementById('rtTotals').innerHTML =
      tile(data.totals.trips, 'Jobs in this range') +
      tile(data.totals.km + ' km', 'Distance ridden') +
      tile(data.totals.withTrail + ' of ' + data.totals.trips, 'With a saved path');

    const host = document.getElementById('rtRows');
    if (!rows.length) { host.innerHTML = UI.emptyRow(10, 'No jobs in this range'); return; }

    host.innerHTML = rows.map(r =>
      '<tr data-route="' + r.id + '">' +
      '<td>' + F.date(r.date) + '</td>' +
      '<td><b class="mono">' + F.esc(r.tripNo) + '</b>' +
        '<div style="font-size:11px;color:var(--muted)">' + F.jobTitle(r.type) + '</div></td>' +
      '<td>' + F.esc(r.what || '-') +
        (r.bloodGroup ? '<div style="font-size:11px;color:var(--muted)">' +
          F.esc(r.bloodGroup) + ' ' + F.esc(r.component || '') + '</div>' : '') + '</td>' +
      '<td>' + F.esc(r.runner || 'Unassigned') +
        (r.vehicleNo ? '<div style="font-size:11px;color:var(--muted)">' + F.esc(r.vehicleNo) + '</div>' : '') + '</td>' +
      '<td>' + (r.punchInAt ? F.time(r.punchInAt) : '<span style="color:var(--muted)">-</span>') + '</td>' +
      '<td>' + F.time(r.assignedAt) + '</td>' +
      '<td>' + (r.completedAt ? F.time(r.completedAt) : '<span class="chip chip--amber">not finished</span>') + '</td>' +
      '<td class="num">' + (r.minutes === null ? '-' : F.mins(r.minutes)) + '</td>' +
      '<td class="num"><b>' + r.km + ' km</b></td>' +
      '<td class="rowacts">' + (r.hasTrail
        ? '<button class="btn btn--ghost btn--sm" data-view="' + r.id + '">View route</button>'
        : '<span style="font-size:12px;color:var(--muted)">no path kept</span>') +
        UI.delBtn('trip', r.id, 'job ' + (r.tripNo || '')) + '</td>' +
      '</tr>').join('');

    host.querySelectorAll('[data-view]').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); openRoute(b.dataset.view); }));
  }

  function tile(value, label) {
    return '<div class="stat"><b class="mono">' + value + '</b><span>' + label + '</span></div>';
  }

  /*
   * One job's path, on its own map inside the drawer. A fresh Leaflet instance is created
   * each time rather than reusing the live board's - the two are looking at different things
   * and sharing one map would mean every route view disturbed whatever the desk had on screen.
   */
  async function openRoute(id) {
    let d;
    try { d = await API.get('/api/reports/routes/' + id); }
    catch (e) { return toast(e.message, 'error'); }

    const t = d.trip;
    const stages = (t.events || []).filter(e => e.lat).map(e =>
      '<li><b>' + F.stageLabel(t.type, e.status) + '</b> &middot; ' + F.time(e.at) +
      (e.distanceToTargetM !== null && e.distanceToTargetM !== undefined
        ? ' <span style="color:var(--muted)">' + e.distanceToTargetM + ' m from target</span>' : '') +
      '</li>').join('');

    UI.openDrawer(t.tripNo + ' - route',
      '<div id="routeMap" style="height:300px;border-radius:var(--radius);border:1px solid var(--line)"></div>' +
      '<div class="grid-3" style="margin-top:16px">' +
        '<div><b class="mono" style="font-size:19px;display:block">' + d.km + ' km</b>' +
          '<span style="font-size:12px;color:var(--muted)">Ridden</span></div>' +
        '<div><b class="mono" style="font-size:19px;display:block">' + F.mins(d.tat.totalMinutes) + '</b>' +
          '<span style="font-size:12px;color:var(--muted)">Door to door</span></div>' +
        '<div><b class="mono" style="font-size:19px;display:block">' + d.trail.length + '</b>' +
          '<span style="font-size:12px;color:var(--muted)">Points recorded</span></div>' +
      '</div>' +
      '<p style="margin-top:16px"><b>' + F.esc(t.what) + '</b><br>' +
        '<span style="color:var(--muted)">' + F.esc(t.runner || 'Unassigned') +
        (t.vehicleNo ? ' &middot; ' + F.esc(t.vehicleNo) : '') + '</span></p>' +
      '<p style="color:var(--muted)">' + F.esc(t.pickup ? t.pickup.name : '') + ' &rarr; ' +
        F.esc(t.drop ? t.drop.name : '') + '</p>' +
      (stages ? '<h4 style="margin:16px 0 8px">What happened</h4><ul class="stagelist">' + stages + '</ul>' : ''),
      '<button class="btn btn--ghost" onclick="UI.closeDrawer()">Close</button>');

    // The drawer has to be on screen before Leaflet can measure its container.
    setTimeout(() => drawRoute(d), 120);
  }

  function drawRoute(d) {
    const host = document.getElementById('routeMap');
    if (!host || !window.L) return;

    if (map) { map.remove(); map = null; }
    map = L.map(host, { zoomControl: true, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    layer = L.layerGroup().addTo(map);

    const path = d.trail.map(p => [p.lat, p.lng]);
    const bounds = [];

    if (path.length > 1) {
      L.polyline(path, { color: '#1F5FD9', weight: 4, opacity: .85 }).addTo(layer);
      bounds.push.apply(bounds, path);

      // Where he set off and where he ended up, so the line has a direction.
      L.marker(path[0], { icon: dot('#067A55', 'A') }).addTo(layer).bindTooltip('Started ' + F.time(d.trail[0].at));
      L.marker(path[path.length - 1], { icon: dot('#C8102E', 'B') }).addTo(layer)
        .bindTooltip('Ended ' + F.time(d.trail[d.trail.length - 1].at));
    }

    [['pickup', '#101828'], ['drop', '#101828']].forEach(([key, colour]) => {
      const p = d.trip[key];
      if (!p || typeof p.lat !== 'number') return;
      L.marker([p.lat, p.lng], { icon: square(colour) }).addTo(layer).bindTooltip(p.name);
      L.circle([p.lat, p.lng], { radius: p.geofence || 200, color: '#C8102E', weight: 1, fillOpacity: .05 }).addTo(layer);
      bounds.push([p.lat, p.lng]);
    });

    if (bounds.length > 1) map.fitBounds(L.latLngBounds(bounds).pad(0.2));
    else if (bounds.length === 1) map.setView(bounds[0], 15);
    else map.setView([23.0225, 72.5714], 12);

    setTimeout(() => map.invalidateSize(), 60);
  }

  const dot = (colour, letter) => L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11],
    html: '<div style="width:22px;height:22px;border-radius:50%;background:' + colour +
          ';color:#fff;border:2px solid #fff;display:grid;place-items:center;font-size:11px;font-weight:700">' +
          letter + '</div>' });

  const square = colour => L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9],
    html: '<div style="width:18px;height:18px;border-radius:4px;background:#fff;border:2px solid ' +
          colour + '"></div>' });

  function exportCsv() {
    UI.csv('ibs-route-log.csv',
      ['Date', 'Job', 'Type', 'What', 'Blood group', 'Component', 'Runner', 'Vehicle',
       'From', 'To', 'Punch in', 'Assigned', 'Accepted', 'At pickup', 'Picked', 'At drop',
       'Finished', 'Minutes', 'Distance km', 'Points recorded'],
      rows.map(r => [r.date, r.tripNo, r.type, r.what, r.bloodGroup, r.component,
        r.runner, r.vehicleNo, r.from, r.to,
        F.time(r.punchInAt), F.time(r.assignedAt), F.time(r.acceptedAt), F.time(r.atPickupAt),
        F.time(r.pickedAt), F.time(r.atDropAt), F.time(r.completedAt),
        r.minutes, r.km, r.points]));
  }

  return { boot, load };
})();
