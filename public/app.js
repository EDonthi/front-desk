// the frontend: a small single-page app with no framework. the server sends index.html for
// every page and this file draws the right one based on the url.
// the guards here (hidden links, "no access" page, login redirect) are for usability only.
// the real access control is in server.js, which never sends names to a viewer.

const app = document.getElementById('app');
let me = null; // cached /api/me result until sign-out
let lastListUrl = '/visits'; // so "back to visits" keeps your filters

// ---------- helpers ----------

// every value from the api is escaped before going into html, to prevent xss
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TYPE_LABELS = { interview: 'Interview', guest: 'Guest', contractor: 'Contractor', vendor: 'Vendor' };
const typePill = (t) => `<span class="pill pill-${esc(t)}">${esc(TYPE_LABELS[t] || t)}</span>`;
const BRAND = '<div class="brand"><span class="brand-mark">F</span>Front Desk</div>';

// dates and times are formatted from the strings directly (utc), so the viewer's timezone can't shift them
function fmtDate(iso) {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function fmtTime(ts) {
  if (!ts) return null; // no sign-out recorded
  const [h, m] = ts.slice(11, 16).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}
function fmtMinutes(min) {
  if (min == null) return null;
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
}
// account timestamps are real moments, so local time is right here
function fmtDateTime(iso) {
  return iso ? new Date(iso).toLocaleString() : 'Never';
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// one wrapper for every api call, so errors are handled consistently. the cookie is sent automatically.
async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error || `Request failed (${res.status}).`);
  return body;
}

// only redirect to paths on this site after login (prevents an open redirect via ?next=//evil.example)
function safeNext(next) {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/visits';
}

function currentPath() {
  return location.pathname + location.search;
}

// replace (vs push) is used for redirects so the back button doesn't bounce
function navigate(url, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
  render();
}

// remember the full url (filters included) so the user lands back there after signing in
function goToLogin() {
  me = null;
  navigate(`/login?next=${encodeURIComponent(currentPath())}`, { replace: true });
}

// handle internal links without a full reload; modifier-clicks still open new tabs
document.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a || a.target || a.origin !== location.origin || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  navigate(a.pathname + a.search);
});
window.addEventListener('popstate', render);

// ---------- top bar ----------

function renderShell(active) {
  const top = document.getElementById('topbar');
  if (!me) {
    top.hidden = true;
    return;
  }
  top.hidden = false;
  const links = [{ href: '/visits', label: 'Visits', key: 'visits' }];
  // don't offer viewers a link that would only bounce them
  if (me.permissions.manageUsers) links.push({ href: '/admin/users', label: 'Users', key: 'users' });
  document.getElementById('nav').innerHTML = links
    .map((l) => `<a href="${l.href}" class="${l.key === active ? 'active' : ''}">${l.label}</a>`)
    .join('');
  document.getElementById('whoami').innerHTML = `
    <span>${esc(me.user.name)} <span class="role">${esc(me.user.role)}</span></span>
    <button class="link" id="signout">Sign out</button>`;
  document.getElementById('signout').onclick = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    me = null;
    navigate('/login', { replace: true });
  };
}

// ---------- router ----------

const routes = [
  { pattern: /^\/$/, page: () => navigate('/visits', { replace: true }) },
  { pattern: /^\/login$/, page: loginPage, public: true },
  { pattern: /^\/signup$/, page: signupPage, public: true },
  { pattern: /^\/visits$/, page: visitsPage, nav: 'visits' },
  { pattern: /^\/visits\/([^/]+)$/, page: visitPage, nav: 'visits' },
  { pattern: /^\/admin\/users$/, page: usersPage, nav: 'users', adminOnly: true },
];

async function render() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const route = routes.find((r) => r.pattern.test(path));

  if (!route) {
    if (!me) await loadMe().catch(() => {});
    renderShell(null);
    return notFoundPage();
  }

  // asking /api/me on load is what keeps you signed in across refreshes (the cookie is still there)
  if (!route.public && !me) {
    try {
      await loadMe();
    } catch (err) {
      if (err.status === 401) return goToLogin();
      return showError(err);
    }
  }
  renderShell(route.nav);

  // signed in but not allowed: a clear page, not a redirect (which could loop)
  if (route.adminOnly && !me.permissions.manageUsers) return forbiddenPage();
  const params = path.match(route.pattern).slice(1).map(decodeURIComponent);
  try {
    await route.page(...params);
  } catch (err) {
    // sessions can expire mid-use
    if (err.status === 401) return goToLogin();
    if (err.status === 403) return forbiddenPage();
    showError(err);
  }
}

