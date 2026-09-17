/* Shell: page switching, the counter strip and the live socket. */
const Main = (function () {
  const loaders = {
    live: () => Live.boot(),
    cases: () => Cases.boot(),
    trips: () => Reports.bootTrips(),
    runners: () => Masters.bootRunners(),
    places: () => Masters.bootPlaces(),
    attendance: () => Masters.bootAttendance(),
    reports: () => Reports.bootReports()
  };

  function go(page) {
    document.querySelectorAll('.rail__link').forEach(b => b.classList.toggle('is-active', b.dataset.page === page));
    document.querySelectorAll('.page').forEach(p => { p.hidden = p.dataset.page !== page; });
    if (loaders[page]) Promise.resolve(loaders[page]()).catch(e => toast(e.message, 'error'));
    location.hash = page;
  }

  async function strip() {
    try {
      const s = await API.get('/api/reports/today');
      const item = (value, label, cls) =>
        '<div class="stat ' + (cls || '') + '"><b class="mono">' + value + '</b><span>' + label + '</span></div>';

      document.getElementById('strip').innerHTML =
        item(s.openCases, 'Open cases') +
        item(s.activeTrips, 'Running trips') +
        item(s.awaitingAccept, 'Waiting to accept', s.awaitingAccept ? 'is-alert' : '') +
        item(s.runnersAvailable, 'Runners free', s.runnersAvailable ? 'is-good' : '') +
        item(s.runnersOnTrip, 'Runners on trip') +
        item(s.runnersOffDuty + s.runnersOnBreak, 'Off duty or break') +
        item(s.completedToday, 'Finished today') +
        item(F.mins(s.avgTatToday), 'Avg TAT today') +
        item(s.liveBreaches, 'Running late now', s.liveBreaches ? 'is-alert' : '') +
        '<div class="strip__clock mono" id="wallClock"></div>';
    } catch (e) { /* retry on the next tick */ }
  }

  function tickClock() {
    const el = document.getElementById('wallClock');
    if (el) el.textContent = new Date().toLocaleTimeString('en-IN', { hour12: true });
  }

  function boot() {
    const me = API.user();
    if (!API.token() || !me) { location.href = 'index.html'; return; }

    document.getElementById('whoName').textContent = me.name;
    document.getElementById('whoRole').textContent = me.role;
    document.getElementById('signOut').addEventListener('click', () => { API.clear(); location.href = 'index.html'; });

    document.querySelectorAll('.rail__link').forEach(b => b.addEventListener('click', () => go(b.dataset.page)));
    document.getElementById('drawerClose').addEventListener('click', UI.closeDrawer);
    document.getElementById('scrim').addEventListener('click', UI.closeDrawer);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') UI.closeDrawer(); });

    go((location.hash || '#live').slice(1) in loaders ? location.hash.slice(1) : 'live');

    strip();
    setInterval(strip, 15000);
    setInterval(tickClock, 1000);

    // Push updates: a runner moving, accepting or finishing repaints the board at once.
    if (window.io) {
      const socket = io();
      ['runner:location', 'runner:status', 'trip:update', 'case:update', 'case:new'].forEach(ev =>
        socket.on(ev, () => {
          Live.refresh();
          strip();
          const cases = document.querySelector('.page[data-page="cases"]');
          if (cases && !cases.hidden) Cases.load();
        }));
    }
  }

  return { boot, go };
})();

document.addEventListener('DOMContentLoaded', Main.boot);
