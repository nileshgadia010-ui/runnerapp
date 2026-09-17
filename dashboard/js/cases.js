/* Cases - the desk's main working screen: raise a case, assign a runner,
   run the crossmatch, send the blood out. */
const Cases = (function () {
  let rows = [];
  let hospitals = [];
  let centres = [];
  let booted = false;

  async function boot() {
    if (!booted) {
      booted = true;
      document.getElementById('newCaseBtn').addEventListener('click', () => openForm());
      document.getElementById('caseFilter').addEventListener('change', load);
      let t;
      document.getElementById('caseSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 350); });
    }
    await loadPlaces();
    await load();
  }

  async function loadPlaces() {
    const all = await API.get('/api/locations');
    hospitals = all.filter(p => p.type !== 'BLOOD_CENTER');
    centres = all.filter(p => p.type === 'BLOOD_CENTER');
  }

  async function load() {
    const filter = document.getElementById('caseFilter').value;
    const params = { search: document.getElementById('caseSearch').value.trim() };
    if (filter === 'open') params.open = 1;
    else if (filter !== 'all') params.status = filter;

    rows = await API.get('/api/cases', params);
    paint();
  }

  function actionFor(c) {
    if (c.status === 'NEW') return '<button class="btn btn--red btn--sm" data-act="assign-sample" data-id="' + c._id + '">Send runner</button>';
    if (c.status === 'SAMPLE_AT_CENTER') return '<button class="btn btn--blue btn--sm" data-act="xm-start" data-id="' + c._id + '">Start crossmatch</button>';
    if (c.status === 'CROSSMATCH') return '<button class="btn btn--blue btn--sm" data-act="xm-done" data-id="' + c._id + '">Crossmatch result</button>';
    if (c.status === 'READY') return '<button class="btn btn--red btn--sm" data-act="assign-delivery" data-id="' + c._id + '">Send blood</button>';
    if (c.status === 'DELIVERED') return '<button class="btn btn--ghost btn--sm" data-act="close" data-id="' + c._id + '">Close case</button>';
    return '<button class="btn btn--ghost btn--sm" data-act="view" data-id="' + c._id + '">Open</button>';
  }

  function paint() {
    const host = document.getElementById('caseRows');
    if (!rows.length) { host.innerHTML = UI.emptyRow(11, 'No cases here yet'); return; }

    host.innerHTML = rows.map(c => {
      const p = c.tat.parts;
      return '<tr data-id="' + c._id + '">' +
        '<td><span class="mono">' + F.esc(c.caseNo) + '</span><div style="font-size:11px;color:var(--muted)">' + F.dateTime(c.createdAt) + '</div></td>' +
        '<td><b>' + F.esc(c.patientName) + '</b> ' + UI.priorityChip(c.priority) + '</td>' +
        '<td>' + F.esc(c.hospital ? c.hospital.name : '') + '</td>' +
        '<td>' + F.esc(c.bloodGroup || '-') + ' ' + F.esc(c.component || '') + '</td>' +
        '<td class="num">' + (c.unitsRequested || 0) + '</td>' +
        '<td><span class="chip ' + (c.status === 'CANCELLED' ? 'chip--red' : ['DELIVERED', 'CLOSED'].includes(c.status) ? 'chip--green' : 'chip--blue') + '">' + F.caseLabel(c.status) + '</span></td>' +
        UI.tatCell(p.samplePickup.value, p.samplePickup.grade) +
        UI.tatCell(p.crossmatch.value, p.crossmatch.grade) +
        UI.tatCell(p.delivery.value, p.delivery.grade) +
        UI.tatCell(p.total.value, p.total.grade) +
        '<td>' + actionFor(c) + '</td></tr>';
    }).join('');

    host.querySelectorAll('button[data-act]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      act(b.dataset.act, b.dataset.id);
    }));
    host.querySelectorAll('tr').forEach(tr => tr.addEventListener('click', () => openCase(tr.dataset.id)));
  }

  async function act(action, id) {
    try {
      if (action === 'assign-sample') return pickRunner(rid => assign(id, 'SAMPLE_PICKUP', rid));
      if (action === 'assign-delivery') return pickRunner(rid => assign(id, 'BLOOD_DELIVERY', rid));
      if (action === 'xm-start') { await API.post('/api/cases/' + id + '/crossmatch/start'); toast('Crossmatch clock started', 'ok'); return load(); }
      if (action === 'xm-done') return crossmatchForm(id);
      if (action === 'close') { await API.post('/api/cases/' + id + '/close'); toast('Case closed', 'ok'); return load(); }
      if (action === 'view') return openCase(id);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function assign(caseId, type, runnerId) {
    try {
      await API.post('/api/trips/assign', { caseId, type, runnerId });
      toast('Job sent - the runner phone is ringing now', 'ok');
      UI.closeDrawer();
      load();
      Live.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  // Runner picker. Free runners come first; a busy runner cannot be picked.
  async function pickRunner(onPick) {
    const live = await API.get('/api/users/live');
    const order = { AVAILABLE: 0, BREAK: 1, ON_TRIP: 2, OFF_DUTY: 3 };
    const list = live.slice().sort((a, b) => order[a.dutyState] - order[b.dutyState]);

    const body = list.length
      ? list.map(r => {
          const free = r.dutyState === 'AVAILABLE';
          return '<div class="runner-row" style="margin-bottom:8px;' + (free ? '' : 'opacity:.55;') + '" ' +
            (free ? 'data-pick="' + r.id + '"' : '') + '>' +
            '<div class="runner-row__av">' + F.initials(r.name) + '</div>' +
            '<div class="runner-row__meta"><b>' + F.esc(r.name) + '</b><span>' +
            (r.trip ? 'Busy on ' + r.trip.tripNo : r.dutyState === 'AVAILABLE' ? 'Free' + (r.lastSeenAt ? ' &middot; last ping ' + F.ago(r.lastSeenAt) : '') : r.dutyState === 'BREAK' ? 'On break' : 'Not punched in') +
            '</span></div>' + UI.dutyChip(r.dutyState) + '</div>';
        }).join('')
      : UI.empty('No runners added yet');

    UI.openDrawer('Pick a runner', body, '');
    document.querySelectorAll('[data-pick]').forEach(el => el.addEventListener('click', () => onPick(el.dataset.pick)));
  }

  function crossmatchForm(id) {
    const body =
      '<div class="field"><label>Result</label><select id="xmResult">' +
      '<option value="COMPATIBLE">Compatible - units ready</option>' +
      '<option value="PARTIAL">Partly compatible</option>' +
      '<option value="INCOMPATIBLE">Not compatible - fresh sample needed</option></select></div>' +
      '<div class="grid-2"><div class="field"><label>Units ready</label><input id="xmUnits" type="number" min="0" value="1"></div>' +
      '<div class="field"><label>Bag numbers</label><input id="xmBags" placeholder="e.g. B-2291, B-2292"></div></div>' +
      '<div class="field"><label>Remarks</label><textarea id="xmRemarks"></textarea></div>';

    UI.openDrawer('Crossmatch result', body, '<button class="btn btn--ghost" onclick="UI.closeDrawer()">Cancel</button><button class="btn btn--blue" id="xmSave">Save result</button>');

    document.getElementById('xmSave').addEventListener('click', async () => {
      try {
        await API.post('/api/cases/' + id + '/crossmatch/done', {
          result: document.getElementById('xmResult').value,
          unitsReady: document.getElementById('xmUnits').value,
          bagNumbers: document.getElementById('xmBags').value,
          remarks: document.getElementById('xmRemarks').value
        });
        toast('Crossmatch saved', 'ok');
        UI.closeDrawer();
        load();
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  function openForm() {
    const opts = list => list.map(p => '<option value="' + p._id + '">' + F.esc(p.name) + (p.area ? ' - ' + F.esc(p.area) : '') + '</option>').join('');
    const body =
      '<div class="grid-2">' +
      '<div class="field"><label>Patient name</label><input id="cName" autofocus></div>' +
      '<div class="field"><label>Age</label><input id="cAge" placeholder="e.g. 34 Y"></div></div>' +
      '<div class="grid-3">' +
      '<div class="field"><label>Gender</label><select id="cGender"><option value="">--</option><option>Male</option><option>Female</option><option>Other</option></select></div>' +
      '<div class="field"><label>Blood group</label><select id="cGroup"><option value="">--</option>' +
      ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map(g => '<option>' + g + '</option>').join('') + '</select></div>' +
      '<div class="field"><label>Component</label><select id="cComp">' +
      ['PCV', 'FFP', 'PC', 'WB', 'SDP', 'RDP', 'CRYO', 'PRBC'].map(g => '<option>' + g + '</option>').join('') + '</select></div></div>' +
      '<div class="grid-2">' +
      '<div class="field"><label>Units needed</label><input id="cUnits" type="number" min="1" value="1"></div>' +
      '<div class="field"><label>Priority</label><select id="cPriority"><option value="ROUTINE">Routine</option><option value="URGENT">Urgent</option><option value="EMERGENCY">Emergency</option></select></div></div>' +
      '<div class="field"><label>Hospital (where the patient is)</label><select id="cHospital">' + opts(hospitals) + '</select></div>' +
      '<div class="field"><label>Blood centre (where the sample goes)</label><select id="cCentre">' + opts(centres) + '</select></div>' +
      '<div class="grid-2">' +
      '<div class="field"><label>Ward / bed</label><input id="cWard"></div>' +
      '<div class="field"><label>Treating doctor</label><input id="cDoctor"></div></div>' +
      '<div class="grid-2">' +
      '<div class="field"><label>Attendant name</label><input id="cAttName"></div>' +
      '<div class="field"><label>Attendant phone</label><input id="cAttPhone"></div></div>' +
      '<div class="field"><label>Remarks for the runner</label><textarea id="cRemarks" placeholder="Gate number, floor, who to meet"></textarea></div>';

    UI.openDrawer('New case', body,
      '<button class="btn btn--ghost" onclick="UI.closeDrawer()">Cancel</button>' +
      '<button class="btn btn--red" id="caseSave">Save case</button>' +
      '<button class="btn" id="caseSaveAssign">Save and send runner</button>');

    const collect = () => ({
      patientName: document.getElementById('cName').value.trim(),
      patientAge: document.getElementById('cAge').value.trim(),
      patientGender: document.getElementById('cGender').value,
      bloodGroup: document.getElementById('cGroup').value,
      component: document.getElementById('cComp').value,
      unitsRequested: document.getElementById('cUnits').value,
      priority: document.getElementById('cPriority').value,
      hospital: document.getElementById('cHospital').value,
      bloodCenter: document.getElementById('cCentre').value,
      wardBed: document.getElementById('cWard').value.trim(),
      doctorName: document.getElementById('cDoctor').value.trim(),
      attendantName: document.getElementById('cAttName').value.trim(),
      attendantPhone: document.getElementById('cAttPhone').value.trim(),
      remarks: document.getElementById('cRemarks').value.trim()
    });

    const save = async andAssign => {
      const payload = collect();
      if (!payload.patientName) return toast('Enter the patient name', 'error');
      if (!payload.hospital || !payload.bloodCenter) return toast('Add a hospital and a blood centre first', 'error');
      try {
        const kase = await API.post('/api/cases', payload);
        toast('Case ' + kase.caseNo + ' created', 'ok');
        UI.closeDrawer();
        await load();
        if (andAssign) pickRunner(rid => assign(kase._id, 'SAMPLE_PICKUP', rid));
      } catch (e) { toast(e.message, 'error'); }
    };

    document.getElementById('caseSave').addEventListener('click', () => save(false));
    document.getElementById('caseSaveAssign').addEventListener('click', () => save(true));
  }

  async function openCase(id) {
    const c = await API.get('/api/cases/' + id);
    const p = c.tat.parts;

    const legs = (c.trips || []).map(t =>
      '<div class="job" data-trip="' + t._id + '" style="margin-bottom:8px">' +
      '<div class="job__top"><span class="job__name">' + (t.type === 'SAMPLE_PICKUP' ? 'Sample pickup' : 'Blood delivery') + '</span>' +
      '<span class="job__no mono">' + F.esc(t.tripNo) + '</span></div>' +
      '<div class="job__line">' + F.esc(t.runner ? t.runner.name : 'Unassigned') + ' &middot; ' + F.stageLabel(t.type, t.status) + '</div>' +
      '<div class="job__line">Assigned ' + F.dateTime(t.assignedAt) + (t.completedAt ? ' &middot; finished ' + F.dateTime(t.completedAt) : '') + '</div>' +
      '</div>').join('') || UI.empty('No runner sent yet');

    const body =
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">' +
      '<span class="chip chip--ink mono">' + F.esc(c.caseNo) + '</span>' + UI.priorityChip(c.priority) +
      '<span class="chip chip--blue">' + F.caseLabel(c.status) + '</span></div>' +
      '<h3 style="font-size:16px">' + F.esc(c.patientName) + '</h3>' +
      '<p style="color:var(--muted);margin-top:2px">' +
      F.esc([c.patientAge, c.patientGender, c.bloodGroup, c.component, c.unitsRequested + ' unit(s)'].filter(Boolean).join(' &middot; ')) + '</p>' +
      '<div class="grid-2" style="margin:12px 0">' +
      '<div><div style="font-size:12px;color:var(--muted)">Hospital</div><b>' + F.esc(c.hospital && c.hospital.name) + '</b><div style="color:var(--muted)">' + F.esc(c.wardBed || '') + '</div></div>' +
      '<div><div style="font-size:12px;color:var(--muted)">Blood centre</div><b>' + F.esc(c.bloodCenter && c.bloodCenter.name) + '</b></div></div>' +
      (c.attendantPhone ? '<p>Attendant: ' + F.esc(c.attendantName || '') + ' &middot; ' + F.esc(c.attendantPhone) + '</p>' : '') +
      (c.remarks ? '<p style="color:var(--muted)">' + F.esc(c.remarks) + '</p>' : '') +
      '<h4 style="margin:16px 0 6px">Time taken</h4><div class="grid-3">' +
      [['To assign', p.toAssign], ['Sample leg', p.samplePickup], ['Crossmatch', p.crossmatch], ['Delivery leg', p.delivery], ['Request to bag', p.total]]
        .map(([l, part]) => '<div style="padding:8px 0"><div style="font-size:12px;color:var(--muted)">' + l + '</div>' + UI.clockChip(part.value, part.grade) + '</div>').join('') +
      '</div>' +
      (c.crossmatch && c.crossmatch.completedAt
        ? '<h4 style="margin:16px 0 6px">Crossmatch</h4><p>' + F.esc(c.crossmatch.result) + ' &middot; ' + (c.crossmatch.unitsReady || 0) + ' unit(s)' +
          (c.crossmatch.bagNumbers ? ' &middot; bags ' + F.esc(c.crossmatch.bagNumbers) : '') + '</p>' : '') +
      '<h4 style="margin:18px 0 8px">Runner legs</h4>' + legs;

    UI.openDrawer('Case ' + c.caseNo, body, actionFor(c).replace('btn--sm', ''));

    document.querySelectorAll('#drawerBody .job').forEach(el =>
      el.addEventListener('click', () => Live.openTrip(el.dataset.trip)));
    const btn = document.querySelector('#drawerFoot button[data-act]');
    if (btn) btn.addEventListener('click', () => act(btn.dataset.act, btn.dataset.id));
  }

  return { boot, load, pickRunner, openCase };
})();
