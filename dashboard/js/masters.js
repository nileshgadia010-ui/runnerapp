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
      '<td>' + F.esc(u.vehicleNo || '-') + '</td>' +
      '<td><span class="chip">' + F.esc(u.role) + '</span></td>' +
      '<td>' + (u.role === 'runner' ? UI.dutyChip(u.dutyState) : '-') + (u.active ? '' : ' <span class="chip chip--red">switched off</span>') + '</td>' +
      '<td>' + (u.lastSeenAt ? F.ago(u.lastSeenAt) : '-') + '</td>' +
      '<td><button class="btn btn--ghost btn--sm" data-edit="' + u.id + '">Edit</button></td>' +
      '</tr>').join('');

    host.querySelectorAll('[data-edit]').forEach(b =>
      b.addEventListener('click', () => staffForm(staff.find(s => String(s.id) === b.dataset.edit))));
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
      '<div class="field"><label>Role</label><select id="sRole">' +
      ['runner', 'coordinator', 'admin'].map(r => '<option value="' + r + '" ' + (u && u.role === r ? 'selected' : '') + '>' + r + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label>Account</label><select id="sActive">' +
      '<option value="1" ' + (!u || u.active ? 'selected' : '') + '>Working</option>' +
      '<option value="0" ' + (u && !u.active ? 'selected' : '') + '>Switched off</option></select></div></div>' +
      rightsBlock(u) +
      '<p style="color:var(--muted);font-size:13px">Runners sign in to the IBS Runner app with this user ID and password.</p>';

    UI.openDrawer(u ? 'Edit ' + u.name : 'Add staff', body,
      '<button class="btn btn--ghost" onclick="UI.closeDrawer()">Cancel</button><button class="btn btn--red" id="sSave">Save</button>');

    document.getElementById('sSave').addEventListener('click', async () => {
      const payload = {
        name: document.getElementById('sName').value.trim(),
        empCode: document.getElementById('sCode').value.trim(),
        phone: document.getElementById('sPhone').value.trim(),
        vehicleNo: document.getElementById('sVehicle').value.trim(),
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
      '<td><button class="btn btn--ghost btn--sm" data-edit="' + p._id + '">Edit</button></td></tr>').join('');

    host.querySelectorAll('[data-edit]').forEach(b =>
      b.addEventListener('click', () => placeForm(places.find(p => String(p._id) === b.dataset.edit))));
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
      '<button class="btn btn--ghost" onclick="UI.closeDrawer()">Cancel</button><button class="btn btn--red" id="pSave">Save place</button>');

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

  // The seven things an account can be allowed to do. Only an admin sees or sends these;
  // for anyone else the server ignores the field entirely.
  const RIGHTS = [
    ['manageStaff',    'Add and edit staff accounts'],
    ['managePlaces',   'Add and edit hospitals and centres'],
    ['createCases',    'Create and edit cases'],
    ['assignTrips',    'Assign, reassign, re-ping and cancel jobs'],
    ['overrideStages', 'Move a stage on the runner\'s behalf'],
    ['editSettings',   'Crossmatch, close and cancel a case'],
    ['viewReports',    'Open the reports and export data']
  ];

  function rightsBlock(u) {
    if (!API.can('manageStaff') || (API.user() || {}).role !== 'admin') return '';

    const current = (u && u.rights) || {};
    // A new account starts from what its role normally gets; the admin then trims or widens.
    const boxes = RIGHTS.map(([key, label]) =>
      '<label class="right-row"><input type="checkbox" data-right="' + key + '" ' +
      (u ? (current[key] ? 'checked' : '') : '') + '><span>' + label + '</span></label>').join('');

    return '<div class="field"><label>What this person can do</label>' +
      '<div class="rights-box" id="sRights">' + boxes + '</div>' +
      '<small style="color:var(--muted);font-size:11px">An admin always has every right, whatever is ticked here. ' +
      'Change the role above and these reset to that role\'s normal set.</small></div>';
  }

  function readRights() {
    const host = document.getElementById('sRights');
    if (!host) return null;
    const out = {};
    host.querySelectorAll('[data-right]').forEach(cb => { out[cb.dataset.right] = cb.checked; });
    return out;
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
    if (!attRows.length) { host.innerHTML = UI.emptyRow(11, 'No punches in this range'); return; }

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
      '<td style="font-size:12px;color:var(--muted)">' + F.esc(r.punchInPlace) + '</td></tr>').join('');
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
    if (r.startOdoPhoto) links.push('<a href="' + r.startOdoPhoto + '" target="_blank">start</a>');
    if (r.endOdoPhoto) links.push('<a href="' + r.endOdoPhoto + '" target="_blank">end</a>');
    return links.length ? '<span style="font-size:12px">' + links.join(' &middot; ') + '</span>'
      : '<span style="font-size:12px;color:var(--muted)">-</span>';
  }

  return { bootRunners, bootPlaces, bootAttendance };
})();
