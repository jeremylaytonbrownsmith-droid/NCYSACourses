// Persistence layer.
//
// Source of truth is an in-memory `db` object. Reads are always synchronous
// against that object, so the whole app (and its tests) treat the store the
// same way regardless of backend.
//
// Two persistence backends:
//   * Local JSON file (dev / tests / when Firestore isn't configured) — the
//     whole db is written to data/db.json. Simple and fine at small scale.
//   * Firebase Firestore (production) — each unbounded collection (users,
//     enrollments, lessonProgress, notifications, outbox, sessions) is stored
//     as INDIVIDUAL per-record documents in a subcollection, and the small
//     bounded data (courses + migration flags) lives on one `store` document.
//     Only records that actually changed since the last save are written, in
//     batches. This is what lets the platform scale to tens of thousands of
//     learners: there is no single-document size ceiling (Firestore caps a
//     document at ~1 MiB) and a progress save touches one record, not the
//     whole database.
//
// Enable Firestore by setting FIREBASE_SERVICE_ACCOUNT (the service-account
// JSON as a string) or GOOGLE_APPLICATION_CREDENTIALS (path to the JSON).
// When it isn't configured the app runs identically on the local JSON file.
//
// NOTE (next scale step, when a partner actually onboards tens of thousands of
// active learners): lessonProgress is the one collection that grows without
// bound AND carries SCORM suspend data, so the follow-up is to query it on
// demand by learner instead of holding it all in memory. The data is already
// stored per-record here, so that change is incremental and isolated to the
// six lessonProgress call sites — no further storage rework needed.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
// Legacy single-document location (pre-scale). Read once to migrate, then left
// in place as a backup — never written to again.
const LEGACY_DOC = process.env.FIRESTORE_DOC || 'ncysa-learn/db';
// New per-record root: a `store` document holding courses + migrations, with a
// subcollection per unbounded collection beneath it.
const STORE_DOC = process.env.FIRESTORE_STORE_DOC || 'ncysa-learn/store';

const EMPTY = {
  courses: [],         // editable course catalog (seeded from data/courses.js)
  migrations: {},       // one-time migration flags (bounded)
  users: [],
  sessions: {},        // token -> userId
  enrollments: [],     // { userId, courseId, startedAt, completedAt, certId }
  lessonProgress: [],  // { userId, courseId, lessonId, watchedSeconds, completed, completedAt, quizScore, scorm? }
  notifications: [],   // { id, audience: 'user'|'ncysa', userId?, title, body, createdAt, read }
  outbox: [],          // { id, to, subject, body, createdAt, channel, status }
};

// Unbounded collections stored as per-record documents in Firestore.
const SUBCOLLECTIONS = ['users', 'enrollments', 'lessonProgress', 'notifications', 'outbox', 'sessions'];

let db = null;

// ---- optional Firebase Firestore mirror ----------------------------------
let firestore = null;      // Firestore instance when configured
let firestoreReady = false;
let injectedFirestore = null; // tests inject a fake here

function initFirestore() {
  if (injectedFirestore) {
    firestore = injectedFirestore;
    if (firestore.settings) { try { firestore.settings({ ignoreUndefinedProperties: true }); } catch (e) { /* fake may no-op */ } }
    firestoreReady = true;
    return firestore;
  }
  const hasCreds = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const emulator = process.env.FIRESTORE_EMULATOR_HOST; // set by the local emulator/tests
  if (!hasCreds && !emulator) return null;
  try {
    const admin = require('firebase-admin'); // lazy: only needed when enabled
    if (!admin.apps.length) {
      if (emulator && !hasCreds) {
        // Emulator needs only a project id, no real credentials.
        admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'ncysa-learn' });
      } else {
        const cred = process.env.FIREBASE_SERVICE_ACCOUNT
          ? admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
          : admin.credential.applicationDefault();
        admin.initializeApp({ credential: cred, projectId: process.env.FIREBASE_PROJECT_ID || undefined });
      }
    }
    firestore = admin.firestore();
    // Firestore rejects `undefined` field values by default and throws
    // synchronously when it hits one; our documents legitimately carry optional
    // fields (e.g. a lesson's videoUrlWebm), so tell it to skip them instead.
    firestore.settings({ ignoreUndefinedProperties: true });
    firestoreReady = true;
    console.log('[store] Firestore per-record persistence enabled.');
    return firestore;
  } catch (e) {
    console.warn('[store] Firestore not enabled (' + e.message + '); using local JSON file.');
    return null;
  }
}

// ---- Firestore document references ----------------------------------------
function storeRef() { return firestore.doc(STORE_DOC); }
function legacyRef() { return firestore.doc(LEGACY_DOC); }
function subDocRef(coll, docId) { return firestore.doc(`${STORE_DOC}/${coll}/${docId}`); }
function subColRef(coll) { return firestore.collection(`${STORE_DOC}/${coll}`); }

// A record's document id within its subcollection. Composite-keyed collections
// (enrollments, lessonProgress) get a deterministic id built from their keys so
// the same logical record always maps to the same document.
function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }
function docIdFor(coll, rec) {
  switch (coll) {
    case 'users': return enc(rec.id);
    case 'notifications': return enc(rec.id);
    case 'outbox': return enc(rec.id);
    case 'enrollments': return `${enc(rec.userId)}__${enc(rec.courseId)}`;
    case 'lessonProgress': return `${enc(rec.userId)}__${enc(rec.courseId)}__${enc(rec.lessonId)}`;
    default: return enc(rec.id);
  }
}

// Enumerate the current live records of a collection as [docId, record] pairs.
// sessions is a token->userId map; everything else is an array.
function* currentRecords(coll) {
  if (coll === 'sessions') {
    for (const [token, userId] of Object.entries(db.sessions || {})) yield [enc(token), { userId }];
    return;
  }
  for (const rec of (db[coll] || [])) yield [docIdFor(coll, rec), rec];
}

