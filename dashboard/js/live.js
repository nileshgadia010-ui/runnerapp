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

    // Leaflet measures its container once, at creation, and then trusts that measurement
    // forever. Anything that changes the container afterwards - the page being switched to,
    // the window resized, the rail collapsing at a breakpoint - leaves it drawing tiles for
    // a box that no longer exists, which is how the map ends up spilling past its column.
    // invalidateSize() is the only way to tell it to look again.
    resize();
    window.addEventListener('resize', resize);
    setTimeout(resize, 300);   // after web fonts land and the shell settles

    loadPlaces();
    refresh();
    setInterval(refresh, 10000);
    setInterval(paintDock, 1000);   // keeps the running clocks ticking
  }

  /** Re-measures the map. Safe to call as often as we like; Leaflet no-ops if nothing moved. */
  function resize() {
    if (!map) return;
    try { map.invalidateSize({ animate: false }); } catch (e) { /* map not on screen yet */ }
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

  /*
   * A runner who is riding is drawn as an actual rider on the road, not as a dot with a
   * tiny glyph inside it. That is the whole difference between a board that looks like a
   * database and one that looks like the city: at a glance the desk sees a bike, which way
   * it is pointing, and that it is moving.
   *
   * Everyone else stays a circular pin. A stationary runner has no direction to show, and a
   * row of parked bikes on the map would just be noise.
   *
   * The artwork is deliberately simple - a dark machine and one coloured rider - because it
   * renders at about 46 pixels wide. Anything more detailed turns to mush at that size; this
   * was checked at the real size before it went in.
   */
  const RIDER_SVG =
    '<svg class="rider__art" viewBox="0 0 64 40" width="52" height="33" aria-hidden="true">' +
      '<ellipse cx="32" cy="36.4" rx="17" ry="1.6" fill="#101828" opacity=".18"/>' +
      // wheels
      '<circle cx="15.5" cy="28" r="7.4" fill="#101828"/>' +
      '<circle cx="15.5" cy="28" r="2.5" fill="#fff"/>' +
      '<circle cx="48.5" cy="28" r="7.4" fill="#101828"/>' +
      '<circle cx="48.5" cy="28" r="2.5" fill="#fff"/>' +
      // frame, tank, engine, pipe
      '<path d="M15.5 28 L24 21 L38 21 L48.5 28" fill="none" stroke="#101828" ' +
        'stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M29.5 20.5 q4.5 -3.2 9 -1.2 l0 1.7 z" fill="#101828"/>' +
      '<path d="M22.5 21 h8 l-1.5 -2.6 h-5.4 z" fill="#101828"/>' +
      '<rect x="26.5" y="23" width="9" height="6" rx="1.6" fill="#101828"/>' +
      '<rect x="12" y="30.4" width="16" height="2.4" rx="1.2" fill="#101828"/>' +
      // fork and bar
      '<path d="M43.5 20.5 L48 14.8" stroke="#101828" stroke-width="2.8" stroke-linecap="round"/>' +
      '<path d="M45.6 14.2 h6" stroke="#101828" stroke-width="2.8" stroke-linecap="round"/>' +
      // rider - the jacket takes the duty colour, so the pin still says what it always said
      '<path d="M28 19.5 L29.5 25 L33.5 28.6" fill="none" stroke="#3A4661" ' +
        'stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M31.8 28.6 h3.6" stroke="#101828" stroke-width="2.6" stroke-linecap="round"/>' +
      '<path d="M28.2 19.4 q0.8 -5.2 5.8 -7.6 q2.9 -1.4 5.4 -0.6 l-1.5 4.3 ' +
        'q-2.7 -0.5 -4.5 1.3 q-1.7 1.7 -1.9 3.7 z" fill="currentColor"/>' +
      '<path d="M38 13.8 L45.6 14.2" fill="none" stroke="currentColor" ' +
        'stroke-width="2.5" stroke-linecap="round"/>' +
      '<circle cx="39.8" cy="9" r="4.5" fill="currentColor"/>' +
      '<path d="M39.8 4.5 a4.5 4.5 0 0 1 3.7 7.1 l-3.7 -2.6 z" fill="#000" opacity=".22"/>' +
      '<path d="M42.5 7.4 a4.2 4.2 0 0 1 1.4 2.3 l-3.5 0 z" fill="#fff" opacity=".85"/>' +
    '</svg>';

  const ICON_PERSON =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="7.5" r="3.2"/><path d="M5.5 20.5a6.5 6.5 0 0 1 13 0"/></svg>';

  // A line-drawn bike for the side list, where the avatar is 34px and the full illustration
  // would be unreadable. The map gets the detailed rider; the list gets the shorthand.
  const ICON_BIKE =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="5.5" cy="17.5" r="3"/><circle cx="18.5" cy="17.5" r="3"/>' +
    '<path d="M5.5 17.5h8l3-9h2"/><path d="M13 8.5h3"/></svg>';

  function pinGlyph(r) {
    if (r.dutyState === 'OFF_DUTY') return '<span>' + F.initials(r.name) + '</span>';
    if (r.dutyState === 'ON_TRIP') return ICON_BIKE;
    return ICON_PERSON;
  }

  /** A riding runner gets the bike; everyone else gets a pin. */
  function isRiding(r) {
    return r.dutyState === 'ON_TRIP';
  }

  /*
   * Which way the bike faces.
   *
   * The artwork is a side view, so it cannot be spun through 360 degrees the way a top-down
   * arrow can - a bike rotated to point north just looks like it has fallen over. Instead it
   * is mirrored for westward travel and tilted a few degrees for the climb or descent, which
   * is enough for the eye to read direction without the drawing ever looking wrong.
   */
  const headings = {};

  function updateHeading(id, lat, lng) {
    const prev = headings[id];
    if (!prev) {
      headings[id] = { lat: lat, lng: lng, west: false, tilt: 0 };
      return headings[id];
    }

    const dLat = lat - prev.lat;
    const dLng = lng - prev.lng;

    // Ignore GPS jitter. A parked bike still reports a metre of drift every few seconds,
    // and without this floor it would spin back and forth on the spot.
    const JITTER = 0.00012;   // roughly 13 metres
    if (Math.abs(dLng) > JITTER || Math.abs(dLat) > JITTER) {
      if (Math.abs(dLng) > JITTER) prev.west = dLng < 0;
      const slope = Math.abs(dLng) > 1e-9 ? dLat / Math.abs(dLng) : 0;
      prev.tilt = Math.max(-12, Math.min(12, -slope * 14));
    }
    prev.lat = lat;
    prev.lng = lng;
    return prev;
  }

  function riderHtml(r) {
    const h = updateHeading(r.id, r.lastLocation.lat, r.lastLocation.lng);
    const flip = h && h.west ? ' is-west' : '';
    const tilt = h ? h.tilt : 0;
    return '<div class="rider ' + riderTone(r) + flip + '" style="--tilt:' + tilt.toFixed(1) + 'deg">' +
           RIDER_SVG + '</div>';
  }

  // The jacket keeps the same colour language the pins always used.
  function riderTone(r) {
    if (r.signalLost) return 'rider--lost';
    return 'rider--trip';
  }

  function paintMarkers() {
    const seen = {};
    runners.forEach(r => {
      if (!r.lastLocation || !r.lastLocation.lat) return;
      seen[r.id] = true;
      const pos = [r.lastLocation.lat, r.lastLocation.lng];
      // A riding runner is the bike itself, anchored at the road under its wheels. Everyone
      // else is a pin, anchored at its point. The two need different sizes and anchors, so
      // the marker is built from whichever shape applies.
      const riding = isRiding(r);
      const html = riding
        ? riderHtml(r)
        : '<div class="pin-wrap">' + pinHalo(r) + '<div class="pin ' + pinClass(r) + '">' + pinGlyph(r) + '</div></div>';
      const icon = riding
        ? L.divIcon({ className: '', html, iconSize: [52, 33], iconAnchor: [26, 30] })
        : L.divIcon({ className: '', html, iconSize: [44, 44], iconAnchor: [22, 40] });
      const far = r.targetKm !== null && r.targetKm !== undefined
        ? '<br>' + r.targetKm + ' km from ' + F.esc(r.targetName || 'the stop') + ' (~' + r.targetEtaMin + ' min)'
        : '';
      const tip = '<b>' + F.esc(r.name) + '</b><br>' +
        (r.trip ? 'Trip ' + r.trip.tripNo : F.stageLabel('', r.dutyState)) +
        (r.waiting ? ' (+' + r.waiting + ' waiting)' : '') + far +
        '<br>' + r.tripsToday + ' job' + (r.tripsToday === 1 ? '' : 's') + ' today' +
        '<br>Last ping ' + F.ago(r.lastLocation.at);

      const m = markers[r.id];
      if (m) {
        // Only swap the icon when it has genuinely changed.
        //
        // This is what was stopping the pins from moving. setIcon() throws away the marker's
        // DOM element and builds a new one, so the CSS transition that slides a pin from its
        // old position to its new one never had an element to run on - every update looked
        // like a teleport, and on a slow refresh like nothing at all. Leaflet moves a marker
        // with a CSS transform, so leaving the element alone lets it glide.
        if (m._iconHtml !== html) { m.setIcon(icon); m._iconHtml = html; }
        m.setLatLng(pos).setTooltipContent(tip);
        if (m._icon) m._icon.classList.add('pin-moving');
      } else {
        markers[r.id] = L.marker(pos, { icon }).bindTooltip(tip).addTo(runnerLayer);
        markers[r.id]._iconHtml = html;
        markers[r.id].on('click', () => { if (r.trip) selectTrip(r.trip._id); else map.setView(pos, 15); });
        // The transition is added a beat after the pin is placed, so a new marker appears
        // where it belongs instead of flying in from the corner of the map.
        const el = markers[r.id]._icon;
        if (el) setTimeout(() => el.classList.add('pin-moving'), 60);
      }
    });
    Object.keys(markers).forEach(id => {
      if (!seen[id]) { runnerLayer.removeLayer(markers[id]); delete markers[id]; }
    });
  }

  /**
   * Moves one runner the instant the server hears from his phone.
   *
   * The board used to wait for its ten-second poll before a pin could move, so a rider
   * crossing town appeared to sit still and then jump. The server already pushes every
   * location it receives; this takes that push straight to the marker, which is what makes
   * the map read as live. The periodic refresh still runs underneath for everything else -
   * duty state, job counts, the trail.
   */
  function moveRunner(d) {
    if (!d || !d.runnerId || !d.lat) return;

    const r = runners.find(x => String(x.id) === String(d.runnerId));
    if (r) {
      r.lastLocation = Object.assign({}, r.lastLocation, {
        lat: d.lat, lng: d.lng, accuracy: d.accuracy, speed: d.speed, at: d.at || new Date().toISOString()
      });
      r.lastSeenAt = d.at || new Date().toISOString();
      r.signalLost = false;
    }

    const m = markers[d.runnerId];
    if (m) {
      m.setLatLng([d.lat, d.lng]);
      if (m._icon) m._icon.classList.add('pin-moving');

      // Turn the bike to face the way it just went. Done here rather than waiting for the
      // next full refresh, because this push is the only thing that knows a move happened
      // the instant it happened - which is what makes the board feel live.
      if (r && isRiding(r)) {
        const h = updateHeading(d.runnerId, d.lat, d.lng);
        const art = m._icon && m._icon.querySelector('.rider');
        if (art) {
          art.classList.toggle('is-west', !!h.west);
          art.style.setProperty('--tilt', h.tilt.toFixed(1) + 'deg');
        }
      }
    } else {
      // A pin we have not drawn yet - let the next refresh create it properly.
      paintMarkers();
    }

    // When a trip is open on screen, redraw its trail so the line keeps up with the pin.
    // Cheap enough at ping rate, and it keeps the route honest rather than trailing behind.
    if (followTripId && r && r.trip && String(r.trip._id) === String(followTripId)) {
      drawRoute(followTripId);
    }
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
      '<div class="job__line">' + F.jobTitle(t.type) +
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

    // A runner can be holding more than one job now, so say so - "on a job" alone would hide
    // the fact that two more are already stacked behind it.
    const waiting = r.waiting ? ' &middot; ' + r.waiting + ' waiting' : '';
    const line = r.trip
      ? 'Trip ' + r.trip.tripNo + ' &middot; ' + F.stageLabel(r.trip.type, r.trip.status) + waiting
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
      host.querySelectorAll('.runner-row').forEach(el => el.addEventListener('click', () =>
        openRunner(el.dataset.runner)));
    }
  }

  /*
   * Everything the desk asks about one runner, on one screen.
   *
   * Clicking a name used to just slide the map over, which answered "is there a dot" and
   * nothing else. The questions that actually get asked are where he is, where he punched in
   * from, and how the day is going - all of which the system already knew and none of which
   * it showed. Locations are named against the office's own places, because "1.2 km from
   * Sterling Hospital" is something a coordinator can act on and a pair of coordinates is not.
   */
  async function openRunner(runnerId) {
    let d;
    try { d = await API.get('/api/users/' + runnerId + '/where'); }
    catch (e) { return toast(e.message, 'error'); }

    const r = d.runner;
    const where = p => {
      if (!p) return '<span style="color:var(--muted)">not known</span>';
      if (!p.nearest) return '<span style="color:var(--muted)">away from every saved place</span>';
      return p.nearest.at
        ? '<b>At ' + F.esc(p.nearest.name) + '</b>'
        : '<b>' + p.nearest.km + ' km from ' + F.esc(p.nearest.name) + '</b>' +
          (p.nearest.area ? '<span style="color:var(--muted)"> &middot; ' + F.esc(p.nearest.area) + '</span>' : '');
    };
    const coords = p => p ? '<div class="mono" style="font-size:11px;color:var(--muted);margin-top:2px">' +
      p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) +
      ' &middot; <a href="https://www.google.com/maps?q=' + p.lat + ',' + p.lng + '" target="_blank">open in maps</a></div>' : '';

    const body =
      '<div class="where">' +

      '<div class="where__row">' +
        '<div class="where__dot where__dot--now"></div>' +
        '<div class="where__body">' +
          '<div class="where__label">Right now</div>' +
          where(d.now) + coords(d.now) +
          (d.now ? '<div class="where__meta">Last ping ' + F.ago(d.now.at) +
            (r.signalLost ? ' <span class="chip chip--amber">signal lost</span>' : '') +
            (d.now.battery ? ' &middot; battery ' + d.now.battery + '%' : '') + '</div>' : '') +
        '</div>' +
      '</div>' +

      '<div class="where__row">' +
        '<div class="where__dot where__dot--in"></div>' +
        '<div class="where__body">' +
          '<div class="where__label">Punched in</div>' +
          where(d.punchIn) + coords(d.punchIn) +
          (d.punchIn ? '<div class="where__meta">' + F.time(d.punchIn.at) +
            (d.punchIn.odo ? ' &middot; meter ' + d.punchIn.odo + ' km' : '') +
            (d.punchIn.photo ? ' &middot; <a href="#" data-photo="' + d.punchIn.photo + '">meter photo</a>' : '') +
            '</div>' : '<div class="where__meta">Not punched in today</div>') +
        '</div>' +
      '</div>' +

      (d.punchOut ? '<div class="where__row">' +
        '<div class="where__dot where__dot--out"></div>' +
        '<div class="where__body">' +
          '<div class="where__label">Punched out</div>' +
          where(d.punchOut) + coords(d.punchOut) +
          '<div class="where__meta">' + F.time(d.punchOut.at) +
            (d.punchOut.odo ? ' &middot; meter ' + d.punchOut.odo + ' km' : '') + '</div>' +
        '</div></div>' : '') +

      '</div>' +

      '<div class="grid-3" style="margin-top:18px">' +
        stat(F.mins(d.today.minutes), 'On duty today') +
        stat(d.today.km + ' km', 'Travelled today') +
        stat(d.today.trips, 'Jobs finished') +
      '</div>' +

      (r.phone ? '<p style="margin-top:16px">' + F.esc(r.vehicleNo || '') +
        (r.vehicleNo ? ' &middot; ' : '') +
        '<a href="tel:' + F.esc(r.phone) + '">' + F.esc(r.phone) + '</a></p>' : '');

    UI.openDrawer(r.name, body,
      '<button class="btn btn--ghost" onclick="UI.closeDrawer()">Close</button>' +
      '<button class="btn btn--red" id="whereShow">Show on the map</button>');

    document.querySelectorAll('[data-photo]').forEach(a =>
      a.addEventListener('click', e => { e.preventDefault(); UI.photo(a.dataset.photo, r.name + ' - meter'); }));

    const show = document.getElementById('whereShow');
    if (show) show.addEventListener('click', () => { UI.closeDrawer(); drawRunnerDay(d); });

    // Draw it straight away too, so the map matches what the card is describing.
    drawRunnerDay(d);
  }

  function stat(value, label) {
    return '<div><b class="mono" style="font-size:19px;display:block">' + value + '</b>' +
           '<span style="font-size:12px;color:var(--muted)">' + label + '</span></div>';
  }

  /*
   * Puts one runner's day on the map: where he started, where he has been, where he is.
   * Reuses the route layer, so opening a runner and opening a trip never fight over it.
   */
  function drawRunnerDay(d) {
    routeLayer.clearLayers();
    followTripId = null;
    const bounds = [];

    if (d.trail && d.trail.length > 1) {
      L.polyline(d.trail, { color: '#1F5FD9', weight: 4, opacity: .8 }).addTo(routeLayer);
      bounds.push.apply(bounds, d.trail);
    }

    if (d.punchIn && d.punchIn.lat) {
      const p = [d.punchIn.lat, d.punchIn.lng];
      L.marker(p, { icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13],
        html: '<div class="flagpin flagpin--in" title="Punched in">IN</div>' }) }).addTo(routeLayer)
        .bindTooltip('Punched in ' + F.time(d.punchIn.at));
      bounds.push(p);
    }

    if (d.punchOut && d.punchOut.lat) {
      const p = [d.punchOut.lat, d.punchOut.lng];
      L.marker(p, { icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13],
        html: '<div class="flagpin flagpin--out" title="Punched out">OUT</div>' }) }).addTo(routeLayer)
        .bindTooltip('Punched out ' + F.time(d.punchOut.at));
      bounds.push(p);
    }

    if (d.now && d.now.lat) bounds.push([d.now.lat, d.now.lng]);

    if (bounds.length > 1) map.fitBounds(L.latLngBounds(bounds).pad(0.3));
    else if (bounds.length === 1) map.setView(bounds[0], 15);
    else toast('No location recorded for this runner yet', 'error');
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
      '<span class="chip chip--blue">' + F.jobTitle(t.type) + '</span>' +
      (t.case ? UI.priorityChip(t.case.priority) : '') +
      '<span class="chip">' + F.stageLabel(t.type, t.status) + '</span></div>' +

      '<div class="card" style="margin-bottom:14px"><div class="card__body">' +
      '<h3 style="font-size:15px;margin-bottom:6px">' + F.esc(t.case ? t.case.patientName : '') + '</h3>' +
      // Same rule as everywhere else: escape the values, not the separator.
      '<div style="color:var(--muted)">' +
      [t.case && t.case.patientAge, t.case && t.case.patientGender,
       t.case && t.case.bloodGroup, t.case && t.case.component]
        .filter(Boolean).map(F.esc).join(' &middot; ') + '</div>' +
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

  return { boot, refresh, resize, moveRunner, openTrip, openRunner, selectTrip, runnersCache: () => runners };
})();
