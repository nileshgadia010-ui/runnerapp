/* Drawer, TAT chips and CSV download - shared by every page. */
const UI = (function () {
  const scrim = () => document.getElementById('scrim');
  const drawer = () => document.getElementById('drawer');

  function openDrawer(title, bodyHtml, footHtml) {
    document.getElementById('drawerTitle').textContent = title;
    document.getElementById('drawerBody').innerHTML = bodyHtml;
    document.getElementById('drawerFoot').innerHTML = footHtml || '';
    drawer().classList.add('is-open');
    scrim().classList.add('is-open');
  }
  function closeDrawer() {
    drawer().classList.remove('is-open');
    scrim().classList.remove('is-open');
  }

  // A running or finished stage clock. grade decides the colour.
  function clockChip(value, grade, label) {
    const cls = grade === 'breach' ? 'clock--breach' : grade === 'warn' ? 'clock--warn' : grade === 'na' ? 'clock--idle' : '';
    return '<span class="clock ' + cls + '"><span class="mono">' + F.mins(value) + '</span>' +
      (label ? '<small>' + F.esc(label) + '</small>' : '') + '</span>';
  }

  function tatCell(value, grade) {
    const cls = grade === 'breach' ? 't-breach' : grade === 'warn' ? 't-warn' : grade === 'ok' ? 't-ok' : '';
    return '<td class="num ' + cls + '">' + F.mins(value) + '</td>';
  }

  function dutyChip(state) {
    const map = {
      AVAILABLE: ['chip--green', 'Free'],
      ON_TRIP: ['chip--blue', 'On trip'],
      BREAK: ['chip--amber', 'On break'],
      OFF_DUTY: ['', 'Off duty']
    };
    const m = map[state] || ['', state];
    return '<span class="chip ' + m[0] + '">' + m[1] + '</span>';
  }

  function priorityChip(p) {
    const m = { EMERGENCY: 'chip--red', URGENT: 'chip--amber', ROUTINE: 'chip--ink' };
    return '<span class="chip ' + (m[p] || '') + '">' + (p || 'ROUTINE').toLowerCase() + '</span>';
  }

  function empty(message, hint) {
    return '<div class="empty"><b>' + F.esc(message) + '</b>' + (hint ? F.esc(hint) : '') + '</div>';
  }

  function emptyRow(cols, message) {
    return '<tr><td colspan="' + cols + '"><div class="empty"><b>' + F.esc(message) + '</b></div></td></tr>';
  }

  function csv(filename, headers, rows) {
    const cell = v => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const body = [headers.join(',')].concat(rows.map(r => r.map(cell).join(','))).join('\n');
    const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // Full-size photo viewer. Used for meter shots and handover proof - both are things
  // somebody reads against a number on the same screen, so opening a new tab loses the
  // context they are checking. Click anywhere or press Escape to close.
  function photo(url, caption) {
    let host = document.getElementById('photoView');
    if (!host) {
      host = document.createElement('div');
      host.id = 'photoView';
      host.className = 'photoview';
      document.body.appendChild(host);
      host.addEventListener('click', closePhoto);
      document.addEventListener('keydown', e => { if (e.key === 'Escape') closePhoto(); });
    }
    host.innerHTML =
      '<figure class="photoview__box">' +
      '<img src="' + url + '" alt="' + (caption || 'photo') + '" ' +
      'onerror="this.parentNode.querySelector(\'.photoview__gone\').hidden = false; this.hidden = true;">' +
      '<div class="photoview__gone" hidden>This photo is no longer on the server.</div>' +
      (caption ? '<figcaption>' + caption + '</figcaption>' : '') +
      '<a class="photoview__open" href="' + url + '" target="_blank" onclick="event.stopPropagation()">Open in a new tab</a>' +
      '</figure>';
    host.classList.add('is-open');
  }

  function closePhoto() {
    const host = document.getElementById('photoView');
    if (host) host.classList.remove('is-open');
  }

  /* ------------------------------------------------------------------ *
   * Row delete
   *
   * Every list gets its own delete control. The drawer already had one, but nobody opens a
   * record to throw it away - the mistake is spotted on the list, so the control belongs on
   * the list. One helper renders the button and one listener serves a whole table, so adding
   * it to a new page is two lines.
   * ------------------------------------------------------------------ */

  const ENDPOINT = {
    case: '/api/cases/',
    trip: '/api/trips/',
    place: '/api/locations/',
    staff: '/api/users/',
    attendance: '/api/reports/attendance/'
  };

  const WARNING = {
    case: 'The case and every runner job under it will go, along with their photos and GPS trails.',
    trip: 'The job and its photos and GPS trail will go. The case it belongs to stays.',
    place: 'Refused if any case still points at this place.',
    staff: 'Refused if this person has any job on record. Switch them off instead.',
    attendance: 'The punch in and punch out record for this day will go. Jobs are not touched.'
  };

  /** The little crimson bin that sits in the last column of a row. */
  function delBtn(kind, id, label) {
    if (!API.can('deleteRecords')) return '';
    return '<button class="rowdel" title="Delete" aria-label="Delete ' + F.esc(label || '') + '"' +
      ' data-del="' + kind + '" data-del-id="' + id + '" data-del-label="' + F.esc(label || '') + '">' +
      '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
      '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg></button>';
  }

  /**
   * Serves every delete button inside `host`. Delegated, so it survives the table being
   * redrawn, and guarded so one table is only wired once however often the page reloads.
   */
  function wireDelete(host, reload) {
    const el = typeof host === 'string' ? document.getElementById(host) : host;
    if (!el || el.dataset.delWired) return;
    el.dataset.delWired = '1';

    // Capture, not bubble. Most of these tables put a click handler on the row itself to
    // open a drawer, and a bubbling listener on the tbody would run after it - so the record
    // would open behind the confirm box every time. Capture runs on the way down instead.
    el.addEventListener('click', e => {
      const btn = e.target.closest('[data-del]');
      if (!btn || !el.contains(btn)) return;
      e.stopPropagation();          // never let the row's own click open a drawer as well
      e.preventDefault();

      const kind = btn.dataset.del;
      const label = btn.dataset.delLabel || 'this record';
      const ok = confirm('Delete ' + label + ' permanently?\n\n' +
        (WARNING[kind] || '') + '\n\nThis cannot be undone.');
      if (!ok) return;

      btn.disabled = true;
      API.del(ENDPOINT[kind] + btn.dataset.delId)
        .then(r => {
          toast((r && r.message) || 'Deleted', 'ok');
          const row = btn.closest('tr');
          if (row) row.remove();
          if (typeof reload === 'function') reload();
        })
        .catch(err => { btn.disabled = false; toast(err.message, 'bad'); });
    }, true);
  }

  /**
   * Downloads a file from an endpoint that needs the bearer token.
   *
   * A plain link cannot carry the header, so the file comes back as a blob and is handed to
   * the browser from memory. The button reports its own progress, because a month of data
   * takes a moment and a dead-looking button gets clicked four more times.
   */
  function download(url, params, btn) {
    const full = url + (params && API.qs(params) ? '?' + API.qs(params) : '');
    const was = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Building...'; }

    return fetch(full, { headers: { Authorization: 'Bearer ' + API.token() } })
      .then(res => {
        if (!res.ok) return res.json().catch(() => ({})).then(d => { throw new Error(d.error || 'Could not build that file'); });
        const name = (res.headers.get('content-disposition') || '').match(/filename="?([^";]+)/);
        return res.blob().then(b => ({ blob: b, name: name ? name[1] : 'ibs-report.xlsx' }));
      })
      .then(({ blob, name }) => {
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href; a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(href), 4000);
        toast('Excel file downloaded', 'ok');
      })
      .catch(e => toast(e.message, 'bad'))
      .then(() => { if (btn) { btn.disabled = false; btn.textContent = was; } });
  }

  /** The row of big numbers that sits above a report table. */
  function tiles(items) {
    return '<div class="tiles">' + items.map(t =>
      '<div class="tile' + (t.alert ? ' tile--alert' : '') + '">' +
      '<b>' + F.esc(String(t.value === null || t.value === undefined ? '--' : t.value)) + '</b>' +
      '<span>' + F.esc(t.label) + '</span>' +
      (t.note ? '<small>' + F.esc(t.note) + '</small>' : '') +
      '</div>').join('') + '</div>';
  }

  return {
    openDrawer, closeDrawer, clockChip, tatCell, dutyChip, priorityChip,
    empty, emptyRow, csv, photo, closePhoto,
    delBtn, wireDelete, download, tiles
  };
})();
