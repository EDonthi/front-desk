# Front Desk

Brightline's lobby visit log: who came in, and when the lobby gets busy. It has two roles. An **admin** sees visitor identities; a **viewer** sees counts and the shape of each visit, but never a visitor's name or email. The API enforces both roles.

Node + Express, one process. Accounts and sessions live in a local SQLite file. Visits are loaded from `data/visits.csv` into memory at startup.

## Run it

```bash
npm install
npm run setup   # creates the two test accounts below (safe to run again)
npm start       # http://localhost:3000  (PORT=xxxx to change)
```

To start from a clean slate, delete `front-desk.db` and run `npm run setup` again.

### Test logins

| Role   | Email                               | Password           |
|--------|-------------------------------------|--------------------|
| admin  | `dana.whitfield@brightline.example` | `frontdesk-admin`  |
| viewer | `sam.ferreira@brightline.example`   | `frontdesk-viewer` |

These are demo passwords for this exercise only. `npm run setup` creates both accounts through the same sign-up rules as everyone else. The other six people on the list (for example `Marcus.Vitale@Brightline.example` or ` ines.reyes@brightline.example `, typed any way you like) can sign up themselves at `/signup`.

## curl examples

**1. Log in as the viewer.** The session cookie goes into `cookies.txt`. The response also returns a `token` you can send as `Authorization: Bearer <token>` instead.

```bash
curl -s -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"email":"sam.ferreira@brightline.example","password":"frontdesk-viewer"}' \
  http://localhost:3000/auth/login
```

**2. Filtered visits: interviews in August, first 20.**

```bash
curl -s -b cookies.txt \
  'http://localhost:3000/api/visits?type=interview&from=2026-08-01&to=2026-08-31&limit=20'
```

Each viewer row looks like this:

```json
{"id":"V000745","date":"2026-08-03","weekday":"Monday","signedInAt":"2026-08-03 11:26:00",
 "signedOutAt":"2026-08-03 11:52:00","durationMinutes":26,"type":"guest","hostTeam":"Engineering","preRegistered":true}
```

Log in as Dana and run the same call. Her rows also include `visitorName`, `visitorEmail`, `visitorCompany`, `hostName` and `hostEmail`.

Other calls worth trying:

```bash
curl -s -i http://localhost:3000/api/visits                                        # 401, no session
curl -s -b cookies.txt 'http://localhost:3000/api/visits?from=2026-09-01&to=2026-08-01'  # 400, dates swapped
curl -s -b cookies.txt 'http://localhost:3000/api/visits?type=party'               # 400, lists valid types
curl -s -b cookies.txt  http://localhost:3000/api/admin/users                      # 403 for a viewer
curl -s -b cookies.txt 'http://localhost:3000/api/stats?type=interview'
```

## API

Every `/api/*` call needs a session (cookie or Bearer token), and without one it gets `401 {"error": ...}`. Errors always come back as JSON in the form `{"error": "<what to change>"}`.

| Method & path | Who | Does |
|---|---|---|
| `POST /auth/signup` `{email, password}` | anyone | Creates an account if the email is on the list. `201`; `403` if not on the list; `409` if the account exists; `400` for a password under 8 characters. |
| `POST /auth/login` `{email, password}` | anyone | Sets an HttpOnly `fd_session` cookie (8 hours) and returns `{token, user}`. `401` on a wrong email or password. |
| `POST /auth/logout` | anyone | Ends the session. |
| `GET /api/me` | both | Your name, role, permissions, and the filter options (visit types, teams, date coverage). |
| `GET /api/visits` | both | Visit rows, filtered and paged on the server. Query params: `from`, `to` (YYYY-MM-DD), `type` (`interview`, `guest`, `contractor`, `vendor`), `team` (host team), `page` (default 1), `limit` (1–200, default 50). Returns `{total, page, totalPages, visits, notes, missingDays}`. |
| `GET /api/visits/:id` | both | One visit, e.g. `V000028`. `404` if unknown, with an explanation if the ID was a duplicate sign-in. |
| `GET /api/stats` | both | Counts for the same filters (no paging): total, busiest day of week (average per recorded day), busiest hour, counts by weekday, hour, type and team, and sign-out coverage. |
| `GET /api/admin/users` | admin | The allowed list, and who has signed up. `403` for viewers. |

Bad input always gets a `400` with a message: an end date before the start date, a date that doesn't exist (`2026-02-30`), an unknown visit type or team, an out-of-range `limit`, a `page` past the last one, a repeated param, an unknown param such as `?name=`, or a sign-up/login body that isn't JSON with `email` and `password`. A valid filter that simply matches nothing (e.g. a month outside the data) is a `200` with `total: 0` and a note explaining why.

## Pages

`/login`, `/signup`, `/visits` (filters live in the URL), `/visits/:id`, `/admin/users`, and a real 404 for anything else (it also returns HTTP 404). The server serves one HTML shell for every page, and `public/app.js` routes in the browser. That means refreshing, Back, and pasting a link all work.

## Where access is enforced

- **The real control is in `server.js`.** `requireUser` turns away anyone without a valid session. `requireAdmin` guards `/api/admin/*`. `shapeVisit()` builds each row from an explicit list of fields per role, so a viewer's JSON never contains a name, email or company field, not even as null.
- **Every request checks the allowed list**, and roles are never stored with the account. The list is read from `allowed_users.csv` at startup, so removing someone and restarting cuts their access, including any session they already have.
- **The page guards in `app.js` are a courtesy.** They hide the Users link from viewers, show a "you don't have access" page, and send signed-out users to login and then back to where they were going. If they were removed, the API would still refuse the data.
- **Viewers have no name search.** A name search would let a viewer test whether a name exists. Unknown query params are rejected with a 400.

## Data cleaning (done at startup, in `lib/data.js`)

- **`allowed_users.csv`:** emails are trimmed and lowercased, and the file has Windows line endings. Rows with an unknown role are skipped, so a bad row grants no access.
- **`visits.csv`:** 58 duplicate sign-ins are dropped. These are the same visitor, host and day, 11–95 seconds after the first row. That leaves 1,953 real visits.
- **Missing days:** weekdays with no sign-ins at all (Mon 10 to Thu 13 Aug) are detected. They're excluded from the daily averages and flagged on any view that covers them.

## Files

```
server.js            API, access rules, page fallback
lib/data.js          CSV loading and cleaning
lib/accounts.js      sign-up, login, sessions (SQLite, bcrypt)
scripts/demo-accounts.js
public/              index.html, app.js (router + pages), style.css
NOTE_TO_DANA.md      the note
```