async function loadMe() {
  me = await api('/api/me');
}

function setTitle(t) {
  document.title = `${t} · Front Desk`;
}

function showError(err) {
  app.innerHTML = `<div class="card"><h1>Something went wrong</h1><p class="error">${esc(err.message)}</p>
    <p><a href="${esc(currentPath())}">Try again</a></p></div>`;
}

// ---------- pages ----------

function loginPage() {
  setTitle('Sign in');
  const next = safeNext(new URLSearchParams(location.search).get('next'));
  const created = new URLSearchParams(location.search).get('created'); // set right after sign-up
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-hero">
        <p class="eyebrow">Brightline · Front Desk</p>
        <h1 class="display">See who's in<br>the <strong>lobby</strong></h1>
      </div>
      <div class="card narrow auth-card">
      ${BRAND}
      ${created ? '<p class="success">Account created. Sign in with your new password.</p>' : ''}
      <form class="stack" id="f">
        <label for="email">Work email</label>
        <input id="email" type="email" autocomplete="username" required value="${esc(created || '')}">
        <label for="password">Password</label>
        <input id="password" type="password" autocomplete="current-password" required>
        <div id="msg"></div>
        <button><span class="btn-arrow">→</span><span class="btn-label">Sign in</span></button>
      </form>
      <p class="muted">First time here? <a href="/signup?next=${encodeURIComponent(next)}">Create an account</a></p>
    </div></div>`;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true; // prevent double submits
    try {
      await api('/auth/login', {
        method: 'POST',
        body: { email: document.getElementById('email').value, password: document.getElementById('password').value },
      });
      me = null;
      navigate(next, { replace: true });
    } catch (err) {
      document.getElementById('msg').innerHTML = `<p class="error">${esc(err.message)}</p>`;
      btn.disabled = false;
    }
  };
}

function signupPage() {
  setTitle('Create account');
  const next = safeNext(new URLSearchParams(location.search).get('next'));
  // minlength is just a hint; the server enforces the real rule
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-hero">
        <p class="eyebrow">Brightline · Front Desk</p>
        <h1 class="display">Create your<br><strong>account</strong></h1>
      </div>
      <div class="card narrow auth-card">
      ${BRAND}
      <p class="muted">Front Desk is open to a short list of Brightline staff. Use your work email.</p>
      <form class="stack" id="f">
        <label for="email">Work email</label>
        <input id="email" type="email" autocomplete="username" required>
        <label for="password">Choose a password (at least 8 characters)</label>
        <input id="password" type="password" autocomplete="new-password" minlength="8" required>
        <div id="msg"></div>
        <button><span class="btn-arrow">→</span><span class="btn-label">Create account</span></button>
      </form>
      <p class="muted">Already have one? <a href="/login?next=${encodeURIComponent(next)}">Sign in</a></p>
    </div></div>`;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const res = await api('/auth/signup', {
        method: 'POST',
        body: { email: document.getElementById('email').value, password: document.getElementById('password').value },
      });
      navigate(`/login?created=${encodeURIComponent(res.email)}&next=${encodeURIComponent(next)}`, { replace: true });
    } catch (err) {
      // e.g. not on the list: shown clearly on the form rather than failing silently
      document.getElementById('msg').innerHTML = `<p class="error">${esc(err.message)}</p>`;
      btn.disabled = false;
    }
  };
}

// the server writes the caveat wording; the page just displays it
function notesHtml(notes) {
  return (notes || []).map((n) => `<p class="note">${esc(n)}</p>`).join('');
}

// simple css bar chart (charts were optional, so no library)
function barsHtml(rows, labelKey, valueKey, topLabel) {
  const max = Math.max(1, ...rows.map((r) => r[valueKey] || 0));
  return `<table class="bars">${rows
    .map(
      (r) => `<tr class="${r[labelKey] === topLabel ? 'top' : ''}">
        <td>${esc(r[labelKey])}</td>
        <td class="bar"><div class="fill" style="width:${((r[valueKey] || 0) / max) * 100}%"></div></td>
        <td>${r[valueKey] ?? '–'}</td></tr>`
    )
    .join('')}</table>`;
}