// Cheap content fingerprint (djb2 over the JSON) so the dirty snapshot holds a
// small number per record instead of a second full copy of the data.
function fingerprint(obj) {
  const s = JSON.stringify(obj);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

// snap.meta  = fingerprint of { courses, migrations }
// snap.colls[coll] = Map(docId -> fingerprint) of what Firestore currently holds
let snap = null;
function buildSnapshot(empty) {
  snap = { meta: empty ? null : fingerprint(metaDoc()), colls: {} };
  for (const coll of SUBCOLLECTIONS) {
    const m = new Map();
    if (!empty) for (const [docId, rec] of currentRecords(coll)) m.set(docId, fingerprint(rec));
    snap.colls[coll] = m;
  }
}

function metaDoc() { return { courses: db.courses || [], migrations: db.migrations || {} }; }

// Compute the set of writes/deletes needed to bring Firestore in line with the
// in-memory db, updating the snapshot to match. Returns an array of ops.
function diffOps() {
  const ops = [];
  const meta = metaDoc();
  const metaFp = fingerprint(meta);
  if (snap.meta !== metaFp) { ops.push({ kind: 'set', ref: storeRef(), data: meta }); snap.meta = metaFp; }
  for (const coll of SUBCOLLECTIONS) {
    const prev = snap.colls[coll];
    const seen = new Set();
    for (const [docId, rec] of currentRecords(coll)) {
      seen.add(docId);
      const fp = fingerprint(rec);
      if (prev.get(docId) !== fp) { ops.push({ kind: 'set', ref: subDocRef(coll, docId), data: rec }); prev.set(docId, fp); }
    }
    for (const docId of [...prev.keys()]) {
      if (!seen.has(docId)) { ops.push({ kind: 'delete', ref: subDocRef(coll, docId) }); prev.delete(docId); }
    }
  }
  return ops;
}

// Apply ops in Firestore batches (max 500 ops/batch).
async function flushOps(ops) {
  for (let i = 0; i < ops.length; i += 450) {
    const batch = firestore.batch();
    for (const op of ops.slice(i, i + 450)) {
      if (op.kind === 'delete') batch.delete(op.ref); else batch.set(op.ref, op.data);
    }
    await batch.commit();
  }
}

let flushChain = Promise.resolve();
function persistDirty() {
  let ops;
  try { ops = diffOps(); } catch (e) { console.warn('[store] diff failed: ' + e.message); return; }
  if (!ops.length) return;
  // Serialize flushes so overlapping saves never race. On failure, drop the
  // snapshot so the next save re-syncs everything (self-healing).
  flushChain = flushChain.then(() => flushOps(ops)).catch((e) => {
    console.warn('[store] Firestore write failed (' + e.message + '); will re-sync on next save.');
    try { buildSnapshot(true); } catch (_) { /* ignore */ }
  });
}

// ---- local file backend ---------------------------------------------------
function writeLocal() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function load() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    db = { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch {
    db = structuredClone(EMPTY);
  }
  return db;
}

// Called once at startup (awaited) so cloud state seeds the in-memory db.
async function initFromCloud() {
  initFirestore();
  if (!firestoreReady) return;
  load(); // ensure `db` exists (local cache / EMPTY) before we overwrite it
  try {
    const storeSnap = await storeRef().get();
    if (storeSnap.exists) {
      // New per-record layout: load meta + each subcollection.
      const meta = storeSnap.data() || {};
      db = structuredClone(EMPTY);
      db.courses = meta.courses || [];
      db.migrations = meta.migrations || {};
      for (const coll of SUBCOLLECTIONS) {
        const qs = await subColRef(coll).get();
        if (coll === 'sessions') {
          db.sessions = {};
          qs.forEach((d) => { db.sessions[decodeURIComponent(d.id)] = (d.data() || {}).userId; });
        } else {
          db[coll] = qs.docs.map((d) => d.data());
        }
      }
      buildSnapshot();
      console.log('[store] Loaded per-record state from Firestore.');
      return;
    }
    // No new layout yet — migrate from the legacy single document if present.
    const legacy = await legacyRef().get();
    if (legacy.exists) {
      db = { ...structuredClone(EMPTY), ...legacy.data() };
      console.log('[store] Migrating legacy single-document state to per-record layout…');
      buildSnapshot(true);      // pretend Firestore is empty so every record is written
      await flushOps(diffOps()); // write the whole database out, once, synchronously
      console.log('[store] Legacy migration complete (' + (db.users || []).length + ' users).');
      return;
    }
    // Fresh cloud with nothing stored yet: keep whatever load() gave us and let
    // the first save() populate Firestore.
    buildSnapshot(true);
  } catch (e) {
    console.warn('[store] Firestore init failed (' + e.message + '); using local state.');
    firestoreReady = false; // fall back to the local file so the app still runs
  }
}

function save() {
  if (firestoreReady) persistDirty(); // production: per-record write-through, no whole-db write
  else writeLocal();                  // dev/tests: whole-file JSON
}

function id(prefix) {
  return prefix + '_' + require('crypto').randomBytes(8).toString('hex');
}

// Test hooks: inject a fake Firestore and reset in-memory state between cases.
function _injectFirestore(fake) { injectedFirestore = fake; firestore = null; firestoreReady = false; }
function _reset() { db = null; snap = null; flushChain = Promise.resolve(); firestore = null; firestoreReady = false; injectedFirestore = null; }
async function _drain() { await flushChain; }

module.exports = { load, save, id, initFromCloud, _injectFirestore, _reset, _drain };
