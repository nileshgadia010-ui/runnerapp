/*
 * Day sheet - punch in to punch out, one row per runner per day.
 *
 * The question this answers is the one the office asks every evening: he punched in at nine
 * and punched out at six, so where did he actually go in between, and how far did that take
 * him. Attendance knew the punches, the jobs knew the counters, the GPS trail knew the
 * distance - none of them alone could answer it.
 *
 * Big numbers sit on top so the answer is readable across the room; the raw rows sit
 * underneath so it can be checked. The Excel download is the same shape, which is deliberate:
 * what is printed should look like what was on the screen.
 */
const DaySheet = (function () {
  let booted = false;
  let sheets = [];
  let totals = {};

  async function boot() {
    if (!booted) {
      booted = true;
      const from = document.getElementById('dsFrom');
      const to = document.getElementById('dsTo');
      // Opens on the last seven days, because one day rarely settles an argument.
      to.value = F.today();
      from.value = F.daysAgo(6);

      document.getElementById('dsApply').addEventListener('click', load);
      document.getElementById('dsExcel').addEventListener('click', function () {
        UI.download('/api/reports/movement.xlsx', params(), this);
      });
      document.getElementById('dsCsv').addEventListener('click', exportCsv);

      const staff = await API.get('/api/users', { role: 'runner', active: 'all' });
      document.getElementById('dsRunner').innerHTML = '<option value="">Every runner</option>' +
        staff.map(r => '<option value="' + r.id + '">' + F.esc(r.name) + '</option>').join('');
    }
    await load();
  }

  const params = () => ({
    from: document.getElementById('dsFrom').value,
    to: document.getElementById('dsTo').value,
    runner: document.getElementById('dsRunner').value
  });

  async function load() {
    const data = await API.get('/api/reports/movement', params());
    sheets = data.rows || [];
    totals = data.totals || {};

    document.getElementById('dsTiles').innerHTML = UI.tiles([
      { label: 'Runner days', value: totals.days },
      { label: 'Hours on duty', value: totals.hours },
      { label: 'Distance ridden', value: totals.km, note: 'kilometres from the GPS trail' },
      { label: 'Places visited', value: totals.stops, note: 'counters he stood at' },
      { label: 'Jobs finished', value: totals.jobs },
      { label: 'Avg km a day', value: totals.avgKm },
      { label: 'Still on duty', value: totals.stillOn, alert: totals.stillOn > 0 }
    ]);

    paint();
  }

  function paint() {
    const host = document.getElementById('dsRows');
    if (!sheets.length) {
      host.innerHTML = UI.emptyRow(11, 'Nobody punched in during this range');
      return;
    }

    host.innerHTML = sheets.map((s, i) => {
      // Meter against GPS: two independent measures of the same day. A few kilometres apart
      // is normal; far apart is the row worth asking about.
      const gap = s.odoKm && s.km ? Math.round((s.odoKm - s.km) * 10) / 10 : null;

      return '<tr class="ds-row" data-i="' + i + '">' +
        '<td>' + F.date(s.date) + '</td>' +
        '<td><b>' + F.esc(s.runner) + '</b>' +
          (s.vehicleNo ? '<div style="font-size:11px;color:var(--muted)">' + F.esc(s.vehicleNo) + '</div>' : '') + '</td>' +
        '<td>' + (s.punchIn
          ? '<b>' + F.time(s.punchIn.at) + '</b><div style="font-size:11px;color:var(--muted)">' + F.esc(s.punchIn.place) + '</div>'
          : '<span style="color:var(--muted)">not punched in</span>') + '</td>' +
        '<td>' + (s.punchOut
          ? '<b>' + F.time(s.punchOut.at) + '</b><div style="font-size:11px;color:var(--muted)">' + F.esc(s.punchOut.place) + '</div>'
          : (s.stillOn ? '<span class="chip chip--green">still on duty</span>' : '<span style="color:var(--muted)">-</span>')) + '</td>' +
        '<td class="num">' + F.mins(s.minutes) + '</td>' +
        '<td class="num"><b>' + s.stopCount + '</b></td>' +
        '<td class="num">' + s.placesVisited + '</td>' +
        '<td class="num">' + s.jobsDone + ' of ' + s.jobs + '</td>' +
        '<td class="num"><b>' + s.km + '</b></td>' +
        '<td class="num">' + (s.odoKm || '-') +
          (gap !== null ? '<div style="font-size:11px" class="' + (Math.abs(gap) >= 15 ? 't-breach' : '') + '">' +
            (gap > 0 ? '+' : '') + gap + ' gap</div>' : '') + '</td>' +
        '<td class="rowacts"><button class="btn btn--ghost btn--sm" data-stops="' + i + '">Where he went</button></td>' +
        '</tr>';
    }).join('');

    host.querySelectorAll('[data-stops]').forEach(b =>
      b.addEventListener('click', () => openDay(sheets[Number(b.dataset.stops)])));
  }

  /** Every counter one runner stood at on one day, in order, with how long he was there. */
  function openDay(s) {
    const line = (label, value) =>
      '<div class="kv"><span>' + label + '</span><b>' + value + '</b></div>';

    const head =
      '<div class="kvs">' +
      line('Punched in', s.punchIn ? F.time(s.punchIn.at) + ' &middot; ' + F.esc(s.punchIn.place) : 'not punched in') +
      line('Punched out', s.punchOut ? F.time(s.punchOut.at) + ' &middot; ' + F.esc(s.punchOut.place)
        : (s.stillOn ? 'still on duty' : '-')) +
      line('On duty', F.mins(s.minutes)) +
      line('Rode', s.km + ' km' + (s.odoKm ? ' (meter says ' + s.odoKm + ' km)' : '')) +
      line('Stopped at', s.stopCount + ' place' + (s.stopCount === 1 ? '' : 's') +
        (s.placesVisited !== s.stopCount ? ' (' + s.placesVisited + ' different)' : '')) +
      line('Jobs', s.jobsDone + ' finished of ' + s.jobs + ' given') +
      '</div>';

    const stops = s.stops.length
      ? '<ol class="stops">' + s.stops.map(st =>
        '<li class="stop">' +
        '<div class="stop__time mono">' + F.time(st.at) + '</div>' +
        '<div class="stop__body">' +
        '<b>' + F.esc(st.place) + '</b>' + (st.area ? ' <span style="color:var(--muted)">' + F.esc(st.area) + '</span>' : '') +
        '<div style="font-size:12px;color:var(--muted)">' + F.esc(st.did) +
        (st.what ? ' &middot; ' + F.esc(st.what) : '') + ' &middot; ' + F.esc(st.tripNo || '') + '</div>' +
        (st.leftAt
          ? '<div style="font-size:12px;color:var(--muted)">left ' + F.time(st.leftAt) +
            (st.minutes === null ? '' : ' &middot; stood there ' + F.mins(st.minutes)) + '</div>'
          : '<div style="font-size:12px;color:var(--muted)">no departure recorded</div>') +
        '</div></li>').join('') + '</ol>'
      : UI.empty('No stops recorded on this day',
        'He punched in, but no job reached a pickup or a drop point.');

    UI.openDrawer(s.runner + ' &middot; ' + F.date(s.date), head + '<h4 class="drawer__h">Where he went</h4>' + stops);
  }

  function exportCsv() {
    UI.csv('ibs-day-sheet.csv',
      ['Date', 'Runner', 'Code', 'Vehicle', 'Punch in', 'Punched in at', 'Punch out', 'Punched out at',
        'Minutes on duty', 'Stops', 'Different places', 'Jobs given', 'Jobs finished', 'GPS km', 'Meter km'],
      sheets.map(s => [s.date, s.runner, s.empCode, s.vehicleNo,
        s.punchIn ? F.time(s.punchIn.at) : '', s.punchIn ? s.punchIn.place : '',
        s.punchOut ? F.time(s.punchOut.at) : (s.stillOn ? 'still on duty' : ''),
        s.punchOut ? s.punchOut.place : '',
        s.minutes, s.stopCount, s.placesVisited, s.jobs, s.jobsDone, s.km, s.odoKm || '']));
  }

  return { boot };
})();