async function visitsPage() {
  setTitle('Visits');
  lastListUrl = currentPath();
  // filters come from the url, so a pasted link opens already filtered
  const q = new URLSearchParams(location.search);
  const opts = me.options;
  const seeIdentity = me.permissions.seeVisitorIdentity;

  const option = (value, label, selected) =>
    `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;

  // render with loading placeholders first so the page is never blank
  app.innerHTML = `
    <div class="page-head">
      <p class="eyebrow">Hello ${esc(me.user.name.split(' ')[0])}</p>
      <h1 class="display">When is the lobby <strong>busy</strong>?</h1>
      <p class="muted">Sign-ins from the lobby iPad, ${fmtDate(opts.coverage.from)} to ${fmtDate(opts.coverage.to)}.</p>
    </div>
    <form class="filters card" id="filters">
      <label>From <input type="date" name="from" value="${esc(q.get('from') || '')}" min="${opts.coverage.from}" max="${opts.coverage.to}"></label>
      <label>To <input type="date" name="to" value="${esc(q.get('to') || '')}" min="${opts.coverage.from}" max="${opts.coverage.to}"></label>
      <label>Visit type <select name="type">${option('', 'All types', q.get('type') || '')}${opts.visitTypes
        .map((t) => option(t, TYPE_LABELS[t] || t, q.get('type')))
        .join('')}</select></label>
      <label>Host team <select name="team">${option('', 'All teams', q.get('team') || '')}${opts.hostTeams
        .map((t) => option(t, t, q.get('team')))
        .join('')}</select></label>
      <button>Apply</button>
      ${q.toString() ? '<a href="/visits">Clear filters</a>' : ''}
    </form>
    <div id="stats"><p class="muted">Working out the busy times…</p></div>
    <h2>Visits</h2>
    <div id="list"><p class="muted">Loading visits…</p></div>`;

  // apply only updates the url; the page re-renders from it, so the url is the single source of truth
  document.getElementById('filters').onsubmit = (e) => {
    e.preventDefault();
    const next = new URLSearchParams();
    for (const [k, v] of new FormData(e.target)) if (v) next.set(k, v);
    navigate(`/visits${next.toString() ? '?' + next : ''}`);
  };

  // stats cover the whole filtered range, so only the list request gets "page"
  const filterQs = new URLSearchParams();
  for (const k of ['from', 'to', 'type', 'team']) if (q.get(k)) filterQs.set(k, q.get(k));
  const listQs = new URLSearchParams(filterQs);
  if (q.get('page')) listQs.set('page', q.get('page'));

  const statsEl = document.getElementById('stats');
  const listEl = document.getElementById('list');
  // in parallel; allSettled so one failure doesn't hide the other result
  const [stats, list] = await Promise.allSettled([api(`/api/stats?${filterQs}`), api(`/api/visits?${listQs}`)]);

  for (const r of [stats, list]) {
    if (r.status === 'rejected' && r.reason.status === 401) return goToLogin();
  }
  // a bad pasted filter shows the server's 400 message
  if (stats.status === 'rejected') {
    statsEl.innerHTML = `<p class="error">${esc(stats.reason.message)}</p>`;
    listEl.innerHTML = '';
    return;
  }
  renderStats(statsEl, stats.value);
  if (list.status === 'rejected') {
    listEl.innerHTML = `<p class="error">${esc(list.reason.message)}</p>`;
    return;
  }
  renderList(listEl, list.value, seeIdentity, q);
}

function renderStats(el, s) {
  if (!s.totalVisits) {
    el.innerHTML = notesHtml(s.notes);
    return;
  }
  const signOutShare = Math.round((s.signOuts.notRecorded / s.totalVisits) * 100);
  // no overall "visit length" card: with ~45% missing sign-outs it wouldn't be trustworthy.
  // the arrivals note at the bottom was something dana specifically asked for.
  el.innerHTML = `
    ${notesHtml(s.notes)}
    <div class="headline">
      <div class="card stat"><div class="label">Visits</div><div class="value">${s.totalVisits.toLocaleString()}</div>
        <div class="sub">over ${s.daysWithVisits} working days</div></div>
      <div class="card stat"><div class="label">Busiest day</div><div class="value">${esc(s.busiestDay.day)}</div>
        <div class="sub">${s.busiestDay.averagePerDay} visits on an average ${esc(s.busiestDay.day)}</div></div>
      <div class="card stat"><div class="label">Busiest hour</div><div class="value">${esc(s.busiestHour.label)}</div>
        <div class="sub">${s.busiestHour.visits} arrivals in that hour</div></div>
      <div class="card stat"><div class="label">Average per day</div><div class="value">${s.daysRecorded ? Math.round((s.totalVisits / s.daysRecorded) * 10) / 10 : '–'}</div>
        <div class="sub">arrivals per working day with records</div></div>
    </div>
    <div class="charts">
      <div class="card"><h2>Average visits by day of week</h2>${barsHtml(s.byDayOfWeek, 'day', 'averagePerDay', s.busiestDay.day)}</div>
      <div class="card"><h2>Arrivals by hour</h2>${barsHtml(s.byHour, 'label', 'visits', s.busiestHour.label)}</div>
    </div>
    <p class="note">These numbers count <strong>arrivals</strong>, not how many people were in the building at once. ${signOutShare}% of visitors in this view never signed out,
      so we can't reliably say how many were inside at the same time.</p>`;
}

