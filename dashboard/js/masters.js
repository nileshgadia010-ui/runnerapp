/* Staff master and place master. A place saved here is what the runner app navigates to. */
const Masters = (function () {
  let staff = [];
  let places = [];
  let pickerMap = null;
  let pickerMarker = null;
  let bootedRunners = false;
  let bootedPlaces = false;

  /* ---------------- staff ---------------- */
  async function bootRunners() {
    if (!bootedRunners) {
      bootedRunners = true;
      document.getElementById('newRunnerBtn').addEventListener('click', () => staffForm());
      document.getElementById('perfApply').addEventListener('click', loadPerf);
      document.getElementById('perfFrom').value = F.today();
      document.getElementById('perfTo').value = F.today();
    }
    await loadStaff();
    await loadPerf();
    Danger.boot();
  }

  async function loadStaff() {
    staff = await API.get('/api/users', { active: 'all' });
    const host = document.getElementById('runnerRows');
    if (!staff.length) { host.innerHTML = UI.emptyRow(8, 'No staff added yet'); return; }

    host.innerHTML = staff.map(u =>
      '<tr>' +
      '<td><b>' + F.esc(u.name) + '</b><div style="font-size:11px;color:var(--muted)">' + F.esc(u.username) + '</div></td>' +
      '<td>' + F.esc(u.empCode || '-') + '</td>' +
      '<td>' + F.esc(u.phone || '-') + '</td>' +
      '<td>' + F.esc(u.vehicleNo || '-') + '<div style="font-size:11px;color:var(--muted)">' + shiftText(u) + '</div></td>' +
      '<td><span class="chip">' + F.esc(u.role) + '</span></td>' +
      '<td>' + (u.role === 'runner' ? UI.dutyChip(u.dutyState) : '-') + (u.active ? '' : ' <span class="chip chip--red">switched off</span>') + '</td>' +
      '<td>' + (u.lastSeenAt ? F.ago(u.lastSeenAt) : '-') + '</td>' +
      '<td class="rowacts"><button class="btn btn--ghost btn--sm" data-edit="' + u.id + '">Edit</button>' +
      UI.delBtn('staff', u.id, F.esc(u.name)) + '</td>' +
      '</tr>').join('');

    host.querySelectorAll('[data-edit]').forEach(b =>
      b.addEventListener('click', () => staffForm(staff.find(s => String(s.id) === b.dataset.edit))));
    UI.wireDelete(host, loadStaff);
  }

  // "09:00 - 18:00 - off Sun" in one short line, or a dash when nothing is set.
  function shiftText(u) {
    if (!u.shiftStart && !u.shiftEnd && !u.weekOff) return '-';
    const hours = u.shiftStart && u.shiftEnd ? u.shiftStart + ' - ' + u.shiftEnd : (u.shiftStart || u.shiftEnd || '');
    const off = u.weekOff ? (hours ? ' &middot; off ' : 'off ') + F.esc(u.weekOff.slice(0, 3)) : '';
    return hours + off;
  }

  function staffForm(u) {
    const v = f => F.esc(u ? (u[f] || '') : '');
    const body =
      '<div class="grid-2">' +
      '<div class="field"><label>Full name</label><input id="sName" value="' + v('name') + '"></div>' +
      '<div class="field"><label>Staff code</label><input id="sCode" value="' + v('empCode') + '"></div></div>' +
      '<div class="grid-2">' +
      '<div class="field"><label>User ID for the app</label><input id="sUser" value="' + v('username') + '">' +
      '<small style="color:var(--muted);font-size:11px">Letters, numbers, dot, dash, underscore. Changing it keeps all history - the runner just signs in with the new ID.</small></div>' +
      '<div class="field"><label>' + (u ? 'New password (leave blank to keep)' : 'Password') + '</label><input id="sPass" type="text"></div></div>' +
      '<div class="grid-2">' +
      '<div class="field"><label>Phone</label><input id="sPhone" value="' + v('phone') + '"></div>' +
      '<div class="field"><label>Vehicle number</label><input id="sVehicle" value="' + v('vehicleNo') + '"></div></div>' +
      '<div class="grid-2">' +
      '<div class="field"><label>Shift starts</label><input id="sShiftStart" type="time" value="' + v('shiftStart') + '"></div>' +
      '<div class="field"><label>Shift ends</label><input id="sShiftEnd" type="time" value="' + v('shiftEnd') + '"></div></div>' +
      '<div class="field"><label>Weekly off</label><select id="sWeekOff">' +
      ['', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Rotational', 'None']
        .map(d => '<option value="' + d + '" ' + (u && u.weekOff === d ? 'selected' : '') + '>' + (d || '--') + '</option>').join('') +
      '</select></div>' +
      '<div class="grid-2">' +
      '<div class="field"><label>Role</label><select id="sRole">' +
      ['runner', 'coordinator', 'admin'].map(r => '<option value="' + r + '" ' + (u && u.role === r ? 'selected' : '') + '>' + r + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label>Account</label><select id="sActive">' +
      '<option value="1" ' + (!u || u.active ? 'selected' : '') + '>Working</option>' +
      '<option value="0" ' + (u && !u.active ? 'selected' : '') + '>Switched off</option></select></div></div>' +
      rightsBlock(u) +
      '<p style="color:var(--muted);font-size:13px">Runners sign in to the IBS Runner app with this user ID and password.</p>';

    UI.openDrawer(u ? 'Edit ' + u.name : 'Add staff', body,
      (u && API.can('deleteRecords')
        ? '<button class="btn btn--ghost" id="sDelete" style="color:var(--crimson)">Delete</button>' : '') +
      '<button class="btn btn--ghost" onclick="UI.closeDrawer()">Cancel</button><button class="btn btn--red" id="sSave">Save</button>');

    wireRoleReset();

    const sDel = document.getElementById('sDelete');
    if (sDel) sDel.addEventListener('click', () => deleteStaff(u));

    document.getElementById('sSave').addEventListener('click', async () => {
      const payload = {
        name: document.getElementById('sName').value.trim(),
        empCode: document.getElementById('sCode').value.trim(),
        phone: document.getElementById('sPhone').value.trim(),
        vehicleNo: document.getElementById('sVehicle').value.trim(),
        shiftStart: document.getElementById('sShiftStart').value,
        shiftEnd: document.getElementById('sShiftEnd').value,
        weekOff: document.getElementById('sWeekOff').value,
        role: document.getElementById('sRole').value,
        active: document.getElementById('sActive').value === '1'
      };
      const pass = document.getElementById('sPass').value;
      if (pass) payload.password = pass;

      payload.username = document.getElementById('sUser').value.trim().toLowerCase();
      if (!payload.username) return toast('User ID is required', 'error');

      const rights = readRights();
      if (rights) payload.rights = rights;

      try {
        if (u) await API.put('/api/users/' + u.id, payload);
        else {
          if (!pass) return toast('Password is required for a new account', 'error');
          await API.post('/api/users', payload);
        }
        toast('Saved', 'ok');
        UI.closeDrawer();
        loadStaff();
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  async function loadPerf() {
    const data = await API.get('/api/reports/runners', {
      from: document.getElementById('perfFrom').value,
      to: document.getElementById('perfTo').value
    });
    const host = document.getElementById('perfRows');
    if (!data.rows.length) { host.innerHTML = UI.emptyRow(10, 'Nothing to show for these dates'); return; }

    host.innerHTML = data.rows.map(r =>
      '<tr><td>' + F.esc(r.runner) + '</td>' +
      '<td class="num">' + r.daysWorked + '</td>' +
      '<td class="num">' + r.dutyHours + '</td>' +
      '<td class="num">' + r.trips + '</td>' +
      '<td class="num">' + r.completed + '</td>' +
      '<td class="num">' + r.rejected + '</td>' +
      '<td class="num">' + F.mins(r.avgAccept) + '</td>' +
      '<td class="num">' + F.mins(r.avgTrip) + '</td>' +
      '<td class="num ' + (r.onTimePercent === null ? '' : r.onTimePercent >= 80 ? 't-ok' : 't-breach') + '">' + (r.onTimePercent === null ? '--' : r.onTimePercent + '%') + '</td>' +
      '<td class="num">' + r.distanceKm + ' km</td></tr>').join('');
  }

  /* ---------------- places ---------------- */
  async function bootPlaces() {
    if (!bootedPlaces) {
      bootedPlaces = true;
      document.getElementById('newPlaceBtn').addEventListener('click', () => placeForm());
    }
    await loadPlaces();
  }

  async function loadPlaces() {
    places = await API.get('/api/locations', { all: 1 });
    const host = document.getElementById('placeRows');
    if (!places.length) { host.innerHTML = UI.emptyRow(7, 'No places added yet'); return; }

    host.innerHTML = places.map(p =>
      '<tr><td><b>' + F.esc(p.name) + '</b>' + (p.active ? '' : ' <span class="chip chip--red">off</span>') + '</td>' +
      '<td><span class="chip ' + (p.type === 'BLOOD_CENTER' ? 'chip--red' : 'chip--ink') + '">' + F.esc(p.type.replace('_', ' ').toLowerCase()) + '</span></td>' +
      '<td>' + F.esc([p.area, p.city].filter(Boolean).join(', ')) + '</td>' +
      '<td>' + F.esc(p.contactPerson || '') + ' ' + F.esc(p.phone || '') + '</td>' +
      '<td class="mono" style="font-size:12px">' + Number(p.lat).toFixed(5) + ', ' + Number(p.lng).toFixed(5) + '</td>' +
      '<td class="num">' + (p.geofence || 200) + ' m</td>' +
      '<td class="rowacts"><button class="btn btn--ghost btn--sm" data-edit="' + p._id + '">Edit</button>' +
      UI.delBtn('place', p._id, F.esc(p.name)) + '</td></tr>').join('');

    host.querySelectorAll('[data-edit]').forEach(b =>
      b.addEventListener('click', () => placeForm(places.find(p => String(p._id) === b.dataset.edit))));
    UI.wireDelete(host, loadPlaces);
  }

  function placeForm(p) {
    const v = f => F.esc(p ? (p[f] === undefined || p[f] === null ? '' : p[f]) : '');
    const lat = p ? p.lat : 23.0225;
    const lng = p ? p.lng : 72.5714;

    const body =
      '<div class="field"><label>Place name</label><input id="pName" value="' + v('name') + '"></div>' +
      '<div class="grid-2">' +
      '<div class="field"><label>Type</label><select id="pType">' +
      [['HOSPITAL', 'Hospital'], ['BLOOD_CENTER', 'Blood centre'], ['LAB', 'Lab'], ['CLINIC', 'Clinic'], ['OTHER', 'Other']]
        .map(([k, l]) => '<option value="' + k + '" ' + (p && p.type === k ? 'selected' : '') + '>' + l + '</option>').join('') + '</select></div>' +
      '<div class="field"><label>Short code</label><input id="pCode" value="' + v('code') + '"></div></div>' +
      '<div class="field"><label>Address</label><textarea id="pAddress">' + v('address') + '</textarea></div>' +
      '<div class="grid-3">' +
      '<div class="field"><label>Area</label><input id="pArea" value="' + v('area') + '"></div>' +
      '<div class="field"><label>City</label><input id="pCity" value="' + (p ? v('city') : 'Ahmedabad') + '"></div>' +
      '<div class="field"><label>Pincode</label><input id="pPin" value="' + v('pincode') + '"></div></div>' +
      '<div class="grid-2">' +
      '<div class="field"><label>Contact person</label><input id="pPerson" value="' + v('contactPerson') + '"></div>' +
      '<div class="field"><label>Phone</label><input id="pPhone" value="' + v('phone') + '"></div></div>' +
      '<div class="field"><label>Drop the pin where the runner must reach</label>' +
      '<div id="pickerMap" style="height:230px;border-radius:8px;border:1px solid var(--line)"></div></div>' +
      '<div class="grid-3">' +
      '<div class="field"><label>Latitude</label><input id="pLat" class="mono" value="' + lat + '"></div>' +
      '<div class="field"><label>Longitude</label><input id="pLng" class="mono" value="' + lng + '"></div>' +
      '<div class="field"><label>Reach radius (m)</label><input id="pFence" type="number" value="' + (p ? (p.geofence || 200) : 200) + '"></div></div>' +
      '<p style="color:var(--muted);font-size:13px">Tap the map or paste a Google Maps latitude and longitude. The runner app opens navigation to this exact point.</p>';

    UI.openDrawer(p ? 'Edit ' + p.name : 'Add place', body,
      (p && API.can('deleteRecords')
        ? '<button class="btn btn--ghost" id="pDelete" style="color:var(--crimson)">Delete</button>' : '') +
      '<button class="btn btn--ghost" onclick="UI.closeDrawer()">Cancel</button><button class="btn btn--red" id="pSave">Save place</button>');

    const pDel = document.getElementById('pDelete');
    if (pDel) pDel.addEventListener('click', () => deletePlace(p));

    setTimeout(() => {
      pickerMap = L.map('pickerMap').setView([lat, lng], p ? 15 : 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(pickerMap);
      pickerMarker = L.marker([lat, lng], { draggable: true }).addTo(pickerMap);

      const sync = ll => {
        document.getElementById('pLat').value = ll.lat.toFixed(6);
        document.getElementById('pLng').value = ll.lng.toFixed(6);
      };
      pickerMap.on('click', e => { pickerMarker.setLatLng(e.latlng); sync(e.latlng); });
      pickerMarker.on('dragend', () => sync(pickerMarker.getLatLng()));

      ['pLat', 'pLng'].forEach(id => document.getElementById(id).addEventListener('change', () => {
        const la = parseFloat(document.getElementById('pLat').value);
        const ln = parseFloat(document.getElementById('pLng').value);
        if (!isNaN(la) && !isNaN(ln)) { pickerMarker.setLatLng([la, ln]); pickerMap.setView([la, ln], 16); }
      }));
      pickerMap.invalidateSize();
    }, 60);

    document.getElementById('pSave').addEventListener('click', async () => {
      const payload = {
        name: document.getElementById('pName').value.trim(),
        type: document.getElementById('pType').value,
        code: document.getElementById('pCode').value.trim(),
        address: document.getElementById('pAddress').value.trim(),
        area: document.getElementById('pArea').value.trim(),
        city: document.getElementById('pCity').value.trim(),
        pincode: document.getElementById('pPin').value.trim(),
        contactPerson: document.getElementById('pPerson').value.trim(),
        phone: document.getElementById('pPhone').value.trim(),
        lat: parseFloat(document.getElementById('pLat').value),
        lng: parseFloat(document.getElementById('pLng').value),
        geofence: Number(document.getElementById('pFence').value || 200)
      };
      if (!payload.name) return toast('Enter the place name', 'error');
      if (isNaN(payload.lat) || isNaN(payload.lng)) return toast('Drop the pin on the map', 'error');

      try {
        if (p) await API.put('/api/locations/' + p._id, payload);
        else await API.post('/api/locations', payload);
        toast('Place saved', 'ok');
        UI.closeDrawer();
        loadPlaces();
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  /*
   * Same two-step as places. Switching an account off stops the sign-in while every job that
   * person ever ran still carries their name; deleting erases them, and the server refuses
   * it once they have any job on record - a report full of jobs run by nobody helps nobody.
   */
  function deleteStaff(u) {
    const hard = window.confirm(
      'Remove ' + u.name + ' permanently?\n\n' +
      'OK = delete the account for good (refused if they have any jobs on record)\n' +
      'Cancel = just switch it off, so their past jobs keep their name');

    API.del('/api/users/' + u.id + (hard ? '?hard=1' : ''))
      .then(r => { toast(r.message || 'Done', 'ok'); UI.closeDrawer(); loadStaff(); })
      .catch(e => toast(e.message, 'error'));
  }

  // The eight things an account can be allowed to do. Only an admin sees or sends these;
  // for anyone else the server ignores the field entirely.
  const RIGHTS = [
    ['manageStaff',    'Add and edit staff accounts'],
    ['managePlaces',   'Add and edit hospitals and centres'],
    ['createCases',    'Create and edit cases'],
    ['assignTrips',    'Assign, reassign, re-ping and cancel jobs'],
    ['overrideStages', 'Move a stage on the runner\'s behalf'],
    ['editSettings',   'Crossmatch, close and cancel a case'],
    ['viewReports',    'Open the reports and export data'],
    ['deleteRecords',  'Delete cases, jobs, places and staff permanently']
  ];

  // What each role normally gets. Mirrors ROLE_RIGHTS on the server; kept here only so a
  // brand new account starts with sensible boxes already ticked instead of all empty.
  const ROLE_DEFAULTS = {
    admin:       ['manageStaff', 'managePlaces', 'createCases', 'assignTrips', 'overrideStages', 'editSettings', 'viewReports', 'deleteRecords'],
    coordinator: ['manageStaff', 'managePlaces', 'createCases', 'assignTrips', 'overrideStages', 'editSettings', 'viewReports'],
    runner:      []
  };

  function rightsBlock(u) {
    if ((API.user() || {}).role !== 'admin') return '';

    // For an existing person the server sends what they can actually do today. For a new one
    // we pre-tick the role's normal set - saving a screen of empty boxes would otherwise
    // create an account that can do nothing at all.
    const role = u ? u.role : 'runner';
    const current = (u && u.rights) || {};
    const isOn = key => u ? !!current[key] : ROLE_DEFAULTS[role].indexOf(key) >= 0;

    const boxes = RIGHTS.map(([key, label]) =>
      '<label class="right-row"><input type="checkbox" data-right="' + key + '" ' +
      (isOn(key) ? 'checked' : '') + '><span>' + label + '</span></label>').join('');

    return '<div class="field"><label>What this person can do</label>' +
      '<div class="rights-box" id="sRights">' + boxes + '</div>' +
      '<small style="color:var(--muted);font-size:11px">An admin always has every right, whatever is ticked here. ' +
      'Changing the role below re-ticks these to that role\'s normal set.</small></div>';
  }

  // Keep the boxes honest when the role changes mid-edit.
  function wireRoleReset() {
    const role = document.getElementById('sRole');
    const host = document.getElementById('sRights');
    if (!role || !host) return;
    role.addEventListener('change', () => {
      const set = ROLE_DEFAULTS[role.value] || [];
      host.querySelectorAll('[data-right]').forEach(cb => {
        cb.checked = set.indexOf(cb.dataset.right) >= 0;
      });
    });
  }

  function readRights() {
    const host = document.getElementById('sRights');
    if (!host) return null;
    const out = {};
    host.querySelectorAll('[data-right]').forEach(cb => { out[cb.dataset.right] = cb.checked; });
    return out;
  }

  /*
   * Two ways to remove a place, and the difference matters.
   *
   * Switching it off takes it out of the dropdowns while every past case that used it still
   * reads correctly - which is what you want for a hospital you have stopped serving.
   * Deleting erases the record, and the server refuses that while any case still points at
   * it, because those cases would then show a blank hospital with no explanation.
   */
  function deletePlace(p) {
    const hard = window.confirm(
      'Delete "' + p.name + '" permanently?\n\n' +
      'OK = delete the record for good (refused if any case still uses it)\n' +
      'Cancel = just switch it off, so old cases keep reading correctly');

    API.del('/api/locations/' + p._id + (hard ? '?hard=1' : ''))
      .then(r => { toast(r.message || 'Done', 'ok'); UI.closeDrawer(); loadPlaces(); })
      .catch(e => toast(e.message, 'error'));
  }

  /* ---------------- attendance ---------------- */
  let bootedAtt = false;
  let attRows = [];

  async function bootAttendance() {
    if (!bootedAtt) {
      bootedAtt = true;
      document.getElementById('attFrom').value = F.today();
      document.getElementById('attTo').value = F.today();
      document.getElementById('attApply').addEventListener('click', loadAttendance);
      document.getElementById('attExcel').addEventListener('click', function () {
        UI.download('/api/reports/movement.xlsx', {
          from: document.getElementById('attFrom').value,
          to: document.getElementById('attTo').value
        }, this);
      });
      document.getElementById('attExport').addEventListener('click', () =>
        UI.csv('ibs-attendance.csv',
          ['Date', 'Runner', 'Code', 'First in', 'Last out', 'Sessions', 'Hours', 'Trips',
           'Start meter', 'End meter', 'Meter km', 'GPS km', 'Gap km', 'Punch in place'],
          attRows.map(r => [r.date, r.runner, r.empCode, F.time(r.firstIn), F.time(r.lastOut), r.sessions, r.hours, r.tripsDone,
            r.startOdo, r.endOdo, r.odoKm, r.gpsKm, r.odoGap === null ? '' : r.odoGap, r.punchInPlace])));
    }
    await loadAttendance();
  }

  async function loadAttendance() {
    const data = await API.get('/api/reports/attendance', {
      from: document.getElementById('attFrom').value,
      to: document.getElementById('attTo').value
    });
    attRows = data.rows;
    const host = document.getElementById('attRows');
    if (!attRows.length) { host.innerHTML = UI.emptyRow(12, 'No punches in this range'); return; }

    host.innerHTML = attRows.map(r =>
      '<tr><td>' + F.date(r.date) + '</td>' +
      '<td>' + F.esc(r.runner) + '</td>' +
      '<td>' + F.time(r.firstIn) + '</td>' +
      '<td>' + (r.open ? '<span class="chip chip--green">still on duty</span>' : F.time(r.lastOut)) + '</td>' +
      '<td class="num">' + r.sessions + '</td>' +
      '<td class="num">' + r.hours + '</td>' +
      '<td class="num">' + r.tripsDone + '</td>' +
      '<td class="num">' + odoCell(r) + '</td>' +
      '<td class="num">' + (r.gpsKm || 0) + '</td>' +
      '<td>' + photoCell(r) + '</td>' +
      '<td style="font-size:12px;color:var(--muted)">' + F.esc(r.punchInPlace) + '</td>' +
      '<td class="rowacts">' + UI.delBtn('attendance', r.id, 'the ' + r.date + ' punch record for ' + (r.runner || 'this runner')) + '</td></tr>').join('');

    UI.wireDelete(host, loadAttendance);
  }

  // Meter kilometres, with the reading range underneath and a flag when the meter and the
  // GPS trail disagree badly. A gap of a few km is normal (GPS smooths corners and loses
  // signal indoors); a gap of 15 km or more is a row someone should ask about.
  function odoCell(r) {
    if (!r.odoKm) return '<span style="color:var(--muted)">-</span>';
    const suspect = r.odoGap !== null && Math.abs(r.odoGap) >= 15;
    return '<b' + (suspect ? ' style="color:var(--crimson)"' : '') + '>' + r.odoKm + '</b>' +
      '<div style="font-size:11px;color:var(--muted);font-weight:400">' + r.startOdo + ' &rarr; ' + r.endOdo + '</div>' +
      (suspect ? '<div style="font-size:11px;color:var(--crimson)">' + (r.odoGap > 0 ? '+' : '') + r.odoGap + ' km vs GPS</div>' : '');
  }

  function photoCell(r) {
    const links = [];
    if (r.startOdoPhoto) links.push(photoLink(r.startOdoPhoto, 'start', r, 'Start of day'));
    if (r.endOdoPhoto) links.push(photoLink(r.endOdoPhoto, 'end', r, 'End of day'));
    return links.length ? '<span style="font-size:12px">' + links.join(' &middot; ') + '</span>'
      : '<span style="font-size:12px;color:var(--muted)">-</span>';
  }

  // A meter photo is checked against the typed reading, so it opens over the table rather
  // than in a new tab - the reader keeps the row in view while comparing.
  function photoLink(url, label, r, when) {
    const caption = when + ' &middot; ' + F.esc(r.runner) + ' &middot; ' + F.date(r.date) +
      (r.startOdo || r.endOdo ? ' &middot; meter ' + (label === 'start' ? r.startOdo : r.endOdo) : '');
    return '<a href="#" onclick="UI.photo(\'' + url + '\', \'' + caption.replace(/'/g, "") + '\'); return false;">' + label + '</a>';
  }

  return { bootRunners, bootPlaces, bootAttendance };
})();
