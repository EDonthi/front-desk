// accounts and sessions, stored in a local sqlite file.
// roles are deliberately not stored here: every request checks the allowed list (read from
// allowed_users.csv at startup), so removing someone revokes access on restart, even mid-session.
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { normalizeEmail } = require('./data');

const SESSION_HOURS = 8;
const MIN_PASSWORD_LENGTH = 8;

const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'front-desk.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    email         TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_login_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    email      TEXT NOT NULL REFERENCES accounts(email) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
`);

// only token hashes are stored, so a copy of the db can't be used to log in
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// carries an http status so server.js can return it without these functions knowing about express
class AccountError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createAccount(allowedUsers, rawEmail, password) {
  const email = normalizeEmail(rawEmail);
  if (!email || !email.includes('@')) throw new AccountError(400, 'Enter your work email address.');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new AccountError(400, `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (!allowedUsers.has(email)) {
    // friendly over cagey: a colleague with a typo is more likely than a stranger, and echoing
    // the email makes the typo visible. telling a stranger "not on the list" reveals little.
    throw new AccountError(
      403,
      `${email} isn't on the Front Desk access list. Check the spelling, or ask the Workplace team if you think you should have access.`
    );
  }
  const exists = db.prepare('SELECT 1 FROM accounts WHERE email = ?').get(email);
  if (exists) throw new AccountError(409, 'An account already exists for this email. Sign in instead.');

  db.prepare('INSERT INTO accounts (email, password_hash, created_at) VALUES (?, ?, ?)').run(
    email,
    bcrypt.hashSync(password, 10),
    new Date().toISOString()
  );
  return allowedUsers.get(email);
}

function login(allowedUsers, rawEmail, password) {
  const email = normalizeEmail(rawEmail);
  const account = db.prepare('SELECT * FROM accounts WHERE email = ?').get(email);
  // one message for every failure, so login can't reveal which emails have accounts.
  // the allowed-list check means a removed user can't sign in even with an old account.
  const ok = account && allowedUsers.has(email) && bcrypt.compareSync(String(password || ''), account.password_hash);
  if (!ok) throw new AccountError(401, 'That email and password don’t match. Check both and try again.');

  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, email, expires_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    email,
    Date.now() + SESSION_HOURS * 3600 * 1000
  );
  db.prepare('UPDATE accounts SET last_login_at = ? WHERE email = ?').run(new Date().toISOString(), email);
  return { token, user: allowedUsers.get(email), maxAgeMs: SESSION_HOURS * 3600 * 1000 };
}

// token -> allowed-list entry, or null if missing, expired, or no longer on the list
function userForToken(allowedUsers, token) {
  if (!token) return null;
  const row = db.prepare('SELECT email, expires_at FROM sessions WHERE token_hash = ?').get(hashToken(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  return allowedUsers.get(row.email) || null;
}

function logout(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

// never selects the password hash
function listAccounts() {
  return db.prepare('SELECT email, created_at, last_login_at FROM accounts').all();
}

module.exports = { AccountError, createAccount, login, userForToken, logout, listAccounts };
