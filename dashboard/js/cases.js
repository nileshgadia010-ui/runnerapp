/* Cases - the desk's main working screen: raise a case, assign a runner,
   run the crossmatch, send the blood out. */
const Cases = (function () {
  let rows = [];
  let hospitals = [];
  let centres = [];
  let allPlaces = [];
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
    allPlaces = all;
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
    const list = live.slice().sort((a, b) => (order[a.dutyState] - order[b.dutyState]) || (a.jobsInHand - b.jobsInHand));

    // A runner already carrying a job can still be given the next one - it lines up behind
    // what he is doing and rings when its turn comes. That is how a real shift works: the
    // desk hands out the next errand while he is still on the road. Only a runner who is off
    // duty, or already holding the maximum, cannot take another.
    const MAX = 3;
    const canTake = r => r.dutyState !== 'OFF_DUTY' && (r.jobsInHand || 0) < MAX;

    const body = (list.length
      ? list.map(r => {
          const ok = canTake(r);
          const held = r.jobsInHand || 0;
          const waiting = r.waiting || 0;

          const line = !ok && r.dutyState === 'OFF_DUTY' ? 'Not punched in'
            : !ok ? 'Already holding ' + held + ' jobs'
            : held === 0 ? 'Free' + (r.lastSeenAt ? ' &middot; last ping ' + F.ago(r.lastSeenAt) : '')
            : r.dutyState === 'BREAK' ? 'On break'
            : 'On ' + (r.trip ? r.trip.tripNo : 'a job') + (waiting ? ' &middot; ' + waiting + ' already waiting' : '');

          const badge = held
            ? '<span class="load" title="Jobs in hand">' + held + '</span>'
            : '';

          return '<div class="runner-row" style="margin-bottom:8px;' + (ok ? '' : 'opacity:.5;') + '" ' +
            (ok ? 'data-pick="' + r.id + '"' : '') + '>' +
            '<div class="runner-row__av">' + F.initials(r.name) + '</div>' +
            '<div class="runner-row__meta"><b>' + F.esc(r.name) + '</b><span>' + line + '</span></div>' +
            '<div class="runner-row__right">' + badge + UI.dutyChip(r.dutyState) + '</div></div>';
        }).join('')
      : UI.empty('No runners added yet')) +
      '<p style="color:var(--muted);font-size:12px;margin-top:14px">' +
      'A runner who is already out can still be given the next job - it waits behind the one ' +
      'he is on and his phone rings when he finishes.</p>';

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

  // The four reasons a runner gets sent out. Blood is the two-leg case with a crossmatch in
  // the middle; the rest are single errands. IBS runners are not phlebotomists - the hospital
  // staff draw the sample and hand it over - so most jobs need a place and a reason, not a
  // patient. The form asks only for what the chosen type actually needs.
  const JOB_TYPES = [
    { key: 'BLOOD',             label: 'Blood case',      note: 'Sample out, crossmatch, units back' },
    { key: 'COLLECTION_SAMPLE', label: 'Collect sample',  note: 'One pickup, no crossmatch' },
    { key: 'PAYMENT_COLLECT',   label: 'Collect payment', note: 'Bring money back' },
    { key: 'PACKAGE_DELIVER',   label: 'Deliver package', note: 'Carry a parcel across' }
  ];

  function openForm() {
    const opts = (list, placeholder) =>
      (placeholder ? '<option value="">-- ' + placeholder + ' --</option>' : '') +
      list.map(p => '<option value="' + p._id + '">' + F.esc(p.name) + (p.area ? ' - ' + F.esc(p.area) : '') + '</option>').join('');

    const typeBar = '<div class="jobtypes" id="cTypeBar">' + JOB_TYPES.map((t, i) =>
      '<button type="button" class="jobtype' + (i === 0 ? ' is-on' : '') + '" data-type="' + t.key + '">' +
      '<b>' + t.label + '</b><span>' + t.note + '</span></button>').join('') + '</div>';

    const bloodBlock =
      '<div data-block="BLOOD">' +
      '<div class="grid-2">' +
      '<div class="field"><label>Patient name</label><input id="cName" autofocus></div>' +
      '<div class="field"><label>Age</label><input id="cAge" placeholder="e.g. 34 Y"></div></div>' +
      '<div class="grid-3">' +
      '<div class="field"><label>Gender</label><select id="cGender"><option value="">--</option><option>Male</option><option>Female</option><option>Other</option></select></div>' +
      '<div class="field"><label>Blood group</label><select id="cGroup"><option value="">--</option>' +
      ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map(g => '<option>' + g + '</option>').join('') + '</select></div>' +
      '<div class="field"><label>Component</label><select id="cComp">' +
      ['PCV', 'FFP', 'PC', 'WB', 'SDP', 'RDP', 'CRYO', 'PRBC'].map(g => '<option>' + g + '</option>').join('') + '</select></div></div>' +
      '<div class="field"><label>Units needed</label><input id="cUnits" type="number" min="1" value="1"></div>' +
      '<div class="field"><label>Hospital (where the patient is)</label><select id="cHospital">' + opts(hospitals) + '</select></div>' +
      '<div class="field"><label>Blood centre (where the sample goes)</label><select id="cCentre">' + opts(centres) + '</select></div>' +
      '<div class="grid-2">' +
      '<div class="field"><label>Ward / bed</label><input id="cWard"></div>' +
      '<div class="field"><label>Treating doctor</label><input id="cDoctor"></div></div>' +
      '</div>';

    const errandBlock =
      '<div data-block="ERRAND" hidden>' +
      '<div class="field"><label>Reference for the runner</label>' +
      '<input id="cRef" placeholder="Slip number, invoice number, parcel number">' +
      '<small style="color:var(--muted);font-size:11px">This is what the runner sees on his phone instead of a patient name.</small></div>' +
      '<div class="field"><label>Pick up from</label><select id="cFrom">' + opts(allPlaces, 'choose a place') + '</select></div>' +
      '<div class="field"><label>Take it to</label><select id="cTo">' + opts(allPlaces, 'choose a place') + '</select></div>' +
      '<div data-sub="PAYMENT_COLLECT" hidden>' +
      '<div class="grid-2">' +
      '<div class="field"><label>Amount to collect</label><input id="cAmount" type="number" min="0" placeholder="0"></div>' +
      '<div class="field"><label>Against</label><input id="cAgainst" placeholder="Invoice, bill number"></div></div></div>' +
      '<div data-sub="PACKAGE_DELIVER" hidden>' +
      '<div class="field"><label>What is in the package</label><input id="cPackage" placeholder="Reports, kit, consumables"></div></div>' +
      '<div class="field"><label>Who to meet there</label><input id="cAttName2" placeholder="Name at the counter"></div>' +
      '</div>';

    const commonBlock =
      '<div class="field"><label>Priority</label><select id="cPriority"><option value="ROUTINE">Routine</option><option value="URGENT">Urgent</option><option value="EMERGENCY">Emergency</option></select></div>' +
      '<div class="grid-2" data-block="BLOOD">' +
      '<div class="field"><label>Attendant name</label><input id="cAttName"></div>' +
      '<div class="field"><label>Attendant phone</label><input id="cAttPhone"></div></div>' +
      '<div class="field"><label>Phone to call there</label><input id="cPhone2" placeholder="Optional" hidden></div>' +
      '<div class="field"><label>Remarks for the runner</label><textarea id="cRemarks" placeholder="Gate number, floor, who to meet"></textarea></div>';

    UI.openDrawer('New job', typeBar + bloodBlock + errandBlock + commonBlock,
      '<button class="btn btn--ghost" onclick="UI.closeDrawer()">Cancel</button>' +
      '<button class="btn btn--red" id="caseSave">Save</button>' +
      '<button class="btn" id="caseSaveAssign">Save and send runner</button>');

    let jobType = 'BLOOD';

    function showFor(type) {
      jobType = type;
      const blood = type === 'BLOOD';
      document.querySelectorAll('[data-block="BLOOD"]').forEach(el => { el.hidden = !blood; });
      document.querySelectorAll('[data-block="ERRAND"]').forEach(el => { el.hidden = blood; });
      document.querySelectorAll('[data-sub]').forEach(el => { el.hidden = el.dataset.sub !== type; });
      document.getElementById('cPhone2').parentNode.hidden = blood;
      document.querySelectorAll('.jobtype').forEach(b => b.classList.toggle('is-on', b.dataset.type === type));
    }

    document.getElementById('cTypeBar').addEventListener('click', e => {
      const b = e.target.closest('.jobtype');
      if (b) showFor(b.dataset.type);
    });

    const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };

    const collect = () => {
      const base = {
        jobType,
        priority: val('cPriority'),
        remarks: val('cRemarks')
      };
      if (jobType === 'BLOOD') {
        return Object.assign(base, {
          patientName: val('cName'),
          patientAge: val('cAge'),
          patientGender: val('cGender'),
          bloodGroup: val('cGroup'),
          component: val('cComp'),
          unitsRequested: val('cUnits'),
          hospital: val('cHospital'),
          bloodCenter: val('cCentre'),
          wardBed: val('cWard'),
          doctorName: val('cDoctor'),
          attendantName: val('cAttName'),
          attendantPhone: val('cAttPhone')
        });
      }
      return Object.assign(base, {
        reference: val('cRef'),
        fromLocation: val('cFrom'),
        toLocation: val('cTo'),
        amount: val('cAmount'),
        amountAgainst: val('cAgainst'),
        packageDetails: val('cPackage'),
        attendantName: val('cAttName2'),
        attendantPhone: val('cPhone2')
      });
    };

    // The first trip a job needs. A blood case starts by fetching the sample; an errand is
    // the single trip itself.
    const firstTrip = t => (t === 'BLOOD' ? 'SAMPLE_PICKUP' : t);

    const save = async andAssign => {
      const payload = collect();
      try {
        const kase = await API.post('/api/cases', payload);
        toast(kase.caseNo + ' created', 'ok');
        UI.closeDrawer();
        await load();
        if (andAssign) pickRunner(rid => assign(kase._id, firstTrip(payload.jobType), rid));
      } catch (e) { toast(e.message, 'error'); }
    };

    document.getElementById('caseSave').addEventListener('click', () => save(false));
    document.getElementById('caseSaveAssign').addEventListener('click', () => save(true));
    showFor('BLOOD');
  }

  async function openCase(id) {
    const c = await API.get('/api/cases/' + id);
    const p = c.tat.parts;

    const legs = (c.trips || []).map(t =>
      '<div class="job" data-trip="' + t._id + '" style="margin-bottom:8px">' +
      '<div class="job__top"><span class="job__name">' + F.jobTitle(t.type) + '</span>' +
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
      // Escape each value on its own, then join with the separator. Joining first and
      // escaping the whole string turns the separator's own & into &amp;, which is why the
      // drawer was reading "male &middot; B+ &middot; FFP" instead of showing the dots.
      [c.patientAge, c.patientGender, c.bloodGroup, c.component, c.unitsRequested + ' unit(s)']
        .filter(Boolean).map(F.esc).join(' &middot; ') + '</p>' +
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
