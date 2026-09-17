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
    if (!allowed(page)) { toast('You do not have rights for that screen', 'error'); return; }
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

  // Hide what this person cannot use. The server refuses these calls anyway - this only
  // stops someone being shown a screen that will bounce them, which reads as a broken app.
  const PAGE_RIGHT = {
    cases: 'createCases',
    trips: 'viewReports',
    runners: 'manageStaff',
    places: 'managePlaces',
    attendance: 'viewReports',
    reports: 'viewReports'
  };

  function applyRights() {
    Object.keys(PAGE_RIGHT).forEach(page => {
      if (API.can(PAGE_RIGHT[page])) return;
      const link = document.querySelector('.rail__link[data-page="' + page + '"]');
      if (link) link.hidden = true;
    });

    [['newCaseBtn', 'createCases'], ['newRunnerBtn', 'manageStaff'], ['newPlaceBtn', 'managePlaces']]
      .forEach(([id, right]) => {
        const el = document.getElementById(id);
        if (el && !API.can(right)) el.hidden = true;
      });
  }

  // Never land on a page this account cannot open - fall back to the live board.
  function allowed(page) {
    const right = PAGE_RIGHT[page];
    return !right || API.can(right);
  }

  function boot() {
    const me = API.user();
    if (!API.token() || !me) { location.href = 'index.html'; return; }

    document.getElementById('whoName').textContent = me.name;
    document.getElementById('whoRole').textContent = me.role;

    // Pull a fresh copy of the signed-in user before deciding what to hide. Without this a
    // browser that signed in yesterday keeps yesterday's rights - which is exactly how the
    // whole rail ends up unclickable after a server update.
    API.refreshUser().then(u => {
      if (u) {
        document.getElementById('whoName').textContent = u.name;
        document.getElementById('whoRole').textContent = u.role;
      }
      applyRights();
    });
    document.getElementById('signOut').addEventListener('click', () => { API.clear(); location.href = 'index.html'; });

    document.querySelectorAll('.rail__link').forEach(b => b.addEventListener('click', () => go(b.dataset.page)));
    document.getElementById('drawerClose').addEventListener('click', UI.closeDrawer);
    document.getElementById('scrim').addEventListener('click', UI.closeDrawer);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') UI.closeDrawer(); });

    const wanted = (location.hash || '#live').slice(1);
    go(wanted in loaders && allowed(wanted) ? wanted : 'live');

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

      // A phone that starts reporting a VPN, a fake-GPS app or root raises this once, the
      // moment it changes. It is information for the desk, not an alarm - so it repaints
      // the board and leaves a line in the console rather than interrupting anyone.
      socket.on('runner:integrity', d => {
        console.warn('[integrity]', d.name, d);
        Live.refresh();
      });
    }
  }

  return { boot, go };
})();

document.addEventListener('DOMContentLoaded', Main.boot);