function renderList(el, data, seeIdentity, q) {
  // point at the missing-days note so "0 visits" isn't read as "quiet"
  if (!data.visits.length) {
    el.innerHTML = `<p class="card">No visits match these filters.${
      data.missingDays.length ? ' Part of this period has no sign-in records at all (see the note above).' : ''
    }</p>`;
    return;
  }
  // page number lives in the url too, so refresh/share keeps your page
  const pageLink = (p) => {
    const qs = new URLSearchParams(q);
    p > 1 ? qs.set('page', p) : qs.delete('page');
    return `/visits${qs.toString() ? '?' + qs : ''}`;
  };
  // viewers see the visit reference where a name would be: it identifies no one, but they can
  // still ask an admin about a specific visit. (the api never sends them names anyway.)
  const who = (v) =>
    seeIdentity
      ? `<a href="/visits/${esc(v.id)}">${esc(v.visitorName)}</a><br><span class="muted">${esc(v.visitorCompany)}</span>`
      : `<a href="/visits/${esc(v.id)}" class="hidden-identity">Visitor ${esc(v.id)}</a>`;
  const first = (data.page - 1) * data.limit + 1;
  el.innerHTML = `
    <p class="muted">Showing ${first.toLocaleString()}–${(first + data.visits.length - 1).toLocaleString()} of ${data.total.toLocaleString()}</p>
    <div class="table-wrap"><table class="list">
      <thead><tr><th>Date</th><th>Arrived</th><th>Left</th><th>${seeIdentity ? 'Visitor' : 'Visit'}</th><th>Type</th><th>Host team</th>${
        seeIdentity ? '<th>Host</th>' : ''
      }</tr></thead>
      <tbody>${data.visits
        .map(
          (v) => `<tr>
            <td>${fmtDate(v.date)}</td>
            <td class="num">${fmtTime(v.signedInAt)}</td>
            <td class="num">${fmtTime(v.signedOutAt) ?? '<span class="muted">Not recorded</span>'}</td>
            <td>${who(v)}</td>
            <td>${typePill(v.type)}</td>
            <td>${esc(v.hostTeam)}</td>
            ${seeIdentity ? `<td>${esc(v.hostName)}</td>` : ''}
          </tr>`
        )
        .join('')}</tbody>
    </table></div>
    <div class="pager">
      ${data.page > 1 ? `<a href="${pageLink(data.page - 1)}">← Previous</a>` : ''}
      <span class="muted">Page ${data.page} of ${data.totalPages}</span>
      ${data.page < data.totalPages ? `<a href="${pageLink(data.page + 1)}">Next →</a>` : ''}
    </div>`;
}

