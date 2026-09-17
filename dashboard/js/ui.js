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

  return { openDrawer, closeDrawer, clockChip, tatCell, dutyChip, priorityChip, empty, emptyRow, csv, photo, closePhoto };
})();
