// loads and cleans the two csv exports once, at startup.
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const DATA_DIR = path.join(__dirname, '..', 'data');

const VISIT_TYPES = ['interview', 'guest', 'contractor', 'vendor'];
const ROLES = ['admin', 'viewer'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// double sign-ins (badge printer retries, per dana) are 11–95s apart in the data.
// 5 minutes catches all of them without merging genuinely separate visits.
const DUPLICATE_WINDOW_SECONDS = 5 * 60;

function readCsv(file) {
  return parse(fs.readFileSync(path.join(DATA_DIR, file)), {
    columns: (header) => header.map((h) => h.trim().toLowerCase()),
    bom: true,
    skip_empty_lines: true,
    trim: true, // the allowed list has padded emails and crlf line endings
  });
}

// match emails the way a person expects: ignore case and surrounding spaces
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// timestamps have no timezone. parsing them as utc keeps the maths independent of the server's timezone.
function toSeconds(ts) {
  return Date.parse(ts.replace(' ', 'T') + 'Z') / 1000;
}

function dayOfWeek(date) {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

function loadAllowedUsers() {
  const users = new Map();
  for (const row of readCsv('allowed_users.csv')) {
    const email = normalizeEmail(row.email);
    const role = String(row.role || '').trim().toLowerCase();
    if (!email || !ROLES.includes(role)) {
      // fail closed: a row we can't read grants nothing
      console.warn(`allowed_users.csv: skipping unusable row ${JSON.stringify(row)}`);
      continue;
    }
    if (users.has(email)) console.warn(`allowed_users.csv: ${email} listed twice, keeping first`);
    else users.set(email, { email, name: row.name, role });
  }
  return users;
}

function loadVisits() {
  const raw = readCsv('visits.csv').map((r) => ({
    id: r.visit_id,
    date: r.visit_date,
    signedInAt: r.signed_in_at,
    signedOutAt: r.signed_out_at || null,
    visitorName: r.visitor_name,
    visitorEmail: r.visitor_email,
    visitorCompany: r.visitor_company,
    type: r.visit_type.toLowerCase(),
    hostName: r.host_name,
    hostEmail: r.host_email,
    hostTeam: r.host_team,
    preRegistered: r.pre_registered.toLowerCase() === 'true',
  }));

  // sorted so the first copy of a double sign-in is always seen first
  raw.sort((a, b) => a.signedInAt.localeCompare(b.signedInAt) || a.id.localeCompare(b.id));

  // drop double sign-ins, keeping the first row (the real arrival, and the only one with a sign-out)
  const lastSeen = new Map();
  const visits = [];
  const duplicates = [];
  for (const v of raw) {
    const key = [v.date, normalizeEmail(v.visitorEmail), normalizeEmail(v.hostEmail)].join('|');
    const prev = lastSeen.get(key);
    if (prev && toSeconds(v.signedInAt) - toSeconds(prev.signedInAt) <= DUPLICATE_WINDOW_SECONDS) {
      duplicates.push({ id: v.id, duplicateOf: prev.id, date: v.date });
      continue;
    }
    lastSeen.set(key, v);
    v.weekday = dayOfWeek(v.date);
    v.hour = Number(v.signedInAt.slice(11, 13));
    v.durationMinutes = v.signedOutAt
      ? Math.round((toSeconds(v.signedOutAt) - toSeconds(v.signedInAt)) / 60)
      : null;
    visits.push(v);
  }

  // weekdays with zero sign-ins mean the log is missing (the ipad outage 10–13 aug).
  // detected from the data, not hardcoded, so a future gap is caught too.
  const daysWithData = new Set(visits.map((v) => v.date));
  const firstDate = visits[0].date;
  const lastDate = visits[visits.length - 1].date;
  const missingDays = [];
  for (let d = new Date(firstDate + 'T00:00:00Z'); d <= new Date(lastDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6 && !daysWithData.has(iso)) missingDays.push(iso);
  }

  return {
    visits,
    byId: new Map(visits.map((v) => [v.id, v])),
    duplicates,
    missingDays,
    daysWithData,
    firstDate,
    lastDate,
    teams: [...new Set(visits.map((v) => v.hostTeam))].sort(),
  };
}

module.exports = {
  VISIT_TYPES,
  DAY_NAMES,
  normalizeEmail,
  dayOfWeek,
  loadAllowedUsers,
  loadVisits,
};