async function visitPage(id) {
  setTitle(`Visit ${id}`);
  app.innerHTML = `<a class="back" href="${esc(lastListUrl)}">← Back to visits</a><div id="visit"><p class="muted">Loading visit…</p></div>`;
  const el = document.getElementById('visit');
  let v;
  try {
    ({ visit: v } = await api(`/api/visits/${encodeURIComponent(id)}`));
  } catch (err) {
    // shows the server's explanation, including "this was a duplicate of ..."
    if (err.status === 404 || err.status === 400) {
      el.innerHTML = `<div class="card"><h1>Visit not found</h1><p>${esc(err.message)}</p></div>`;
      return;
    }
    throw err;
  }

  const row = (label, value) => `<dt>${label}</dt><dd>${value}</dd>`;
  const notRecorded = '<span class="muted">Not recorded. The visitor didn’t sign out on the iPad.</span>';
  // viewers get an explanation instead of a blank, so it doesn't look like a bug
  const identity = me.permissions.seeVisitorIdentity
    ? row('Visitor', esc(v.visitorName)) +
      row('Email', `<a href="mailto:${esc(v.visitorEmail)}">${esc(v.visitorEmail)}</a>`) +
      row('Company', esc(v.visitorCompany)) +
      row('Host', `${esc(v.hostName)} (<a href="mailto:${esc(v.hostEmail)}">${esc(v.hostEmail)}</a>)`)
    : row('Visitor', '<span class="muted">Hidden. Only Front Desk admins can see who visited.</span>');

  el.innerHTML = `
    <div class="card">
      ${typePill(v.type)}
      <h1 style="margin-top:.5rem">${esc(TYPE_LABELS[v.type] || v.type)} visit on ${fmtDate(v.date)}</h1>
      <p class="muted">Reference ${esc(v.id)}</p>
      <dl class="detail">
        ${identity}
        ${row('Host team', esc(v.hostTeam))}
        ${row('Arrived', fmtTime(v.signedInAt))}
        ${row('Left', fmtTime(v.signedOutAt) ?? notRecorded)}
        ${row('Length of visit', fmtMinutes(v.durationMinutes) ?? '<span class="muted">Unknown</span>')}
        ${row('Pre-registered', v.preRegistered ? '<span class="pill pill-yes">Yes</span> the host registered them in advance' : '<span class="pill pill-no">No</span> walked in')}
      </dl>
    </div>`;
}

async function usersPage() {
  setTitle('Users');
  app.innerHTML = `<div class="page-head"><p class="eyebrow">Access</p><h1 class="display">Who can use <strong>Front Desk</strong></h1>
    <p class="muted">The access list, and who on it has created an account. To change the list, edit allowed_users.csv and restart.</p></div>
    <div id="users"><p class="muted">Loading…</p></div>`;
  const { users, removedFromList } = await api('/api/admin/users');
  const joined = users.filter((u) => u.signedUp).length;
  document.getElementById('users').innerHTML = `
    <p>${joined} of ${users.length} people have signed up.</p>
    <div class="table-wrap"><table class="list">
      <thead><tr><th>Name</th><th>Email</th><th>Can see</th><th>Account</th><th>Last sign-in</th></tr></thead>
      <tbody>${users
        .map(
          (u) => `<tr>
            <td>${esc(u.name)}</td><td>${esc(u.email)}</td>
            <td>${u.role === 'admin' ? 'Everything, including names <span class="role">admin</span>' : 'Counts only <span class="role">viewer</span>'}</td>
            <td>${u.signedUp ? `Signed up ${fmtDateTime(u.signedUpAt)}` : '<span class="muted">Not signed up yet</span>'}</td>
            <td>${u.signedUp ? fmtDateTime(u.lastSignInAt) : ''}</td>
          </tr>`
        )
        .join('')}</tbody>
    </table></div>
    ${
      removedFromList.length
        ? `<h2>Removed from the list</h2><p class="muted">These accounts exist but are no longer on the list, so they can't sign in.</p>
           <ul>${removedFromList.map((a) => `<li>${esc(a.email)}</li>`).join('')}</ul>`
        : ''
    }`;
}

function forbiddenPage() {
  setTitle('No access');
  app.innerHTML = `<div class="card narrow"><h1>You don't have access to this page</h1>
    <p>This page is only for Front Desk admins. You're signed in as ${esc(me.user.email)} (${esc(me.user.role)}).</p>
    <p><a href="/visits">Go to visits</a></p></div>`;
}

function notFoundPage() {
  setTitle('Page not found');
  app.innerHTML = `<div class="card narrow"><h1>Page not found</h1>
    <p>There's nothing at <code>${esc(location.pathname)}</code>.</p>
    <p><a href="${me ? '/visits' : '/login'}">${me ? 'Go to visits' : 'Sign in'}</a></p></div>`;
}

render();
