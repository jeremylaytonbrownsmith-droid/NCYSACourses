// Tiny JSON-file persistence layer. Swap for SQLite/Postgres when the
// platform outgrows a single instance — the API surface is deliberately small.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = {
  users: [],
  sessions: {},        // token -> userId
  enrollments: [],     // { userId, courseId, startedAt, completedAt, certId }
  lessonProgress: [],  // { userId, courseId, lessonId, watchedSeconds, completed, completedAt, quizScore }
  notifications: [],   // { id, audience: 'user'|'ncysa', userId?, title, body, createdAt, read }
  outbox: [],          // { id, to, subject, body, createdAt, channel, status }
};

let db = null;

function load() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    db = { ...EMPTY, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch {
    db = structuredClone(EMPTY);
  }
  return db;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function id(prefix) {
  return prefix + '_' + require('crypto').randomBytes(8).toString('hex');
}

module.exports = { load, save, id };
