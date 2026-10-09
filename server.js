// api + access rules + serving the pages, all in one express process.
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { VISIT_TYPES, DAY_NAMES, loadAllowedUsers, loadVisits } = require('./lib/data');
const accounts = require('./lib/accounts');

const PORT = Number(process.env.PORT) || 3000;
const COOKIE = 'fd_session';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200; // capped so the browser never gets all ~2,000 rows at once

// load + clean the csvs once at startup (small enough to keep in memory)
const allowedUsers = loadAllowedUsers();
const data = loadVisits();
console.log(
  `Loaded ${allowedUsers.size} allowed users, ${data.visits.length} visits ` +
    `(${data.duplicates.length} duplicate sign-ins dropped, no records on ${data.missingDays.join(', ') || 'no days'}).`
);

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(cookieParser());

// ---------------------------------------------------------------------------
// sessions and roles: the real access control lives here, not in the frontend
// ---------------------------------------------------------------------------

// accept the browser cookie or a bearer token (easier for curl)
function sessionToken(req) {
  const header = req.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return req.cookies[COOKIE];
}

// json 401, not a redirect to html, so api clients get a usable error
function requireUser(req, res, next) {
  const user = accounts.userForToken(allowedUsers, sessionToken(req));
  if (!user) return res.status(401).json({ error: 'You need to sign in first.' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only Front Desk admins can see this.' });
  }
  next();
}

const canSeeIdentity = (user) => user.role === 'admin';

// fields are allow-listed per role rather than deleted, so a new csv column can't leak
// to viewers by accident. for viewers the identity keys are absent, not null.
function shapeVisit(v, user) {
  const shape = {
    id: v.id,
    date: v.date,
    weekday: DAY_NAMES[v.weekday],
    signedInAt: v.signedInAt,
    signedOutAt: v.signedOutAt,
    durationMinutes: v.durationMinutes,
    type: v.type,
    hostTeam: v.hostTeam,
    preRegistered: v.preRegistered,
  };
  if (canSeeIdentity(user)) {
    // host name and company are admin-only too: host + date + "interview" can identify a candidate
    Object.assign(shape, {
      visitorName: v.visitorName,
      visitorEmail: v.visitorEmail,
      visitorCompany: v.visitorCompany,
      hostName: v.hostName,
      hostEmail: v.hostEmail,
    });
  }
  return shape;
}

// ---------------------------------------------------------------------------
// filter validation: every mistake is a 400 that says how to fix it
// ---------------------------------------------------------------------------

class BadRequest extends Error {}

// the round-trip check rejects dates like 2026-02-30 that js would silently roll over
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

function parseFilters(query, { paged }) {
  const allowed = ['from', 'to', 'type', 'team', ...(paged ? ['page', 'limit'] : [])];
  for (const key of Object.keys(query)) {
    // unknown params are rejected, not ignored: catches typos and rules out things like ?name=
    if (!allowed.includes(key)) {
      throw new BadRequest(`Unknown filter "${key}". You can filter by: ${allowed.join(', ')}.`);
    }
    if (typeof query[key] !== 'string') throw new BadRequest(`Give "${key}" only once.`);
  }

  const f = {};
  for (const key of ['from', 'to']) {
    const value = (query[key] || '').trim();
    if (!value) continue;
    if (!isRealDate(value)) {
      throw new BadRequest(`"${key}" must be a real date written as YYYY-MM-DD, e.g. 2026-08-04. Got "${value}".`);
    }
    f[key] = value;
  }
  if (f.from && f.to && f.to < f.from) {
    throw new BadRequest(`The end date (${f.to}) is before the start date (${f.from}). Swap them or pick a later end date.`);
  }

  if (query.type) {
    const type = query.type.trim().toLowerCase();
    if (!VISIT_TYPES.includes(type)) {
      throw new BadRequest(`"${query.type}" isn't a visit type. Use one of: ${VISIT_TYPES.join(', ')}.`);
    }
    f.type = type;
  }

  if (query.team) {
    const team = data.teams.find((t) => t.toLowerCase() === query.team.trim().toLowerCase());
    if (!team) throw new BadRequest(`"${query.team}" isn't a host team. Use one of: ${data.teams.join(', ')}.`);
    f.team = team;
  }

  if (paged) {
    f.page = parsePositiveInt(query.page, 'page', 1, Infinity) ?? 1;
    f.limit = parsePositiveInt(query.limit, 'limit', 1, MAX_LIMIT) ?? DEFAULT_LIMIT;
  }
  return f;
}

// a malformed request (missing fields, form-encoded body) is a 400, not a misleading "wrong password"
function readCredentials(req) {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw new BadRequest('Send a JSON body with "email" and "password", and the header Content-Type: application/json.');
  }
  return { email, password };
}

function parsePositiveInt(value, name, min, max) {
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    const range = max === Infinity ? `${min} or more` : `between ${min} and ${max}`;
    throw new BadRequest(`"${name}" must be a whole number ${range}. Got "${value}".`);
  }
  return Number(value);
}

