/* Shared fetch helper, session storage and small formatters. */
const API = (function () {
  const KEY = 'ibs_token';
  const USER = 'ibs_user';

  function token() { return localStorage.getItem(KEY) || ''; }
  function user() { try { return JSON.parse(localStorage.getItem(USER) || 'null'); } catch (e) { return null; } }
  function save(t, u) { localStorage.setItem(KEY, t); localStorage.setItem(USER, JSON.stringify(u)); }
  function clear() { localStorage.removeItem(KEY); localStorage.removeItem(USER); }

  async function request(method, url, body) {
    const opts = { method, headers: {} };
    if (token()) opts.headers.Authorization = 'Bearer ' + token();
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.status === 401) { clear(); location.href = 'index.html'; throw new Error('Session expired'); }
    if (!res.ok) throw new Error((data && data.error) || 'Request failed');
    return data;
  }

  const qs = params => Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');

  return {
    token, user, save, clear, qs,

    // What the signed-in person is allowed to do. The server enforces this on every call -
    // this copy only decides which buttons are worth showing.
    can: function (right) {
      const u = user();
      return !!(u && u.rights && u.rights[right]);
    },

    get: (u, p) => request('GET', u + (p ? '?' + qs(p) : '')),
    post: (u, b) => request('POST', u, b || {}),
    put: (u, b) => request('PUT', u, b || {}),
    del: u => request('DELETE', u)
  };
})();

/* ---- formatters shared by every page ---- */
const F = {
  mins(m) {
    if (m === null || m === undefined) return '--';
    const h = Math.floor(m / 60), r = Math.round(m % 60);
    return h ? h + 'h ' + String(r).padStart(2, '0') + 'm' : r + 'm';
  },
  clock(m) {
    if (m === null || m === undefined) return '--:--';
    const t = Math.max(0, Math.round(m * 60));
    const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
    return (hh ? hh + ':' : '') + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  },
  time(d) {
    if (!d) return '--';
    return new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  },
  dateTime(d) {
    if (!d) return '--';
    return new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
  },
  date(d) { return d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '--'; },
  today() { return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); },
  ago(d) {
    if (!d) return 'never';
    const s = Math.round((Date.now() - new Date(d)) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  },
  initials(name) {
    return String(name || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  },
  esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
  stageLabel(type, status) {
    const sample = type === 'SAMPLE_PICKUP';
    return ({
      ASSIGNED: 'Waiting for the runner to accept',
      ACCEPTED: 'Accepted',
      EN_ROUTE_PICKUP: sample ? 'On the way to hospital' : 'On the way to blood centre',
      AT_PICKUP: sample ? 'At hospital' : 'At blood centre',
      PICKED: sample ? 'Sample collected' : 'Units loaded',
      EN_ROUTE_DROP: sample ? 'Returning to blood centre' : 'On the way to hospital',
      AT_DROP: sample ? 'At blood centre' : 'At hospital',
      COMPLETED: sample ? 'Sample handed over' : 'Blood delivered',
      REJECTED: 'Declined by runner',
      CANCELLED: 'Cancelled'
    })[status] || status;
  },
  caseLabel(s) {
    return ({
      NEW: 'Waiting to assign', SAMPLE_TRIP: 'Sample pickup running', SAMPLE_AT_CENTER: 'Sample at centre',
      CROSSMATCH: 'Crossmatch running', READY: 'Units ready', DELIVERY_TRIP: 'Delivery running',
      DELIVERED: 'Delivered', CLOSED: 'Closed', CANCELLED: 'Cancelled'
    })[s] || s;
  }
};

function toast(message, kind) {
  let host = document.querySelector('.toast-host');
  if (!host) { host = document.createElement('div'); host.className = 'toast-host'; document.body.appendChild(host); }
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' toast--' + kind : '');
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}
