// backend/db.js - sql.js version for Vercel compatibility
const fs = require('fs');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || '/tmp/mailsense.db';

let dbInstance = null;

async function initDb() {
  if (dbInstance) return dbInstance;

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  let db;
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  function saveDb() {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }

  db.run(`PRAGMA journal_mode = WAL`);
  db.run(`PRAGMA foreign_keys = ON`);

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name  TEXT    NOT NULL,
    last_name   TEXT    NOT NULL,
    email       TEXT    NOT NULL UNIQUE,
    password    TEXT    NOT NULL,
    role        TEXT    NOT NULL DEFAULT 'user',
    agent_mode  TEXT    NOT NULL DEFAULT 'safe',
    is_verified INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS otp_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    NOT NULL,
    code       TEXT    NOT NULL,
    type       TEXT    NOT NULL,
    expires_at TEXT    NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS gmail_tokens (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email     TEXT    NOT NULL UNIQUE,
    access_token   TEXT    NOT NULL,
    refresh_token  TEXT,
    token_expiry   TEXT,
    scope          TEXT,
    connected_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS emails (
    id           TEXT    PRIMARY KEY,
    user_email   TEXT    NOT NULL,
    gmail_id     TEXT    NOT NULL,
    thread_id    TEXT,
    from_addr    TEXT,
    from_name    TEXT,
    subject      TEXT,
    snippet      TEXT,
    body         TEXT,
    tag          TEXT    DEFAULT 'important',
    color        TEXT    DEFAULT '#4f6ef7',
    replied      INTEGER DEFAULT 0,
    archived     INTEGER DEFAULT 0,
    deleted      INTEGER DEFAULT 0,
    email_time   TEXT,
    fetched_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS agent_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT    NOT NULL,
    dot_color  TEXT    NOT NULL DEFAULT 'blue',
    message    TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS agent_stats (
    user_email TEXT    PRIMARY KEY,
    total      INTEGER DEFAULT 0,
    important  INTEGER DEFAULT 0,
    promo      INTEGER DEFAULT 0,
    spam       INTEGER DEFAULT 0,
    replied    INTEGER DEFAULT 0,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);

  saveDb();

  function prepare(sql) {
    return {
      run(...args) {
        const p = args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : args;
        db.run(sql, p);
        saveDb();
        return { changes: db.getRowsModified() };
      },
      get(...args) {
        const p = args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : args;
        const stmt = db.prepare(sql);
        stmt.bind(p);
        const row = stmt.step() ? stmt.getAsObject() : undefined;
        stmt.free();
        return row;
      },
      all(...args) {
        const p = args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : args;
        const stmt = db.prepare(sql);
        stmt.bind(p);
        const results = [];
        while (stmt.step()) results.push(stmt.getAsObject());
        stmt.free();
        return results;
      }
    };
  }

  const stmts = {
    getUserByEmail:   prepare('SELECT * FROM users WHERE email = ?'),
    createUser:       prepare('INSERT INTO users (first_name, last_name, email, password, role, is_verified) VALUES ($first_name, $last_name, $email, $password, $role, $is_verified)'),
    verifyUser:       prepare('UPDATE users SET is_verified = 1 WHERE email = ?'),
    updatePassword:   prepare('UPDATE users SET password = ? WHERE email = ?'),
    deleteUser:       prepare('DELETE FROM users WHERE email = ?'),
    insertOTP:        prepare('INSERT INTO otp_codes (email, code, type, expires_at) VALUES ($email, $code, $type, $expires_at)'),
    getValidOTP:      prepare("SELECT * FROM otp_codes WHERE email = ? AND type = ? AND used = 0 AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1"),
    markOTPUsed:      prepare('UPDATE otp_codes SET used = 1 WHERE id = ?'),
    getToken:         prepare('SELECT * FROM gmail_tokens WHERE user_email = ?'),
    upsertToken:      prepare('INSERT INTO gmail_tokens (user_email, access_token, refresh_token, token_expiry, scope) VALUES ($user_email, $access_token, $refresh_token, $token_expiry, $scope) ON CONFLICT(user_email) DO UPDATE SET access_token = excluded.access_token, refresh_token = COALESCE(excluded.refresh_token, gmail_tokens.refresh_token), token_expiry = excluded.token_expiry, scope = excluded.scope'),
    deleteToken:      prepare('DELETE FROM gmail_tokens WHERE user_email = ?'),
    upsertEmail:      prepare('INSERT INTO emails (id, user_email, gmail_id, thread_id, from_addr, from_name, subject, snippet, body, tag, color, email_time) VALUES ($id, $user_email, $gmail_id, $thread_id, $from_addr, $from_name, $subject, $snippet, $body, $tag, $color, $email_time) ON CONFLICT(id) DO UPDATE SET tag = excluded.tag, snippet = excluded.snippet, body = excluded.body'),
    getEmails:        prepare('SELECT * FROM emails WHERE user_email = ? AND deleted = 0 ORDER BY fetched_at DESC LIMIT 100'),
    markEmailReplied: prepare('UPDATE emails SET replied = 1 WHERE id = ?'),
    insertLog:        prepare('INSERT INTO agent_logs (user_email, dot_color, message) VALUES (?, ?, ?)'),
    getLogs:          prepare('SELECT * FROM agent_logs WHERE user_email = ? ORDER BY id DESC LIMIT 100'),
    upsertStats:      prepare("INSERT INTO agent_stats (user_email, total, important, promo, spam, replied) VALUES ($user_email, $total, $important, $promo, $spam, $replied) ON CONFLICT(user_email) DO UPDATE SET total = excluded.total, important = excluded.important, promo = excluded.promo, spam = excluded.spam, replied = excluded.replied, updated_at = datetime('now')"),
  };

  function markEmailsDeleted(userEmail, emailIds) {
    if (!emailIds.length) return;
    const ph = emailIds.map(() => '?').join(',');
    db.run(`UPDATE emails SET deleted = 1 WHERE user_email = ? AND id IN (${ph})`, [userEmail, ...emailIds]);
    saveDb();
  }

  function recomputeStats(userEmail) {
    const rows = db.exec(`SELECT tag, COUNT(*) as cnt FROM emails WHERE user_email = '${userEmail}' AND deleted = 0 GROUP BY tag`);
    const repliedRows = db.exec(`SELECT COUNT(*) as cnt FROM emails WHERE user_email = '${userEmail}' AND replied = 1 AND deleted = 0`);
    const stats = { user_email: userEmail, total: 0, important: 0, promo: 0, spam: 0, replied: 0 };
    if (repliedRows.length && repliedRows[0].values.length) stats.replied = repliedRows[0].values[0][0];
    if (rows.length) {
      for (const [tag, cnt] of rows[0].values) {
        stats.total += cnt;
        if (tag === 'important') stats.important = cnt;
        if (tag === 'promo')     stats.promo     = cnt;
        if (tag === 'spam')      stats.spam      = cnt;
      }
    }
    stmts.upsertStats.run(stats);
    return stats;
  }

  function query(sql, ...params)    { return prepare(sql).all(...params); }
  function queryOne(sql, ...params) { return prepare(sql).get(...params); }
  function exec(sql, ...params)     { return prepare(sql).run(...params); }

  dbInstance = { db, stmts, recomputeStats, markEmailsDeleted, query, queryOne, exec, saveDb };
  return dbInstance;
}

module.exports = { initDb };