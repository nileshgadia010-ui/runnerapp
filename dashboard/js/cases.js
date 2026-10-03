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

  // The first leg a case needs, by what kind of job it is.
  //
  // A blood case starts by fetching the sample; the other three are single errands that ARE
  // their own leg. Sending every case out as a sample pickup - which is what this used to do
  // - made the dispatcher look for a hospital and a blood centre on a case that has neither,
  // and the assign simply refused.
  const FIRST_LEG = {
    BLOOD: 'SAMPLE_PICKUP',
    COLLECTION_SAMPLE: 'COLLECTION_SAMPLE',
    PAYMENT_COLLECT: 'PAYMENT_COLLECT',
    PACKAGE_DELIVER: 'PACKAGE_DELIVER'
  };
  const firstLeg = c => FIRST_LEG[c.jobType] || 'SAMPLE_PICKUP';

  const SEND_LABEL = {
    BLOOD: 'Send for sample',
    COLLECTION_SAMPLE: 'Send runner',
    PAYMENT_COLLECT: 'Send to collect',
    PACKAGE_DELIVER: 'Send with package'
  };

  function actionFor(c) {
    if (c.status === 'NEW') return '<button class="btn btn--red btn--sm" data-act="assign-first"' +
      ' data-id="' + c._id + '" data-leg="' + firstLeg(c) + '">' +
      F.esc(SEND_LABEL[c.jobType] || 'Send runner') + '</button>';
    if (c.status === 'SAMPLE_AT_CENTER') return '<button class="btn btn--blue btn--sm" data-act="xm-start" data-id="' + c._id + '">Start crossmatch</button>';
    if (c.status === 'CROSSMATCH') return '<button class="btn btn--blue btn--sm" data-act="xm-done" data-id="' + c._id + '">Crossmatch result</button>';
    if (c.status === 'READY') return '<button class="btn btn--red btn--sm" data-act="assign-delivery" data-id="' + c._id + '">Send blood</button>';
    if (c.status === 'DELIVERED') return '<button class="btn btn--ghost btn--sm" data-act="close" data-id="' + c._id + '">Close case</button>';

    // A case with a runner on it used to offer nothing but "Open", so changing your mind
    // about a job already sent out meant hunting through a drawer for the buttons. The two
    // things the desk actually does at this point now sit on the row.
    const t = runningTrip(c);
    if (t) {
      return '<button class="btn btn--ghost btn--sm" data-act="swap" data-trip="' + t._id + '">Change runner</button>' +
             (API.can('overrideStages')
               ? '<button class="btn btn--ghost btn--sm" data-act="finish" data-id="' + c._id + '" data-trip="' + t._id + '">Complete</button>'
               : '') +
             '<button class="btn btn--ghost btn--sm" data-act="stop" data-trip="' + t._id + '"' +
             ' style="color:var(--crimson)">Cancel job</button>';
    }
    return '<button class="btn btn--ghost btn--sm" data-act="view" data-id="' + c._id + '">Open</button>';
  }

  const RUNNING = ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE_PICKUP', 'AT_PICKUP', 'PICKED', 'EN_ROUTE_DROP', 'AT_DROP'];

  /** The job actually out on the road for this case, whichever leg it belongs to. */
  function runningTrip(c) {
    return [c.sampleTrip, c.deliveryTrip, c.jobTrip]
      .filter(t => t && RUNNING.includes(t.status))[0] || null;
  }

  const isBlood = c => !c.jobType || c.jobType === 'BLOOD';

  /*
   * The Stage column.
   *
   * With a runner out, the case status alone ("Runner on the way") said the same thing for a
   * job just assigned and a job already picked up - three package jobs on one runner looked
   * identical. So a running case shows the runner's real stage and his name, and a case closed
   * from the portal says so right there in the list.
   */
  function statusCell(c) {
    const t = runningTrip(c);
    if (t) {
      return '<span class="chip chip--blue">' + F.stageLabel(t.type, t.status) + '</span>' +
        (t.runner ? '<div style="font-size:11px;color:var(--muted);margin-top:3px">' + F.esc(t.runner.name || '') + '</div>' : '');
    }
    const cls = c.status === 'CANCELLED' ? 'chip--red'
      : ['DELIVERED', 'CLOSED', 'JOB_DONE'].includes(c.status) ? 'chip--green' : 'chip--blue';
    const last = [c.jobTrip, c.deliveryTrip, c.sampleTrip].filter(Boolean)[0];
    const portal = (c.completion && c.completion.via === 'PORTAL') ||
      (last && last.closedVia === 'PORTAL' && last.status === 'COMPLETED');
    return '<span class="chip ' + cls + '">' + F.caseLabel(c.status) + '</span>' +
      (portal ? '<div class="portal-tag">Portal</div>' : '');
  }

  /**
   * What goes in the Hospital column.
   *
   * A blood case has a hospital. A single errand has a from and a to instead, and rendering
   * one down the blood columns left the row blank with a stray "- PCV" beside it - which
   * reads as a broken record rather than as a different kind of job.
   */
  function placeOf(c) {
    if (isBlood(c)) return c.hospital ? c.hospital.name : '';
    const from = c.fromLocation && c.fromLocation.name;
    const to = c.toLocation && c.toLocation.name;
    return [from, to].filter(Boolean).join(' → ');
  }

  function paint() {
    const host = document.getElementById('caseRows');
    if (!rows.length) { host.innerHTML = UI.emptyRow(11, 'No cases here yet'); return; }

    host.innerHTML = rows.map(c => {
      const p = c.tat.parts;
      return '<tr data-id="' + c._id + '">' +
        '<td><span class="mono">' + F.esc(c.caseNo) + '</span><div style="font-size:11px;color:var(--muted)">' + F.dateTime(c.createdAt) + '</div></td>' +
        '<td><b>' + F.esc(c.patientName || c.reference || '-') + '</b> ' + UI.priorityChip(c.priority) +
          (isBlood(c) ? '' : '<div style="font-size:11px;color:var(--muted)">' + F.jobTitle(c.jobType) + '</div>') + '</td>' +
        '<td>' + F.esc(placeOf(c)) + '</td>' +
        '<td>' + (isBlood(c) ? F.esc(c.bloodGroup || '-') + ' ' + F.esc(c.component || '')
          : '<span style="color:var(--muted)">-</span>') + '</td>' +
        '<td class="num">' + (isBlood(c) ? (c.unitsRequested || 0) : '') + '</td>' +
        '<td>' + statusCell(c) + '</td>' +
        UI.tatCell(p.samplePickup.value, p.samplePickup.grade) +
        UI.tatCell(p.crossmatch.value, p.crossmatch.grade) +
        UI.tatCell(p.delivery.value, p.delivery.grade) +
        UI.tatCell(p.total.value, p.total.grade) +
        '<td class="rowacts">' + actionFor(c) +
        (API.can('editRecords') && !['CANCELLED', 'CLOSED'].includes(c.status)
          ? '<button class="btn btn--ghost btn--sm" data-act="edit" data-id="' + c._id + '">Edit</button>' : '') +
        UI.delBtn('case', c._id, 'case ' + (c.caseNo || '')) + '</td></tr>';
    }).join('');

    host.querySelectorAll('button[data-act]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      act(b.dataset.act, b.dataset.id, b.dataset.leg, b.dataset.trip);
    }));
    host.querySelectorAll('tr').forEach(tr => tr.addEventListener('click', () => openCase(tr.dataset.id)));
    UI.wireDelete(host, load);
  }

  async function act(action, id, leg, trip) {
    try {
      if (action === 'swap') return pickRunner(rid => handOver(trip, rid));
      if (action === 'finish') return finish(id, trip);
      if (action === 'edit') return editCase(id);
      if (action === 'stop') return stopTrip(trip);
      if (action === 'assign-first') return pickRunner(rid => assign(id, leg || 'SAMPLE_PICKUP', rid));
      if (action === 'assign-delivery') return pickRunner(rid => assign(id, 'BLOOD_DELIVERY', rid));
      if (action === 'xm-start') { await API.post('/api/cases/' + id + '/crossmatch/start'); toast('Crossmatch clock started', 'ok'); return load(); }
      if (action === 'xm-done') return crossmatchForm(id);
      if (action === 'close') { await API.post('/api/cases/' + id + '/close'); toast('Case closed', 'ok'); return load(); }
      if (action === 'view') return openCase(id);
    } catch (e) { toast(e.message, 'error'); }
  }

  /** Complete from the portal - the running job if there is one, else the case itself. */
  async function finish(caseId, tripId) {
    try {
      if (tripId) {
        const trip = await API.get('/api/trips/' + tripId);
        return Complete.open({ trip, onDone: () => { load(); Live.refresh(); } });
      }
      const kase = await API.get('/api/cases/' + caseId);
      Complete.open({ kase, onDone: () => { load(); Live.refresh(); } });
    } catch (e) { toast(e.message, 'error'); }
  }

  async function editCase(id) {
    try {
      const kase = await API.get('/api/cases/' + id);
      openForm(kase);
    } catch (e) { toast(e.message, 'error'); }
  }

  /** Takes the job off one runner and gives it to another, in one step. */
  async function handOver(tripId, runnerId) {
    try {
      await API.post('/api/trips/' + tripId + '/reassign', { runnerId });
      toast('Handed over - the new runner phone is ringing', 'ok');
      UI.closeDrawer();
      load();
      Live.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  /**
   * Calls the job off. The reason is required because it is the only thing that tells the
   * next person why a case went back to waiting.
   */
  async function stopTrip(tripId) {
    const reason = prompt('Why is this job being cancelled?\n\nThe runner phone will stop asking for it.');
    if (reason === null) return;
    if (!reason.trim()) { toast('Write a reason so the desk knows why', 'error'); return; }
    try {
      await API.post('/api/trips/' + tripId + '/cancel', { reason: reason.trim() });
      toast('Job cancelled. The case is waiting to be assigned again.', 'ok');
      load();
      Live.refresh();
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
    const MAX = 10;
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
      'A runner who is already out can still be given more jobs. His phone rings straight away ' +
      'and every job shows in his list, so he can choose which one to do first.</p>';

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

  function openForm(existing) {
    const editing = !!(existing && existing._id);
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
      '<div class="grid-2">' +
      '<div class="field"><label>What is in the package</label><input id="cPackage" placeholder="Blood bottles, reports, kit"></div>' +
      '<div class="field"><label>How many bottles / boxes</label><input id="cBottles" type="number" min="0" value="1"></div></div></div>' +
      '<div class="field"><label>Who to meet there</label><input id="cAttName2" placeholder="Name at the counter"></div>' +
      '</div>';

    const commonBlock =
      '<div class="field"><label>Priority</label><select id="cPriority"><option value="ROUTINE">Routine</option><option value="URGENT">Urgent</option><option value="EMERGENCY">Emergency</option></select></div>' +
      '<div class="grid-2" data-block="BLOOD">' +
      '<div class="field"><label>Attendant name</label><input id="cAttName"></div>' +
      '<div class="field"><label>Attendant phone</label><input id="cAttPhone"></div></div>' +
      '<div class="field"><label>Phone to call there</label><input id="cPhone2" placeholder="Optional" hidden></div>' +
      '<div class="field"><label>Remarks for the runner</label><textarea id="cRemarks" placeholder="Gate number, floor, who to meet"></textarea></div>';

    UI.openDrawer(editing ? 'Edit case ' + existing.caseNo : 'New job',
      (editing && existing.status !== 'NEW'
        ? '<p class="cp-note">A runner has already been sent, so the job type cannot change. ' +
          'If he has not picked up yet, a changed address goes to his phone too.</p>' : '') +
      typeBar + bloodBlock + errandBlock + commonBlock,
      '<button class="btn btn--ghost" onclick="UI.closeDrawer()">Cancel</button>' +
      (editing
        ? '<button class="btn btn--red" id="caseUpdate">Save changes</button>'
        : '<button class="btn btn--red" id="caseSave">Save</button>' +
          '<button class="btn" id="caseSaveAssign">Save and send runner</button>'));

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
        unitsRequested: jobType === 'PACKAGE_DELIVER' ? (val('cBottles') || '1') : undefined,
        attendantName: val('cAttName2'),
        attendantPhone: val('cPhone2')
      });
    };

    // The first trip a job needs. A blood case starts by fetching the sample; an errand is
    // the single trip itself.
    const firstTrip = t => FIRST_LEG[t] || 'SAMPLE_PICKUP';

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

    if (!editing) {
      document.getElementById('caseSave').addEventListener('click', () => save(false));
      document.getElementById('caseSaveAssign').addEventListener('click', () => save(true));
      showFor('BLOOD');
      return;
    }

    // Editing: show the case's own type and fill every box from what was saved.
    showFor(existing.jobType || 'BLOOD');
    if (existing.status !== 'NEW') {
      document.querySelectorAll('.jobtype').forEach(b => { b.disabled = b.dataset.type !== (existing.jobType || 'BLOOD'); });
    }
    const idOf = v => (v && typeof v === 'object' ? v._id : v) || '';
    const put = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined && v !== null) el.value = v; };
    put('cName', existing.patientName); put('cAge', existing.patientAge); put('cGender', existing.patientGender);
    put('cGroup', existing.bloodGroup); put('cComp', existing.component); put('cUnits', existing.unitsRequested);
    put('cHospital', idOf(existing.hospital)); put('cCentre', idOf(existing.bloodCenter));
    put('cWard', existing.wardBed); put('cDoctor', existing.doctorName);
    put('cAttName', existing.attendantName); put('cAttPhone', existing.attendantPhone);
    put('cRef', existing.reference); put('cFrom', idOf(existing.fromLocation)); put('cTo', idOf(existing.toLocation));
    put('cAmount', existing.amount || ''); put('cAgainst', existing.amountAgainst);
    put('cPackage', existing.packageDetails); put('cBottles', existing.unitsRequested);
    put('cAttName2', existing.attendantName); put('cPhone2', existing.attendantPhone);
    put('cPriority', existing.priority); put('cRemarks', existing.remarks);

    document.getElementById('caseUpdate').addEventListener('click', async ev => {
      const payload = collect();
      Object.keys(payload).forEach(k => { if (payload[k] === undefined) delete payload[k]; });
      ev.currentTarget.disabled = true;
      try {
        await API.put('/api/cases/' + existing._id, payload);
        toast('Case ' + existing.caseNo + ' updated', 'ok');
        UI.closeDrawer();
        await load();
        Live.refresh();
      } catch (e) { toast(e.message, 'error'); ev.currentTarget.disabled = false; }
    });
  }

  async function openCase(id) {
    const c = await API.get('/api/cases/' + id);
    const p = c.tat.parts;
    const blood = isBlood(c);

    const legs = (c.trips || []).map(t =>
      '<div class="job" data-trip="' + t._id + '" style="margin-bottom:8px">' +
      '<div class="job__top"><span class="job__name">' + F.jobTitle(t.type) + '</span>' +
      '<span class="job__no mono">' + F.esc(t.tripNo) + '</span></div>' +
      '<div class="job__line">' + F.esc(t.runner ? t.runner.name : 'Unassigned') + ' &middot; ' + F.stageLabel(t.type, t.status) +
        (t.unitsCarried ? ' &middot; ' + t.unitsCarried + ' bottle' + (t.unitsCarried === 1 ? '' : 's') : '') + '</div>' +
      '<div class="job__line">Assigned ' + F.dateTime(t.assignedAt) +
        (t.pickedAt ? ' &middot; picked ' + F.dateTime(t.pickedAt) : '') +
        (t.completedAt ? ' &middot; finished ' + F.dateTime(t.completedAt) : '') + '</div>' +
      Complete.badge(t) +
      ((t.arrivalPhoto || t.proofPhoto)
        ? '<div class="job__shots">' +
          (t.arrivalPhoto ? '<img src="' + F.esc(t.arrivalPhoto) + '" data-shot="' + F.esc(t.arrivalPhoto) + '" data-cap="At the pickup" alt="">' : '') +
          (t.proofPhoto ? '<img src="' + F.esc(t.proofPhoto) + '" data-shot="' + F.esc(t.proofPhoto) + '" data-cap="Handover" alt="">' : '') +
          '</div>' : '') +
      '</div>').join('') || UI.empty('No runner sent yet');

    const comp = c.completion && c.completion.via === 'PORTAL'
      ? '<div class="portal-mark"><b>Completed from portal</b> by ' + F.esc(c.completion.byName || '') +
        ' &middot; ' + F.dateTime(c.completion.at) +
        (c.completion.units ? ' &middot; ' + c.completion.units + ' bottle(s)' : '') +
        (c.completion.note ? '<br>' + F.esc(c.completion.note) : '') +
        (c.completion.photo ? '<div class="job__shots"><img src="' + F.esc(c.completion.photo) + '" data-shot="' +
          F.esc(c.completion.photo) + '" data-cap="Completion photo" alt=""></div>' : '') +
        '</div>'
      : '';

    const who = blood
      ? '<h3 style="font-size:16px">' + F.esc(c.patientName) + '</h3>' +
        '<p style="color:var(--muted);margin-top:2px">' +
        // Escape each value on its own, then join with the separator. Joining first and
        // escaping the whole string turns the separator's own & into &amp;.
        [c.patientAge, c.patientGender, c.bloodGroup, c.component, c.unitsRequested + ' unit(s)']
          .filter(Boolean).map(F.esc).join(' &middot; ') + '</p>' +
        '<div class="grid-2" style="margin:12px 0">' +
        '<div><div style="font-size:12px;color:var(--muted)">Hospital</div><b>' + F.esc(c.hospital && c.hospital.name) + '</b><div style="color:var(--muted)">' + F.esc(c.wardBed || '') + '</div></div>' +
        '<div><div style="font-size:12px;color:var(--muted)">Blood centre</div><b>' + F.esc(c.bloodCenter && c.bloodCenter.name) + '</b></div></div>'
      : '<h3 style="font-size:16px">' + F.jobTitle(c.jobType) + (c.reference ? ' &middot; ' + F.esc(c.reference) : '') + '</h3>' +
        '<div class="grid-2" style="margin:12px 0">' +
        '<div><div style="font-size:12px;color:var(--muted)">Pick up from</div><b>' + F.esc(c.fromLocation && c.fromLocation.name) + '</b></div>' +
        '<div><div style="font-size:12px;color:var(--muted)">Take it to</div><b>' + F.esc(c.toLocation && c.toLocation.name) + '</b></div></div>' +
        (c.packageDetails ? '<p>Package: ' + F.esc(c.packageDetails) +
          (c.jobType === 'PACKAGE_DELIVER' && c.unitsRequested ? ' &middot; ' + c.unitsRequested + ' bottle(s) / box(es)' : '') + '</p>' : '') +
        (c.amount ? '<p>Amount to collect: <b>&#8377; ' + Number(c.amount).toLocaleString('en-IN') + '</b>' +
          (c.collectedAmount ? ' &middot; collected &#8377; ' + Number(c.collectedAmount).toLocaleString('en-IN') : '') + '</p>' : '');

    const body =
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">' +
      '<span class="chip chip--ink mono">' + F.esc(c.caseNo) + '</span>' + UI.priorityChip(c.priority) +
      '<span class="chip chip--blue">' + F.caseLabel(c.status) + '</span></div>' +
      comp + who +
      (c.attendantPhone || c.attendantName ? '<p>' + (blood ? 'Attendant: ' : 'Meet: ') + F.esc(c.attendantName || '') +
        (c.attendantPhone ? ' &middot; ' + F.esc(c.attendantPhone) : '') + '</p>' : '') +
      (c.remarks ? '<p style="color:var(--muted)">' + F.esc(c.remarks) + '</p>' : '') +
      (blood
        ? '<h4 style="margin:16px 0 6px">Time taken</h4><div class="grid-3">' +
          [['To assign', p.toAssign], ['Sample leg', p.samplePickup], ['Crossmatch', p.crossmatch], ['Delivery leg', p.delivery], ['Request to bag', p.total]]
            .map(([l, part]) => '<div style="padding:8px 0"><div style="font-size:12px;color:var(--muted)">' + l + '</div>' + UI.clockChip(part.value, part.grade) + '</div>').join('') +
          '</div>'
        : '') +
      (c.crossmatch && c.crossmatch.completedAt
        ? '<h4 style="margin:16px 0 6px">Crossmatch</h4><p>' + F.esc(c.crossmatch.result) + ' &middot; ' + (c.crossmatch.unitsReady || 0) + ' unit(s)' +
          (c.crossmatch.bagNumbers ? ' &middot; bags ' + F.esc(c.crossmatch.bagNumbers) : '') + '</p>' : '') +
      '<h4 style="margin:18px 0 8px">Runner legs</h4>' + legs;

    // Buttons for what this person may actually do. Showing a control that always refuses
    // is worse than not showing it.
    const running = runningTrip({ sampleTrip: c.sampleTrip, deliveryTrip: c.deliveryTrip, jobTrip: c.jobTrip });
    const finished = ['DELIVERED', 'JOB_DONE', 'CLOSED', 'CANCELLED'].includes(c.status);
    const del = API.can('deleteRecords')
      ? '<button class="btn btn--ghost" id="caseDelete" style="color:var(--crimson)">Delete</button>' : '';
    const edit = API.can('editRecords') && c.status !== 'CANCELLED'
      ? '<button class="btn btn--ghost" id="caseEdit">Edit</button>' : '';
    // With a runner out, Complete lives in the row actions (actionFor). With nobody out and
    // the case still open, it closes the case itself.
    const done = API.can('overrideStages') && !running && !finished
      ? '<button class="btn btn--ghost" id="caseDone">Complete from portal</button>' : '';

    // "Open" would only reopen this same drawer, so it is left off here.
    const rowAct = actionFor(c);
    UI.openDrawer('Case ' + c.caseNo, body, del + edit + done +
      (/data-act="view"/.test(rowAct) ? '' : rowAct.replace(/btn--sm/g, '')));

    document.querySelectorAll('#drawerBody .job').forEach(el =>
      el.addEventListener('click', e => {
        if (e.target.dataset && e.target.dataset.shot) return;
        Live.openTrip(el.dataset.trip);
      }));
    document.querySelectorAll('#drawerBody [data-shot]').forEach(img =>
      img.addEventListener('click', e => { e.stopPropagation(); UI.photo(img.dataset.shot, img.dataset.cap); }));

    // Every action button in the footer, not only the first: a running case has three.
    document.querySelectorAll('#drawerFoot button[data-act]').forEach(btn =>
      btn.addEventListener('click', () => act(btn.dataset.act, btn.dataset.id || c._id, btn.dataset.leg, btn.dataset.trip)));

    const delBtn = document.getElementById('caseDelete');
    if (delBtn) delBtn.addEventListener('click', () => confirmDelete(c));
    const editBtn = document.getElementById('caseEdit');
    if (editBtn) editBtn.addEventListener('click', () => openForm(c));
    const doneBtn = document.getElementById('caseDone');
    if (doneBtn) doneBtn.addEventListener('click', () => Complete.open({ kase: c, onDone: () => { load(); Live.refresh(); } }));
  }

  /*
   * Deleting is the one action here that cannot be undone, so the confirmation names exactly
   * what will go rather than asking a vague "are you sure". A case takes its jobs, their
   * location trails and their handover photos with it.
   */
  function confirmDelete(c) {
    const legs = (c.trips || []).length;
    const detail = legs
      ? 'This will also delete its ' + legs + ' runner job' + (legs > 1 ? 's' : '') +
        ', their location trails and any handover photos.'
      : 'This case has no runner jobs yet.';

    if (!window.confirm(
        'Delete case ' + c.caseNo + ' for ' + (c.patientName || c.reference || 'this job') + '?\n\n' +
        detail + '\n\nThis cannot be undone.')) return;

    API.del('/api/cases/' + c._id)
      .then(r => { toast(r.message || 'Deleted', 'ok'); UI.closeDrawer(); load(); })
      .catch(e => toast(e.message, 'error'));
  }

  return { boot, load, pickRunner, openCase, openForm };
})();
