/* Live board - the map, the runner pins and the running-job dock. */
const Live = (function () {
  let map, runnerLayer, siteLayer, routeLayer;
  const markers = {};
  let dockTab = 'jobs';
  let runners = [];
  let trips = [];
  let places = [];
  let followTripId = null;
  let booted = false;

  function boot() {
    if (booted) return;
    booted = true;

    map = L.map('map', { zoomControl: true, attributionControl: true }).setView([23.0225, 72.5714], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    siteLayer = L.layerGroup().addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    runnerLayer = L.layerGroup().addTo(map);

    document.querySelectorAll('.dock__tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.dock__tab').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        dockTab = btn.dataset.dock;
        paintDock();
      });
    });

    loadPlaces();
    refresh();
    setInterval(refresh, 10000);
    setInterval(paintDock, 1000);   // keeps the running clocks ticking
  }

  async function loadPlaces() {
    try {
      places = await API.get('/api/locations');
      siteLayer.clearLayers();
      places.forEach(p => {
        const center = p.type === 'BLOOD_CENTER';
        L.marker([p.lat, p.lng], {
          icon: L.divIcon({
            className: '',
            html: '<div class="pin-site ' + (center ? 'pin-site--center' : '') + '">' + (center ? '&#43;' : '&#9678;') + '</div>',
            iconSize: [22, 22], iconAnchor: [11, 11]
          })
        }).bindTooltip(p.name + (p.area ? ' - ' + p.area : '')).addTo(siteLayer);
      });
    } catch (e) { /* map still works without the site pins */ }
  }

  async function refresh() {
    try {
      const [live, active] = await Promise.all([
        API.get('/api/users/live'),
        API.get('/api/trips', { active: 1 })
      ]);
      runners = live;
      trips = active;
      paintMarkers();
      paintDock();
      if (followTripId) drawRoute(followTripId);
    } catch (e) { /* silent - next tick retries */ }
  }

  function pinClass(r) {
    if (r.signalLost) return 'pin--red';
    if (r.dutyState === 'ON_TRIP') return 'pin--blue';
    if (r.dutyState === 'AVAILABLE') return 'pin--green';
    if (r.dutyState === 'BREAK') return 'pin--amber';
    return 'pin--grey';
  }

  // A runner on the road is drawn as a scooter; a runner standing free is drawn as a person.
  // Initials alone made every pin look identical from a distance - at a glance the desk now
  // sees who is moving and who is waiting without reading anything.
  const ICON_SCOOTER =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="5.5" cy="17.5" r="3"/><circle cx="18.5" cy="17.5" r="3"/>' +
    '<path d="M5.5 17.5h8l3-9h2"/><path d="M13 8.5h3"/></svg>';

  const ICON_PERSON =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="7.5" r="3.2"/><path d="M5.5 20.5a6.5 6.5 0 0 1 13 0"/></svg>';

  function pinGlyph(r) {
    if (r.dutyState === 'ON_TRIP') return ICON_SCOOTER;
    if (r.dutyState === 'OFF_DUTY') return '<span>' + F.initials(r.name) + '</span>';
    return ICON_PERSON;
  }

  // A live runner's pin carries a slow halo so the eye finds movement on a busy map.
  function pinHalo(r) {
    if (r.signalLost || r.dutyState === 'OFF_DUTY') return '';
    return '<i class="pin__halo"></i>';
  }

  function paintMarkers() {
    const seen = {};
    runners.forEach(r => {
      if (!r.lastLocation || !r.lastLocation.lat) return;
      seen[r.id] = true;
      const pos = [r.lastLocation.lat, r.lastLocation.lng];
      const icon = L.divIcon({
        className: '',
        html: '<div class="pin-wrap">' + pinHalo(r) +
              '<div class="pin ' + pinClass(r) + '">' + pinGlyph(r) + '</div></div>',
        iconSize: [44, 44], iconAnchor: [22, 40]
      });
      const far = r.targetKm !== null && r.targetKm !== undefined
        ? '<br>' + r.targetKm + ' km from ' + F.esc(r.targetName || 'the stop') + ' (~' + r.targetEtaMin + ' min)'
        : '';
      const tip = '<b>' + F.esc(r.name) + '</b><br>' +
        (r.trip ? 'Trip ' + r.trip.tripNo : F.stageLabel('', r.dutyState)) + far +
        '<br>' + r.tripsToday + ' job' + (r.tripsToday === 1 ? '' : 's') + ' today' +
        '<br>Last ping ' + F.ago(r.lastLocation.at);

      if (markers[r.id]) {
        markers[r.id].setLatLng(pos).setIcon(icon).setTooltipContent(tip);
      } else {
        markers[r.id] = L.marker(pos, { icon }).bindTooltip(tip).addTo(runnerLayer);
        markers[r.id].on('click', () => { if (r.trip) selectTrip(r.trip._id); else map.setView(pos, 15); });
      }
    });
    Object.keys(markers).forEach(id => {
      if (!seen[id]) { runnerLayer.removeLayer(markers[id]); delete markers[id]; }
    });
  }

  async function drawRoute(tripId) {
    try {
      const trip = trips.find(t => String(t._id) === String(tripId)) || await API.get('/api/trips/' + tripId);
      const pings = await API.get('/api/trips/' + tripId + '/route');
      routeLayer.clearLayers();

      const path = pings.filter(p => p.lat).map(p => [p.lat, p.lng]);
      if (path.length > 1) {
        L.polyline(path, { color: '#1F5FD9', weight: 4, opacity: .85 }).addTo(routeLayer);
      }

      const heading = ['ACCEPTED', 'EN_ROUTE_PICKUP', 'AT_PICKUP', 'PICKED'].includes(trip.status)
        ? trip.pickupLocation : trip.dropLocation;
      if (heading && path.length) {
        L.polyline([path[path.length - 1], [heading.lat, heading.lng]],
          { color: '#C8102E', weight: 3, dashArray: '6 7', opacity: .9 }).addTo(routeLayer);
      }
      if (heading) {
        L.circle([heading.lat, heading.lng], { radius: heading.geofence || 200, color: '#C8102E', weight: 1, fillOpacity: .06 }).addTo(routeLayer);
      }

      const bounds = [];
      if (path.length) bounds.push(...path);
      if (heading) bounds.push([heading.lat, heading.lng]);
      if (bounds.length > 1) map.fitBounds(L.latLngBounds(bounds).pad(0.25));
      else if (bounds.length === 1) map.setView(bounds[0], 15);
    } catch (e) { /* ignore */ }
  }

  function selectTrip(tripId) {
    followTripId = tripId;
    drawRoute(tripId);
    openTrip(tripId);
  }

  function jobCard(t) {
    const g = t.tat && t.tat.worst;
    const cls = g === 'breach' ? 'is-breach' : g === 'warn' ? 'is-warn' : 'is-ok';
    const heading = ['ACCEPTED', 'EN_ROUTE_PICKUP', 'AT_PICKUP', 'PICKED'].includes(t.status) ? t.pickupLocation : t.dropLocation;
    const waiting = t.status === 'ASSIGNED';

    return '<article class="job ' + cls + '" data-trip="' + t._id + '">' +
      '<div class="job__top"><span class="job__name">' + F.esc(t.case ? t.case.patientName : 'Case') + '</span>' +
      '<span class="job__no mono">' + F.esc(t.tripNo) + '</span>' +
      (t.case ? UI.priorityChip(t.case.priority) : '') + '</div>' +
      '<div class="job__line">' + (t.type === 'SAMPLE_PICKUP' ? 'Sample pickup' : 'Blood delivery') +
      ' &middot; ' + F.esc(heading ? heading.name : '') + '</div>' +
      '<div class="job__line">' + F.esc(t.runner ? t.runner.name : 'Unassigned') +
      (t.runner && t.runner.phone ? ' &middot; ' + F.esc(t.runner.phone) : '') + '</div>' +
      '<div class="job__foot">' +
      UI.clockChip(t.tat.parts.total.value, t.tat.parts.total.grade, 'running') +
      '<span class="chip ' + (waiting ? 'chip--amber' : 'chip--blue') + '">' + F.stageLabel(t.type, t.status) + '</span>' +
      '</div></article>';
  }

  function runnerRow(r) {
    const dot = r.signalLost ? 'dot--amber' : r.dutyState === 'ON_TRIP' ? 'dot--blue'
      : r.dutyState === 'AVAILABLE' ? 'dot--green' : r.dutyState === 'BREAK' ? 'dot--amber' : 'dot--grey';

    // Only a phone that is actually reporting gets the breathing ring. That is the whole
    // point - "is he online right now" was impossible to tell from a static grey dot.
    const alive = !r.signalLost && r.dutyState !== 'OFF_DUTY' ? ' dot--live' : '';

    const line = r.trip
      ? 'Trip ' + r.trip.tripNo + ' &middot; ' + F.stageLabel(r.trip.type, r.trip.status)
      : (r.dutyState === 'AVAILABLE' ? 'Free, waiting for a job' : r.dutyState === 'BREAK' ? 'On break' : 'Not punched in');

    // Distance still to ride, when he is on a job and has pinged at least once.
    const far = (r.targetKm !== null && r.targetKm !== undefined)
      ? '<div class="runner-row__far">' + r.targetKm + ' km to ' + F.esc(r.targetName || 'the stop') +
        ' <span>~' + r.targetEtaMin + ' min</span></div>'
      : '';

    // Workload at a glance, so the desk assigns the next job to whoever has done least.
    const load = '<span class="load" title="Jobs done today">' + r.tripsToday + '</span>';
    // A phone reporting a VPN or a fake-GPS app gets a visible mark. It does not block
    // anything - it just means the desk can see it and ask.
    const flag = r.flagged ? ' <span class="chip chip--red" title="' + F.esc(flagText(r)) + '">!</span>' : '';

    return '<div class="runner-row" data-runner="' + r.id + '" ' + (r.trip ? 'data-trip="' + r.trip._id + '"' : '') + '>' +
      '<div class="runner-row__av' + (r.dutyState === 'ON_TRIP' ? ' runner-row__av--riding' : '') + '">' +
      (r.dutyState === 'OFF_DUTY' ? F.initials(r.name) : pinGlyph(r)) + '</div>' +
      '<div class="runner-row__meta"><b>' + F.esc(r.name) + flag + '</b><span>' + line + '</span>' + far + '</div>' +
      '<div class="runner-row__right">' + load +
      '<span class="dot ' + dot + alive + '"></span>' +
      '<div class="runner-row__ago">' + (r.lastSeenAt ? F.ago(r.lastSeenAt) : 'no ping') + '</div></div></div>';
  }

  function flagText(r) {
    if (!r.integrity) return '';
    const on = [];
    if (r.integrity.vpn) on.push('VPN is on');
    if (r.integrity.mockLocation) on.push('fake GPS app detected');
    if (r.integrity.rooted) on.push('phone is rooted');
    return on.join(', ');
  }

  function paintDock() {
    const host = document.getElementById('dockBody');
    if (!host) return;

    if (dockTab === 'jobs') {
      if (!trips.length) {
        host.innerHTML = UI.empty('No job is running', 'Create a case and assign a runner to start the clock.');
        return;
      }
      const rank = { breach: 0, warn: 1, ok: 2, na: 3 };
      const sorted = trips.slice().sort((a, b) => (rank[a.tat.worst] - rank[b.tat.worst]) || (new Date(a.assignedAt) - new Date(b.assignedAt)));
      host.innerHTML = sorted.map(jobCard).join('');
      host.querySelectorAll('.job').forEach(el => el.addEventListener('click', () => selectTrip(el.dataset.trip)));
    } else {
      if (!runners.length) { host.innerHTML = UI.empty('No runners added yet', 'Add staff from the Runners page.'); return; }
      const order = { ON_TRIP: 0, AVAILABLE: 1, BREAK: 2, OFF_DUTY: 3 };
      host.innerHTML = runners.slice().sort((a, b) => order[a.dutyState] - order[b.dutyState]).map(runnerRow).join('');
      host.querySelectorAll('.runner-row').forEach(el => el.addEventListener('click', () => {
        if (el.dataset.trip) selectTrip(el.dataset.trip);
        else {
          const r = runners.find(x => String(x.id) === el.dataset.runner);
          if (r && r.lastLocation && r.lastLocation.lat) map.setView([r.lastLocation.lat, r.lastLocation.lng], 15);
          else toast(r.name + ' has no location yet', 'error');
        }
      }));
    }
  }

  const STAGE_ORDER = ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE_PICKUP', 'AT_PICKUP', 'PICKED', 'EN_ROUTE_DROP', 'AT_DROP', 'COMPLETED'];

  async function openTrip(tripId) {
    const t = await API.get('/api/trips/' + tripId);
    const done = new Set((t.events || []).map(e => e.status));
    const live = !['COMPLETED', 'REJECTED', 'CANCELLED'].includes(t.status);

    const timeline = STAGE_ORDER.map(s => {
      const ev = (t.events || []).slice().reverse().find(e => e.status === s);
      const cls = t.status === s ? 'is-now' : done.has(s) ? 'is-done' : '';
      return '<li class="' + cls + '"><b>' + F.stageLabel(t.type, s) + '</b><span>' +
        (ev ? F.dateTime(ev.at) + (ev.distanceToTargetM !== null && ev.distanceToTargetM !== undefined ? ' &middot; ' + ev.distanceToTargetM + ' m from target' : '') +
          (ev.by ? ' &middot; ' + F.esc(ev.by) : '') : 'pending') + '</span></li>';
    }).join('');

    const p = t.tat.parts;
    const tatGrid = [
      ['Accept', p.accept], ['To pickup', p.toPickup], ['At pickup', p.pickupDwell],
      ['To drop', p.toDrop], ['At drop', p.dropDwell], ['Total', p.total]
    ].map(([label, part]) =>
      '<div style="padding:8px 0"><div style="font-size:12px;color:var(--muted)">' + label + '</div>' +
      UI.clockChip(part.value, part.grade, 'target ' + part.target + 'm') + '</div>').join('');

    const body =
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">' +
      '<span class="chip chip--ink mono">' + F.esc(t.tripNo) + '</span>' +
      '<span class="chip chip--blue">' + (t.type === 'SAMPLE_PICKUP' ? 'Sample pickup' : 'Blood delivery') + '</span>' +
      (t.case ? UI.priorityChip(t.case.priority) : '') +
      '<span class="chip">' + F.stageLabel(t.type, t.status) + '</span></div>' +

      '<div class="card" style="margin-bottom:14px"><div class="card__body">' +
      '<h3 style="font-size:15px;margin-bottom:6px">' + F.esc(t.case ? t.case.patientName : '') + '</h3>' +
      '<div style="color:var(--muted)">' + F.esc([t.case && t.case.patientAge, t.case && t.case.patientGender, t.case && t.case.bloodGroup, t.case && t.case.component].filter(Boolean).join(' &middot; ')) + '</div>' +
      (t.case && t.case.wardBed ? '<div style="color:var(--muted)">Ward / bed: ' + F.esc(t.case.wardBed) + '</div>' : '') +
      (t.case && t.case.attendantPhone ? '<div style="color:var(--muted)">Attendant: ' + F.esc(t.case.attendantName || '') + ' ' + F.esc(t.case.attendantPhone) + '</div>' : '') +
      '</div></div>' +

      '<div class="grid-2" style="margin-bottom:14px">' +
      '<div><div style="font-size:12px;color:var(--muted)">Pick up from</div><b>' + F.esc(t.pickupLocation.name) + '</b><div style="color:var(--muted)">' + F.esc(t.pickupLocation.area || '') + '</div></div>' +
      '<div><div style="font-size:12px;color:var(--muted)">Drop at</div><b>' + F.esc(t.dropLocation.name) + '</b><div style="color:var(--muted)">' + F.esc(t.dropLocation.area || '') + '</div></div>' +
      '</div>' +

      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
      '<div class="runner-row__av">' + F.initials(t.runner && t.runner.name) + '</div>' +
      '<div><b>' + F.esc(t.runner ? t.runner.name : 'Unassigned') + '</b>' +
      '<div style="color:var(--muted);font-size:12px">' + F.esc(t.runner && t.runner.phone || '') + ' ' + F.esc(t.runner && t.runner.vehicleNo || '') + '</div></div></div>' +

      '<h4 style="margin:16px 0 4px">Time taken</h4>' +
      '<div class="grid-3">' + tatGrid + '</div>' +

      (t.proofPhoto
        ? '<h4 style="margin:16px 0 8px">Handover proof</h4>' +
          '<img src="' + F.esc(t.proofPhoto) + '" class="proof-shot" ' +
          'onclick="UI.photo(\'' + F.esc(t.proofPhoto) + '\', \'Handover proof\')" ' +
          'onerror="this.outerHTML = \'<p class=&quot;proof-gone&quot;>This photo is no longer on the server.</p>\'">'
        : '') +
      (t.sampleBarcode ? '<p style="margin-top:12px">Sample barcode: <span class="mono">' + F.esc(t.sampleBarcode) + '</span></p>' : '') +
      (t.runnerNote ? '<p style="margin-top:8px;color:var(--muted)">Runner note: ' + F.esc(t.runnerNote) + '</p>' : '') +

      '<h4 style="margin:18px 0 10px">Stage by stage</h4><ul class="tl">' + timeline + '</ul>';

    const foot = live
      ? (t.status === 'ASSIGNED' ? '<button class="btn btn--ghost" id="repingBtn">Ring the phone again</button>' : '') +
        '<button class="btn btn--ghost" id="reassignBtn">Hand to another runner</button>' +
        '<button class="btn btn--red" id="cancelTripBtn">Cancel trip</button>'
      : '<button class="btn btn--ghost" id="replayBtn">Show route on map</button>';

    UI.openDrawer('Trip ' + t.tripNo, body, foot);

    const reping = document.getElementById('repingBtn');
    if (reping) reping.addEventListener('click', async () => {
      try { await API.post('/api/trips/' + t._id + '/reping'); toast('The runner phone will ring again', 'ok'); }
      catch (e) { toast(e.message, 'error'); }
    });

    const reassign = document.getElementById('reassignBtn');
    if (reassign) reassign.addEventListener('click', () => Cases.pickRunner(async runnerId => {
      try {
        await API.post('/api/trips/' + t._id + '/reassign', { runnerId });
        toast('Job handed over', 'ok');
        UI.closeDrawer();
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    }));

    const cancel = document.getElementById('cancelTripBtn');
    if (cancel) cancel.addEventListener('click', async () => {
      const reason = prompt('Why is this trip being cancelled?');
      if (reason === null) return;
      try {
        await API.post('/api/trips/' + t._id + '/cancel', { reason });
        toast('Trip cancelled', 'ok');
        UI.closeDrawer();
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    });

    const replay = document.getElementById('replayBtn');
    if (replay) replay.addEventListener('click', () => { UI.closeDrawer(); Main.go('live'); drawRoute(t._id); });
  }

  return { boot, refresh, openTrip, selectTrip, runnersCache: () => runners };
})();