// filtering happens server-side; a plain filter is plenty fast for ~2,000 rows
function applyFilters(f) {
  return data.visits.filter(
    (v) =>
      (!f.from || v.date >= f.from) &&
      (!f.to || v.date <= f.to) &&
      (!f.type || v.type === f.type) &&
      (!f.team || v.hostTeam === f.team)
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function friendlyDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return `${DAY_NAMES[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function friendlyList(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// plain-english caveats about unreliable periods. written here so the page and curl users
// see the same explanation.
function dataNotes(f) {
  const from = f.from || data.firstDate;
  const to = f.to || data.lastDate;
  const inRange = (d) => d >= from && d <= to;
  const missing = data.missingDays.filter(inRange);
  const notes = [];
  if (to < data.firstDate || from > data.lastDate) {
    notes.push(`The sign-in log only covers ${friendlyDate(data.firstDate)} to ${friendlyDate(data.lastDate)}, so there's nothing to show for this period.`);
  } else if (from < data.firstDate || to > data.lastDate) {
    notes.push(`The sign-in log only covers ${friendlyDate(data.firstDate)} to ${friendlyDate(data.lastDate)}; dates outside that aren't counted.`);
  }
  if (missing.length) {
    // dana confirmed the ipad was down and the office was open, so this is missing data, not a quiet week
    notes.push(
      `No sign-ins at all were recorded on ${friendlyList(missing.map(friendlyDate))}. The lobby iPad was down those days while the office was open as normal, ` +
        `so this isn't a quiet period. Totals for this period are too low, and those days are left out of the daily averages.`
    );
  }
  return { missingDays: missing, coverage: { from: data.firstDate, to: data.lastDate }, notes };
}

// 9 -> "9am–10am"
function hourLabel(h) {
  const fmt = (x) => `${((x + 11) % 12) + 1}${x < 12 ? 'am' : 'pm'}`;
  return `${fmt(h)}–${fmt(h + 1)}`;
}

function buildStats(f) {
  const rows = applyFilters(f);

  // busiest day = average per day with records, not a raw total. otherwise the missing
  // august week drags mon–thu down. it also means fridays are only compared with fridays.
  const dates = [...data.daysWithData].filter((d) => (!f.from || d >= f.from) && (!f.to || d <= f.to));
  const byDay = [1, 2, 3, 4, 5].map((wd) => {
    const daysRecorded = dates.filter((d) => new Date(d + 'T00:00:00Z').getUTCDay() === wd).length;
    const visits = rows.filter((v) => v.weekday === wd).length;
    return {
      day: DAY_NAMES[wd],
      visits,
      daysRecorded,
      averagePerDay: daysRecorded ? Math.round((visits / daysRecorded) * 10) / 10 : null,
    };
  });

  // arrivals per hour, not occupancy: ~45% never sign out, so "how many inside" isn't reliable.
  // always show at least 8am–6pm so the chart keeps its shape across filters.
  const hours = rows.map((v) => v.hour);
  const firstHour = Math.min(8, ...hours);
  const lastHour = Math.max(17, ...hours);
  const byHour = [];
  for (let h = firstHour; h <= lastHour; h++) {
    byHour.push({ hour: h, label: hourLabel(h), visits: rows.filter((v) => v.hour === h).length });
  }

  const pickMax = (list, key) =>
    list.reduce((best, x) => (x[key] !== null && (!best || x[key] > best[key]) ? x : best), null);
  const busiestDay = rows.length ? pickMax(byDay, 'averagePerDay') : null;
  const busiestHour = rows.length ? pickMax(byHour, 'visits') : null;

  const countBy = (key) => {
    const out = {};
    for (const v of rows) out[v[key]] = (out[v[key]] || 0) + 1;
    return out;
  };
  const durations = rows.filter((v) => v.durationMinutes !== null).map((v) => v.durationMinutes);

  // counts only, no identities, so this is safe for both roles
  return {
    filters: f,
    totalVisits: rows.length,
    daysWithVisits: new Set(rows.map((v) => v.date)).size,
    daysRecorded: dates.length,
    busiestDay: busiestDay && { day: busiestDay.day, averagePerDay: busiestDay.averagePerDay },
    busiestHour: busiestHour && { label: busiestHour.label, visits: busiestHour.visits },
    byDayOfWeek: byDay,
    byHour,
    byType: countBy('type'),
    byHostTeam: countBy('hostTeam'),
    preRegistered: rows.filter((v) => v.preRegistered).length,
    signOuts: {
      recorded: durations.length,
      notRecorded: rows.length - durations.length,
    },
    ...dataNotes(f),
  };
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

// don't let browsers or proxies cache visitor data
app.use(['/api', '/auth'], (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.post('/auth/signup', (req, res) => {
  const { email, password } = readCredentials(req);
  const user = accounts.createAccount(allowedUsers, email, password);
  res.status(201).json({ message: 'Account created. You can sign in now.', email: user.email });
});

app.post('/auth/login', (req, res) => {
  const { email, password } = readCredentials(req);
  const { token, user, maxAgeMs } = accounts.login(allowedUsers, email, password);
  // httpOnly so page scripts can't read it; sameSite=lax blocks cross-site POSTs
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: maxAgeMs, path: '/' });
  res.json({ token, user: { email: user.email, name: user.name, role: user.role } });
});

app.post('/auth/logout', (req, res) => {
  accounts.logout(sessionToken(req));
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ message: 'Signed out.' });
});

