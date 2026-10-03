/*
 * Completing a job from the portal.
 *
 * The runner did the work but the phone never said so - battery died, no signal in the
 * basement, an old build, or he simply forgot to press Finish. Until now the case then sat
 * as "Runner on the way" forever and blocked his next job on the phone. This lets the desk
 * close it with the time it REALLY happened and the photo he sent on WhatsApp.
 *
 * Everything closed here is stamped "Completed from portal" with the person's name, and that
 * label shows wherever the job is shown, so it can never pass for a runner's own record.
 *
 * The same form corrects a job that is already finished: a wrong time, a missing photo.
 */
const Complete = (function () {

  // datetime-local wants "YYYY-MM-DDTHH:MM" in local (IST) time.
  const toInput = d => {
    if (!d) return '';
    const t = new Date(d);
    if (isNaN(t.getTime())) return '';
    return new Date(t.getTime() + 330 * 60000).toISOString().slice(0, 16);
  };

  const BOTTLE_JOBS = ['BLOOD_DELIVERY', 'PACKAGE_DELIVER'];

  /**
   * @param o.trip   the running (or finished) trip, populated - or null for a case with no runner
   * @param o.kase   the case, for its numbers and its own completion when there is no trip
   * @param o.onDone called after a successful save
   */
  function open(o) {
    const trip = o.trip || null;
    const kase = o.kase || (trip && trip.case) || {};
    const correcting = !!(trip && trip.status === 'COMPLETED');
    const type = trip ? trip.type : null;
    const jobType = kase.jobType || 'BLOOD';
    const me = (API.user() && API.user().name) || 'you';

    const bottles = trip
      ? BOTTLE_JOBS.includes(type)
      : (jobType === 'BLOOD' || jobType === 'PACKAGE_DELIVER');
    const payment = trip ? type === 'PAYMENT_COLLECT' : jobType === 'PAYMENT_COLLECT';

    const nowInput = toInput(new Date());
    const where = trip
      ? F.esc(trip.pickupLocation ? trip.pickupLocation.name : '') + ' &rarr; ' +
        F.esc(trip.dropLocation ? trip.dropLocation.name : '')
      : '';

    const head =
      '<div class="cp-head">' +
      (trip ? '<span class="chip chip--ink mono">' + F.esc(trip.tripNo || '') + '</span>' : '') +
      (kase.caseNo ? '<span class="chip mono">' + F.esc(kase.caseNo) + '</span>' : '') +
      (trip ? '<span class="chip chip--blue">' + F.stageLabel(trip.type, trip.status) + '</span>' : '') +
      '</div>' +
      (where ? '<p class="cp-where">' + where + '</p>' : '') +
      (trip && trip.runner ? '<p class="cp-muted">Runner: <b>' + F.esc(trip.runner.name || '') + '</b></p>' : '') +
      '<div class="cp-note">' +
      (correcting
        ? 'This job is already finished. Change the times or add the photo; the record will show it was corrected by <b>' + F.esc(me) + '</b>.'
        : 'This will be recorded as <b>completed from the portal</b> by <b>' + F.esc(me) + '</b>, not by the runner.') +
      '</div>';

    // Prefill the pickup only when it is a real, separate moment. A pickup stamped at the same
    // instant as the delivery was inferred, and prefilling it would block moving the delivery.
    const sameMoment = trip && trip.pickedAt && trip.completedAt &&
      new Date(trip.pickedAt).getTime() === new Date(trip.completedAt).getTime();
    const pickedVal = trip && !sameMoment ? toInput(trip.pickedAt) : '';
    const doneVal = correcting ? toInput(trip.completedAt) : nowInput;

    const units = trip ? (trip.unitsCarried || (kase.unitsRequested || '')) : (kase.unitsRequested || '');

    const body = head +
      '<div class="grid-2">' +
      (trip
        ? '<div class="field"><label>Picked up at <small>(optional)</small></label>' +
          '<input type="datetime-local" id="cpPicked" max="' + nowInput + '" value="' + pickedVal + '"></div>'
        : '') +
      '<div class="field"><label>' + (trip ? 'Delivered at' : 'Completed at') + '</label>' +
      '<input type="datetime-local" id="cpAt" max="' + nowInput + '" value="' + doneVal + '" required></div>' +
      '</div>' +
      (bottles
        ? '<div class="field"><label>Bottles / units handed over</label>' +
          '<input type="number" id="cpUnits" min="0" value="' + F.esc(String(units)) + '"></div>'
        : '') +
      (payment
        ? '<div class="grid-2"><div class="field"><label>Amount collected</label>' +
          '<input type="number" id="cpAmount" min="0" value="' + F.esc(String((trip && trip.amountCollected) || kase.amount || '')) + '"></div>' +
          '<div class="field"><label>Mode</label><select id="cpMode">' +
          ['CASH', 'UPI', 'CHEQUE', 'OTHER'].map(m => '<option>' + m + '</option>').join('') + '</select></div></div>'
        : '') +
      '<div class="field"><label>Photo <small>(handover picture, if you have it)</small></label>' +
      '<input type="file" id="cpPhoto" accept="image/*">' +
      '<div id="cpPreview" class="cp-preview" hidden></div></div>' +
      '<div class="field"><label>' + (correcting ? 'What was corrected' : 'Why from the portal') + '</label>' +
      '<textarea id="cpNote" placeholder="' + (correcting ? 'e.g. delivery time was entered late'
        : 'e.g. runner phone switched off, he confirmed on call') + '"></textarea></div>';

    UI.openDrawer(correcting ? 'Correct finished job' : 'Complete from portal', body,
      '<button class="btn btn--ghost" onclick="UI.closeDrawer()">Cancel</button>' +
      '<button class="btn btn--red" id="cpSave">' + (correcting ? 'Save correction' : 'Mark completed') + '</button>');

    const file = document.getElementById('cpPhoto');
    file.addEventListener('change', () => {
      const box = document.getElementById('cpPreview');
      const f = file.files && file.files[0];
      if (!f) { box.hidden = true; box.innerHTML = ''; return; }
      if (f.size > 8 * 1024 * 1024) {
        toast('That photo is larger than 8 MB. Pick a smaller one.', 'error');
        file.value = ''; box.hidden = true; return;
      }
      const url = URL.createObjectURL(f);
      box.innerHTML = '<img src="' + url + '" alt="">';
      box.hidden = false;
    });

    document.getElementById('cpSave').addEventListener('click', async ev => {
      const btn = ev.currentTarget;
      const at = document.getElementById('cpAt').value;
      const picked = trip ? document.getElementById('cpPicked').value : '';
      const note = document.getElementById('cpNote').value.trim();

      if (!at) { toast('Enter when it was delivered', 'error'); return; }
      if (picked && picked > at) { toast('Picked up must be before delivered', 'error'); return; }
      if (!correcting && note.length < 3) { toast('Write why it is being completed from the portal', 'error'); return; }

      const fd = new FormData();
      // On a correction only what was actually changed is sent, so adding a photo cannot
      // quietly round every recorded time to the minute.
      if (!correcting || at !== doneVal) fd.append('at', at);
      if (picked && (!correcting || picked !== pickedVal)) fd.append('pickedAt', picked);
      if (note) fd.append('note', note);
      const u = document.getElementById('cpUnits');
      if (u && u.value !== '') fd.append('units', u.value);
      const a = document.getElementById('cpAmount');
      if (a && a.value !== '') {
        fd.append('amount', a.value);
        fd.append('paymentMode', document.getElementById('cpMode').value);
      }
      if (file.files && file.files[0]) fd.append('photo', file.files[0]);

      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        const url = trip
          ? '/api/trips/' + trip._id + '/complete'
          : '/api/cases/' + kase._id + '/complete';
        await API.form(url, fd);
        toast(correcting ? 'Correction saved' : 'Marked completed from the portal', 'ok');
        UI.closeDrawer();
        if (o.onDone) o.onDone();
      } catch (e) {
        toast(e.message, 'error');
        btn.disabled = false;
        btn.textContent = correcting ? 'Save correction' : 'Mark completed';
      }
    });
  }

  /** The line shown under a job or case that was closed from the portal. */
  function badge(rec) {
    if (!rec) return '';
    const portal = rec.closedVia === 'PORTAL' || (rec.completion && rec.completion.via === 'PORTAL');
    const amended = !!rec.amendedAt;
    if (!portal && !amended) return '';
    const by = rec.closedByName || (rec.completion && rec.completion.byName) || '';
    const at = rec.completedAt || (rec.completion && rec.completion.at);
    return '<div class="portal-mark">' +
      (portal ? '<b>Completed from portal</b>' + (by ? ' by ' + F.esc(by) : '') + (at ? ' &middot; ' + F.dateTime(at) : '') : '') +
      (amended ? (portal ? '<br>' : '') + '<b>Corrected</b> by ' + F.esc(rec.amendedByName || '') + ' &middot; ' + F.dateTime(rec.amendedAt) : '') +
      '</div>';
  }

  return { open, badge, toInput };
})();
