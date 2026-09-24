/*
 * Danger zone - clear the database and start fresh.
 *
 * This is the one screen in the control room designed to be hard to use. It is folded away,
 * it shows what it is about to destroy before it destroys it, and it asks for two separate
 * things - a code the office knows and a phrase typed out in full. Neither a stray click nor
 * a remembered code is enough on its own.
 *
 * The server enforces all of it again; nothing here is a security measure. What this does is
 * make sure that whoever presses it meant to.
 */
const Danger = (function () {
  let booted = false;
  let counts = null;

  const el = id => document.getElementById(id);

  /** Only an admin who may delete records ever sees the panel at all. */
  function boot() {
    const zone = el('dangerZone');
    if (!zone) return;

    const me = API.user() || {};
    const allowed = me.role === 'admin' && API.can('deleteRecords');
    zone.hidden = !allowed;
    if (!allowed) return;

    if (booted) return;
    booted = true;

    el('dangerToggle').addEventListener('click', () => {
      const body = el('dangerBody');
      const open = body.hidden;
      body.hidden = !open;
      el('dangerToggle').setAttribute('aria-expanded', String(open));
      el('dangerZone').classList.toggle('is-open', open);
      if (open) paint();
    });
  }

  async function paint() {
    const body = el('dangerBody');
    body.innerHTML = '<p class="danger__wait">Counting what is in the database...</p>';

    try {
      counts = await API.get('/api/danger/preview');
    } catch (e) {
      body.innerHTML = '<p class="danger__wait">' + F.esc(e.message) + '</p>';
      return;
    }

    const d = counts.data, a = counts.everything;
    const line = n => '<b>' + n + '</b>';

    body.innerHTML =
      '<p class="danger__lead">This cannot be undone. There is no backup inside the software &mdash; ' +
      'once it is gone it is gone. Read which of the two you are choosing.</p>' +

      '<div class="danger__picks">' +

      '<label class="danger__pick">' +
      '<input type="radio" name="dangerScope" value="data" checked>' +
      '<div><b>Clear the records only</b>' +
      '<p>Deletes ' + line(d.cases) + ' cases, ' + line(d.trips) + ' jobs, ' +
      line(d.attendance) + ' attendance days, ' + line(d.photos) + ' photos and ' +
      line(d.pings) + ' GPS points. ' +
      '<u>Your hospitals and your staff stay.</u> Case numbers start from 1 again.</p>' +
      '<small>This is the one to use after a testing round.</small></div></label>' +

      '<label class="danger__pick danger__pick--all">' +
      '<input type="radio" name="dangerScope" value="everything">' +
      '<div><b>Clear everything &mdash; brand new software</b>' +
      '<p>All of the above, plus ' + line(a.places) + ' hospitals and blood centres and ' +
      line(a.staff) + ' other logins. You will have to add every hospital and every runner again.</p>' +
      '<small>Your own login (' + F.esc(counts.keeps.account) + ') is kept, ' +
      'so you can still sign in afterwards.</small></div></label>' +

      '</div>' +

      '<div class="danger__fields">' +
      '<div class="field"><label for="dangerCode">Reset code</label>' +
      '<input type="password" id="dangerCode" autocomplete="off" inputmode="numeric" placeholder="4 digits"></div>' +
      '<div class="field"><label for="dangerPhrase">Type <b>DELETE EVERYTHING</b> to confirm</label>' +
      '<input type="text" id="dangerPhrase" autocomplete="off" spellcheck="false" placeholder="DELETE EVERYTHING"></div>' +
      '</div>' +

      '<button class="btn btn--red" id="dangerGo" disabled>Clear the database</button>' +
      '<span class="danger__hint" id="dangerHint">Enter the code and the phrase to enable this.</span>';

    const code = el('dangerCode'), phrase = el('dangerPhrase'), go = el('dangerGo');

    // The button stays dead until both boxes are filled, so there is never a moment where one
    // more click would do it.
    const recheck = () => {
      const ready = code.value.trim().length >= 4 &&
        phrase.value.trim().toUpperCase() === 'DELETE EVERYTHING';
      go.disabled = !ready;
      el('dangerHint').textContent = ready
        ? 'This will run as soon as you press it.'
        : 'Enter the code and the phrase to enable this.';
    };
    code.addEventListener('input', recheck);
    phrase.addEventListener('input', recheck);
    go.addEventListener('click', run);
  }

  async function run() {
    const scope = document.querySelector('input[name="dangerScope"]:checked').value;
    const go = el('dangerGo');

    const what = scope === 'everything'
      ? 'EVERYTHING - every case, job, photo, hospital and every other login'
      : 'every case, job, punch and photo (hospitals and staff stay)';

    if (!confirm('Last check.\n\nThis will delete ' + what + '.\n\n' +
      'It cannot be undone and there is no backup.\n\nPress OK only if you are sure.')) return;

    go.disabled = true;
    go.textContent = 'Clearing...';

    try {
      const r = await API.post('/api/danger/reset', {
        code: el('dangerCode').value.trim(),
        confirm: el('dangerPhrase').value.trim(),
        scope
      });

      el('dangerBody').innerHTML =
        '<div class="danger__done"><b>Done.</b>' +
        '<p>' + F.esc(r.message) + '</p>' +
        '<p>' + F.esc(r.kept) + '</p>' +
        '<p class="danger__counts">' + Object.keys(r.removed)
          .map(k => F.esc(k) + ': ' + F.esc(String(r.removed[k]))).join(' &middot; ') + '</p>' +
        '<button class="btn btn--red" id="dangerReload">Reload the dashboard</button></div>';

      // Everything on screen now describes records that no longer exist, so the page is
      // reloaded rather than left showing a cached picture of a database that is empty.
      el('dangerReload').addEventListener('click', () => location.reload());
      setTimeout(() => location.reload(), 6000);

    } catch (e) {
      go.disabled = false;
      go.textContent = 'Clear the database';
      el('dangerHint').textContent = e.message;
      toast(e.message, 'error');
    }
  }

  return { boot };
})();
