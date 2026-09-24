/*
 * Runner Dashboard - one runner, one day.
 *
 * Every other screen is organised around a thing: the live board around the map, the route
 * log around jobs, the day sheet around punches. This one is organised around a person. Pick
 * a runner and a date and the whole day is on one screen - what he was given, where he went,
 * where he is now, what he photographed, what he wrote.
 *
 * One request fills the whole page (/api/runner-board/:id). Six calls would only give the
 * cards six chances to disagree with each other while they filled in.
 */
const RunnerBoard = (function () {
  let booted = false;
  let map = null;
  let pinLayer = null;
  let trailLine = null;
  let riderMark = null;
  let data = null;
  let tab = 'all';
  let picked = null;          // which stop the Connection Details card is showing
  let refreshTimer = null;

  const el = id => document.getElementById(id);

  /* ---------------- icons ----------------
     Inline so the page draws complete on the first paint with nothing to fetch. */
  const I = {
    pin: '<path d="M12 21s7-6.3 7-11a7 7 0 10-14 0c0 4.7 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    route: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H14a4 4 0 010 8H10a4 4 0 000 8h5.5"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0115 0"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 19a6 6 0 0112 0"/><path d="M16 5.5a3 3 0 010 5.5M17 19a6 6 0 00-2-4.3"/>',
    building: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2"/>',
    note: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    send: '<path d="M21 3L3 10.5l7 3 3 7z"/><path d="M21 3l-11 11"/>',
    bike: '<circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M6 17l4-8h5l3 8M10 9h6"/>',
    inArrow: '<path d="M14 4h4a2 2 0 012 2v12a2 2 0 01-2 2h-4"/><path d="M3 12h11M10.5 8.5L14 12l-3.5 3.5"/>',
    outArrow: '<path d="M10 4H6a2 2 0 00-2 2v12a2 2 0 002 2h4"/><path d="M21 12H10M17.5 8.5L21 12l-3.5 3.5"/>'
  };
  const svg = (d, w) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
    (w || 1.8) + '" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';

  /* ---------------- boot ---------------- */
  async function boot() {
    if (!booted) {
      booted = true;
      el('rbDate').value = F.today();
      el('rbDate').addEventListener('change', () => { picked = null; load(); });
      el('rbRunner').addEventListener('change', () => { picked = null; load(); });
      el('rbFull').addEventListener('click', fullScreen);

      document.querySelectorAll('#rbTabs .rb-tab').forEach(b =>
        b.addEventListener('click', () => {
          tab = b.dataset.tab;
          document.querySelectorAll('#rbTabs .rb-tab').forEach(x => x.classList.toggle('is-on', x === b));
          paintTimeline();
        }));

      await fillRoster();
    }
    await load();
    watch();
  }

  async function fillRoster() {
    const r = await API.get('/api/runner-board/roster', { date: el('rbDate').value });
    const sel = el('rbRunner');
    const keep = sel.value;
    sel.innerHTML = r.runners.map(x =>
      '<option value="' + x.id + '">' + F.esc(x.name) +
      (x.empCode ? '  (' + F.esc(x.empCode) + ')' : '') +
      (x.active ? '' : '  - switched off') + '</option>').join('');
    if (keep && r.runners.some(x => String(x.id) === keep)) sel.value = keep;
  }

  /**
   * Today's page keeps itself current; an older date is finished history and is left alone.
   * The timer is cleared whenever the reader leaves, so a forgotten tab is not still polling
   * the server tomorrow morning.
   */
  function watch() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      const visible = !document.querySelector('.page[data-page="runnerboard"]').hidden;
      if (!visible) { clearInterval(refreshTimer); return; }
      if (data && data.today) load(true);
    }, 30000);
  }

  async function load(quiet) {
    const id = el('rbRunner').value;
    if (!id) { el('rbEmpty').hidden = false; return; }
    el('rbEmpty').hidden = true;

    data = await API.get('/api/runner-board/' + id, { date: el('rbDate').value });

    paintWho();
    paintStats();
    paintMap(quiet);
    paintTimeline();
    paintSummary();
    paintRoute();

    // Keep whatever the reader was looking at across a background refresh; otherwise open on
    // the thing that needs attention - the first place he has not reached yet.
    const still = picked && data.stops.find(s => s.n === picked);
    paintConn(still || data.stops.find(s => s.status !== 'VISITED') || data.stops[data.stops.length - 1] || null);
    paintNote();
  }

  /* ---------------- header ---------------- */
  function paintWho() {
    const r = data.runner;
    el('rbWhoPic').innerHTML = r.photo
      ? '<img class="rb-who__pic" src="' + F.esc(r.photo) + '" alt="">'
      : '<div class="rb-who__pic">' + F.esc(F.initials(r.name)) + '</div>';
    el('rbWhoName').textContent = r.name;
    el('rbWhoMeta').innerHTML =
      'Runner ID: <b>' + F.esc(r.empCode || '-') + '</b>' +
      '&nbsp;&nbsp;&middot;&nbsp;&nbsp;Mobile: <b>' + F.esc(r.phone || '-') + '</b>' +
      (r.vehicleNo ? '&nbsp;&nbsp;&middot;&nbsp;&nbsp;Vehicle: <b>' + F.esc(r.vehicleNo) + '</b>' : '');
  }

  /* ---------------- the four counters ---------------- */
  function paintStats() {
    const c = data.counters;
    const shift = data.runner.shiftWord ? 'Assigned (' + data.runner.shiftWord + ')' : 'Places to visit';

    el('rbStats').innerHTML =
      stat('all', I.pin, 'Total Connections', c.total, shift) +
      stat('done', I.check, 'Completed', c.completed, 'Reached & Completed') +
      stat('open' + (c.pending ? '' : ' is-clear'), I.clock, 'Pending', c.pending,
        c.pending ? 'Not Visited / In Progress' : 'Nothing left') +
      stat('dist', I.route, 'Total Distance', c.km + ' km',
        data.today ? 'Today' : F.date(data.date));
  }

  const stat = (kind, icon, label, value, sub) =>
    '<div class="rb-stat rb-stat--' + kind + '">' +
    '<div class="rb-stat__icon">' + svg(icon) + '</div>' +
    '<div class="rb-stat__text">' +
    '<div class="rb-stat__label">' + F.esc(label) + '</div>' +
    '<div class="rb-stat__value">' + F.esc(String(value)) + '</div>' +
    '<div class="rb-stat__sub">' + F.esc(sub) + '</div>' +
    '</div></div>';

  /* ---------------- map ---------------- */
  const PIN_CLASS = { VISITED: 'visited', IN_PROGRESS: 'live', PENDING: 'pending' };

  function paintMap(quiet) {
    if (typeof L === 'undefined') return;              // map library blocked or offline

    if (!map) {
      map = L.map('rbMap', { zoomControl: true, attributionControl: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
      pinLayer = L.layerGroup().addTo(map);
      map.setView([23.0225, 72.5714], 12);
    }
    pinLayer.clearLayers();
    if (trailLine) { map.removeLayer(trailLine); trailLine = null; }
    if (riderMark) { map.removeLayer(riderMark); riderMark = null; }

    if (data.trail.length > 1) {
      trailLine = L.polyline(data.trail, { color: '#2F4FCD', weight: 3.5, opacity: .85 }).addTo(map);
    }

    data.stops.forEach(s => {
      if (typeof s.lat !== 'number') return;
      L.marker([s.lat, s.lng], {
        icon: L.divIcon({
          className: '',
          html: '<div class="rb-pin rb-pin--' + PIN_CLASS[s.status] + '">' + s.n + '</div>',
          iconSize: [25, 25], iconAnchor: [12, 12]
        })
      }).addTo(pinLayer)
        .bindTooltip('<b>' + F.esc(s.name) + '</b><br>' + F.esc(s.did) +
          (s.reachedAt ? '<br>reached ' + F.time(s.reachedAt) : '<br>' + F.esc(s.why)))
        .on('click', () => paintConn(s));
    });

    if (data.live) {
      riderMark = L.marker([data.live.lat, data.live.lng], {
        icon: L.divIcon({
          className: '',
          html: '<div class="rb-rider">' + svg(I.bike, 2) + '</div>',
          iconSize: [34, 34], iconAnchor: [17, 17]
        }),
        zIndexOffset: 1000
      }).addTo(map);
    }

    paintHere();

    // Frame the day, not the city. Only on a fresh load - a background refresh must not yank
    // the map away from wherever the reader had panned it.
    if (!quiet) {
      const pts = data.trail.concat(
        data.stops.filter(s => typeof s.lat === 'number').map(s => [s.lat, s.lng]),
        data.live ? [[data.live.lat, data.live.lng]] : []
      );
      if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.18), { maxZoom: 15 });
    }
    setTimeout(() => map.invalidateSize(), 60);
  }

  /** The floating card over the map: who this is and when he was last heard from. */
  function paintHere() {
    const box = el('rbHere');
    if (!data.live) {
      box.innerHTML = '<div class="rb-here__row">' + svg(I.pin) +
        '<span>No location recorded on this day</span></div>';
      return;
    }
    const live = data.live;
    const on = live.live && live.onDuty;
    box.innerHTML =
      '<div class="rb-here__top"><b>' + F.esc(data.runner.name) + '</b>' +
      '<span class="chip ' + (on ? 'chip--green' : '') + '" style="margin-left:auto">' +
      (on ? 'On Duty' : (live.live ? 'Off duty' : 'Last seen')) + '</span></div>' +
      '<div class="rb-here__row">' + svg(I.pin) +
      '<span class="mono">Lat: ' + live.lat.toFixed(4) + ' &nbsp; Long: ' + live.lng.toFixed(4) + '</span></div>' +
      '<div class="rb-here__row">' + svg(I.clock) +
      '<span>' + (live.live ? 'Last Update: ' : 'Last ping: ') + F.time(live.at) + '</span></div>';
  }

  function fullScreen() {
    const card = el('rbMapCard');
    if (!document.fullscreenElement) {
      card.requestFullscreen().then(() => setTimeout(() => map && map.invalidateSize(), 120))
        .catch(() => toast('Your browser would not allow full screen here', 'bad'));
    } else {
      document.exitFullscreen();
    }
  }
  document.addEventListener('fullscreenchange', () => { if (map) setTimeout(() => map.invalidateSize(), 120); });

  /* ---------------- timeline ---------------- */
  function paintTimeline() {
    if (!data) return;
    const rows = data.timeline.filter(r =>
      tab === 'all' ? true :
      tab === 'punch' ? r.type !== 'VISIT' : r.type === 'VISIT');

    const host = el('rbTlRows');
    if (!rows.length) {
      host.innerHTML = '<tr><td colspan="6"><div class="rb-blank">' +
        (data.timeline.length ? 'Nothing of this kind on ' + F.date(data.date)
          : 'No punches or visits recorded on ' + F.date(data.date)) +
        '</div></td></tr>';
      return;
    }

    host.innerHTML = rows.map((r, i) =>
      '<tr>' +
      '<td class="rb-tl__n">' + (i + 1) + '</td>' +
      '<td><b>' + F.time(r.at) + '</b></td>' +
      '<td>' + typePill(r) + '</td>' +
      '<td class="rb-tl__place"><b>' + F.esc(r.place || 'Location not recorded') + '</b>' +
      (typeof r.lat === 'number'
        ? '<div class="rb-tl__gps">Lat: ' + r.lat.toFixed(4) + ', Lng: ' + r.lng.toFixed(4) + '</div>' : '') +
      '</td>' +
      '<td>' + (r.photo
        ? '<img class="rb-tl__shot" src="/uploads/' + F.esc(r.photo) + '" alt="photo" loading="lazy" ' +
          'data-shot="' + F.esc(r.photo) + '" data-cap="' + F.esc((r.label || '') + ' - ' + F.time(r.at)) + '">'
        : '<span class="rb-tl__noshot">-</span>') + '</td>' +
      '<td>' + statusPill(r) + '</td>' +
      '</tr>').join('');

    host.querySelectorAll('[data-shot]').forEach(img =>
      img.addEventListener('click', () => UI.photo('/uploads/' + img.dataset.shot, img.dataset.cap)));
  }

  function typePill(r) {
    if (r.type === 'PUNCH_IN')
      return '<span class="rb-pill rb-pill--in">' + svg(I.inArrow) + F.esc(r.label || 'Punch In') + '</span>';
    if (r.type === 'PUNCH_OUT')
      return '<span class="rb-pill rb-pill--out">' + svg(I.outArrow) + F.esc(r.label || 'Punch Out') + '</span>';
    return '<span class="rb-pill rb-pill--visit">' + svg(I.pin) + 'Connection Visit</span>';
  }

  function statusPill(r) {
    if (r.status === 'IN_PROGRESS')
      return '<span class="rb-pill rb-pill--running">' + svg(I.clock) + 'In Progress</span>';
    return '<span class="rb-pill rb-pill--done">' + svg(I.check) + 'Completed</span>';
  }

  /* ---------------- right column ---------------- */
  function paintSummary() {
    const r = data.runner, c = data.counters;
    const onDuty = data.today && r.dutyState !== 'OFF_DUTY';

    el('rbSum').innerHTML =
      '<div class="rb-sum">' +
      (r.photo ? '<img class="rb-sum__pic" src="' + F.esc(r.photo) + '" alt="">'
        : '<div class="rb-sum__pic">' + F.esc(F.initials(r.name)) + '</div>') +
      '<div><div class="rb-sum__name">' + F.esc(r.name) +
      '<span class="chip ' + (onDuty ? 'chip--green' : r.active ? '' : 'chip--red') + '">' +
      (onDuty ? 'Active' : r.active ? 'Off duty' : 'Switched off') + '</span></div>' +
      '<div class="rb-sum__line">Runner ID: ' + F.esc(r.empCode || '-') + '</div>' +
      '<div class="rb-sum__line">Mobile: ' + F.esc(r.phone || '-') + '</div>' +
      '</div></div>' +

      '<div class="rb-rows">' +
      row(I.clock, 'Shift', r.shift ? (r.shiftWord ? r.shiftWord + ' (' + r.shift + ')' : r.shift) : 'Not set') +
      row(I.users, 'Assigned Connections', c.total) +
      row(I.check, 'Completed', c.completed) +
      row(I.clock, 'Pending', c.pending) +
      row(I.route, 'Distance Covered', c.km + ' km') +
      row(I.bike, 'Hours on duty', F.mins(c.minutes)) +
      '</div>';
  }

  const row = (icon, label, value) =>
    '<div class="rb-row">' + svg(icon) + '<span>' + F.esc(label) + '</span><b>' + F.esc(String(value)) + '</b></div>';

  function paintRoute() {
    const r = data.route;
    if (!r.startAt && !r.lastAt) {
      el('rbRoute').innerHTML = '<div class="rb-blank">He did not punch in on this day</div>';
      return;
    }
    el('rbRoute').innerHTML = '<div class="rb-ends">' +
      end('', 'Start Location', r.startPlace, r.startAt) +
      end('last', r.stillOn ? 'Right Now' : 'Last Location', r.lastPlace, r.lastAt) +
      '</div>';
  }

  const end = (mod, what, where, when) =>
    '<div class="rb-end ' + (mod ? 'rb-end--' + mod : '') + '">' +
    '<div class="rb-end__dot">' + svg(I.pin) + '</div>' +
    '<div class="rb-end__text"><div class="rb-end__what">' + F.esc(what) + '</div>' +
    '<div class="rb-end__where">' + F.esc(where || 'Not recorded') + '</div></div>' +
    '<div class="rb-end__when">' + (when ? F.time(when) : '--') + '</div></div>';

  /** The place card. Clicking a pin or a row swaps what it shows. */
  function paintConn(s) {
    const host = el('rbConn');
    if (!s) {
      host.innerHTML = '<div class="rb-blank">No places were assigned on this day</div>';
      picked = null;
      return;
    }
    picked = s.n;

    const mod = s.status === 'VISITED' ? 'visited' : s.status === 'IN_PROGRESS' ? 'live' : 'pending';
    const word = s.status === 'VISITED' ? 'Completed' : s.status === 'IN_PROGRESS' ? 'In Progress' : 'Pending';

    host.className = 'rb-conn rb-conn--' + mod;
    host.innerHTML =
      '<div class="rb-conn__strip">' + svg(I.pin) + 'Connection #' + s.n +
      '<span class="spacer"></span><span>' + word + '</span></div>' +

      '<div class="rb-conn__name">' + F.esc(s.name) + '</div>' +
      '<div class="rb-conn__addr">' + svg(I.pin) +
      '<span>' + F.esc(s.address || s.area || 'Address not saved') + '</span></div>' +

      '<div class="rb-rows">' +
      row(I.clock, 'Assigned Time', F.time(s.assignedAt)) +
      row(I.check, 'Status', s.reachedAt ? 'Reached ' + F.time(s.reachedAt) : (s.why || 'Not visited')) +
      (s.minutes !== null ? row(I.clock, 'Time there', F.mins(s.minutes)) : '') +
      row(I.route, 'Job', (s.tripNo || '-') + (s.what ? ' - ' + s.what : '')) +
      row(I.note, 'Notes', s.note || (s.contactPerson || s.phone
        ? [s.contactPerson, s.phone].filter(Boolean).join(', ') : 'No note')) +
      '</div>' +

      '<a class="rb-maps" target="_blank" rel="noopener" ' +
      'href="https://www.google.com/maps/search/?api=1&query=' + s.lat + ',' + s.lng + '">' +
      svg(I.send) + 'Open in Maps</a>';
  }

  function paintNote() {
    const n = data.notes[0];
    el('rbNote').innerHTML = !n
      ? '<div class="rb-blank">He did not write a note on this day</div>'
      : '<div class="rb-note">' +
        (n.photo ? '<img class="rb-note__shot" src="/uploads/' + F.esc(n.photo) + '" alt="" ' +
          'data-note-shot="' + F.esc(n.photo) + '">' : '') +
        '<div><div class="rb-note__text">' + F.esc(n.text) + '</div>' +
        '<div class="rb-note__when">' + F.time(n.at) + ' &middot; ' + F.date(data.date) +
        (n.place ? ' &middot; ' + F.esc(n.place) : '') + '</div></div></div>';

    const img = el('rbNote').querySelector('[data-note-shot]');
    if (img) img.addEventListener('click', () => UI.photo('/uploads/' + img.dataset.noteShot, n.text));
  }

  /** The shell calls this when the map becomes visible again after being hidden. */
  function resize() { if (map) map.invalidateSize(); }

  return { boot, resize };
})();