// everything under /api needs a session; applied once so a new route can't forget it
app.use('/api', requireUser);

app.get('/api/me', (req, res) => {
  const u = req.user;
  res.json({
    user: { email: u.email, name: u.name, role: u.role },
    permissions: { seeVisitorIdentity: canSeeIdentity(u), manageUsers: u.role === 'admin' },
    options: {
      visitTypes: VISIT_TYPES,
      hostTeams: data.teams,
      coverage: { from: data.firstDate, to: data.lastDate },
      missingDays: data.missingDays,
    },
  });
});

app.get('/api/visits', (req, res) => {
  const f = parseFilters(req.query, { paged: true });
  const rows = applyFilters(f);
  const totalPages = Math.max(1, Math.ceil(rows.length / f.limit));
  // asking past the last page is a mistake, so it gets a 400 rather than an empty 200
  if (f.page > totalPages) {
    throw new BadRequest(`There's no page ${f.page}. These filters give ${rows.length} visits, ${totalPages} page(s) of ${f.limit}.`);
  }
  const start = (f.page - 1) * f.limit;
  res.json({
    filters: f,
    total: rows.length,
    page: f.page,
    limit: f.limit,
    totalPages,
    visits: rows.slice(start, start + f.limit).map((v) => shapeVisit(v, req.user)),
    ...dataNotes(f),
  });
});

app.get('/api/visits/:id', (req, res) => {
  const id = req.params.id.trim().toUpperCase();
  if (!/^V\d{6}$/.test(id)) {
    throw new BadRequest(`"${req.params.id}" isn't a visit ID. They look like V000123.`);
  }
  const visit = data.byId.get(id);
  if (visit) return res.json({ visit: shapeVisit(visit, req.user) });

  // explain removed duplicates instead of a bare "not found"
  const dup = data.duplicates.find((d) => d.id === id);
  if (dup) {
    return res.status(404).json({
      error: `${id} is a second record of the same arrival (the badge was reprinted), so it isn't counted. The real visit is ${dup.duplicateOf}.`,
      duplicateOf: dup.duplicateOf,
    });
  }
  res.status(404).json({ error: `There's no visit ${id}.` });
});

// same filters as /api/visits, so the headline numbers always match the list
app.get('/api/stats', (req, res) => {
  res.json(buildStats(parseFilters(req.query, { paged: false })));
});

// requireAdmin is the real lock here; hiding the nav link is just a courtesy
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const signedUp = new Map(accounts.listAccounts().map((a) => [a.email, a]));
  const users = [...allowedUsers.values()].map((u) => {
    const a = signedUp.get(u.email);
    return { ...u, signedUp: !!a, signedUpAt: a?.created_at ?? null, lastSignInAt: a?.last_login_at ?? null };
  });
  // accounts whose email was later removed from the list (they can no longer sign in)
  const removed = [...signedUp.values()]
    .filter((a) => !allowedUsers.has(a.email))
    .map((a) => ({ email: a.email, signedUpAt: a.created_at }));
  res.json({ users, removedFromList: removed });
});

app.use(['/api', '/auth'], (req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.originalUrl.split('?')[0]}` });
});

// ---------------------------------------------------------------------------
// pages: every page url gets the same index.html and app.js routes in the browser.
// that's what makes refresh and pasted links work. unknown paths get the shell
// too (so it can draw "page not found") but with a real 404 status.
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const PAGE_ROUTES = [/^\/$/, /^\/login$/, /^\/signup$/, /^\/visits$/, /^\/visits\/[^/]+$/, /^\/admin\/users$/];
app.use((req, res) => {
  if (req.method !== 'GET') return res.status(404).json({ error: 'Not found.' });
  const known = PAGE_ROUTES.some((r) => r.test(req.path.replace(/\/+$/, '') || '/'));
  res.status(known ? 200 : 404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

// known errors become clear 4xx responses; anything else is a generic 500 with no internals leaked.
// (express needs all 4 args to treat this as an error handler.)
app.use((err, req, res, next) => {
  if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
  if (err instanceof accounts.AccountError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'The request body isn’t valid JSON.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side.' });
});

// only listen when run directly, so the setup script can import this without starting a server
if (require.main === module) {
  app.listen(PORT, () => console.log(`Front Desk running at http://localhost:${PORT}`));
}

module.exports = { app, allowedUsers };
