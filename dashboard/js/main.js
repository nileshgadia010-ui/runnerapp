/* Shell: page switching, the counter strip and the live socket. */
const Main = (function () {
  const loaders = {
    live: () => Live.boot(),
    cases: () => Cases.boot(),
    trips: () => Reports.bootTrips(),
    runners: () => Masters.bootRunners(),
    places: () => Masters.bootPlaces(),
    attendance: () => Masters.bootAttendance(),
    routes: () => Routes.boot(),
    reports: () => Reports.bootReports()
  };

  function go(page) {
    if (!allowed(page)) { toast('You do not have rights for that screen. Ask an admin.', 'error'); return; }
    document.querySelectorAll('.rail__link').forEach(b => b.classList.toggle('is-active', b.dataset.page === page));
    document.querySelectorAll('.page').forEach(p => { p.hidden = p.dataset.page !== page; });
    if (loaders[page]) Promise.resolve(loaders[page]()).catch(e => toast(e.message, 'error'));

    // Coming back to the live board means the map was hidden while the window may have
    // changed size. Leaflet cannot notice that on its own, so it is told to re-measure the
    // moment its container is visible again.
    if (page === 'live' && window.Live && Live.resize) requestAnimationFrame(Live.resize);
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
    routes: 'viewReports',
    reports: 'viewReports'
  };

  // Safety net, used by BOTH hiding and navigation. If the rights data would deny every
  // screen, something upstream is wrong - a stale copy, a bad save, a half-applied change.
  // In that case the dashboard trusts nothing it was told and lets the server decide per
  // call. Hiding a link but still blocking the click was the worst of both worlds.
  function rightsUsable() {
    const u = API.user() || {};
    if (u.role === 'runner') return true;
    const any = Object.keys(PAGE_RIGHT).some(p => API.can(PAGE_RIGHT[p]));
    if (!any) console.warn('[rights] every screen came back denied - ignoring and letting the server decide');
    return any;
  }

  function applyRights() {
    if (!rightsUsable()) return;

    // Lock rather than hide. Rights arrive a moment after the page paints, so removing a
    // link makes it appear and then vanish under the reader's eye - which looks like a bug
    // even when it is correct. A dimmed, locked link is honest: the screen exists, this
    // account just cannot open it, and the tooltip says to ask an admin.
    Object.keys(PAGE_RIGHT).forEach(page => {
      const link = document.querySelector('.rail__link[data-page="' + page + '"]');
      if (!link) return;
      const ok = API.can(PAGE_RIGHT[page]);
      link.classList.toggle('is-locked', !ok);
      link.title = ok ? '' : 'You do not have rights for this screen. Ask an admin.';
    });

    [['newCaseBtn', 'createCases'], ['newRunnerBtn', 'manageStaff'], ['newPlaceBtn', 'managePlaces']]
      .forEach(([id, right]) => {
        const el = document.getElementById(id);
        if (el) el.hidden = !API.can(right);
      });
  }

  // Never land on a page this account cannot open - fall back to the live board.
  function allowed(page) {
    const right = PAGE_RIGHT[page];
    if (!right) return true;
    if (!rightsUsable()) return true;
    return API.can(right);
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

    // Show when this server was deployed, so "is my change live yet" is a glance, not a guess.
    API.get('/api/version').then(v => {
      const el = document.getElementById('buildStamp');
      if (!el || !v || !v.startedAt) return;
      const d = new Date(v.startedAt);
      el.textContent = 'Deployed ' + d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) +
        ' ' + d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    }).catch(() => {});

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
      // Location is handled on its own because it arrives constantly and only needs to move
      // one pin. Routing it through the full-board refresh made every ping re-fetch and
      // repaint everything, which is why the map lagged instead of tracking.
      socket.on('runner:location', d => Live.moveRunner(d));

      ['runner:status', 'trip:update', 'case:update', 'case:new'].forEach(ev =>
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
