// Persistence layer.
//
// Source of truth is an in-memory `db` object, mirrored to a local JSON file so
// progress survives restarts on a single instance. For durable, cross-device
// cloud storage it can ALSO write through to Firebase Firestore — enable it by
// setting FIREBASE_SERVICE_ACCOUNT (the service-account JSON as a string) or
// GOOGLE_APPLICATION_CREDENTIALS (path to the JSON), and `npm i firebase-admin`.
// When Firestore isn't configured or the SDK isn't installed, this quietly
// falls back to the JSON file — the app runs identically either way.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const FIRESTORE_DOC = process.env.FIRESTORE_DOC || 'ncysa-learn/db';

const EMPTY = {
  users: [],
  sessions: {},        // token -> userId
  enrollments: [],     // { userId, courseId, startedAt, completedAt, certId }
  lessonProgress: [],  // { userId, courseId, lessonId, watchedSeconds, completed, completedAt, quizScore }
  notifications: [],   // { id, audience: 'user'|'ncysa', userId?, title, body, createdAt, read }
  outbox: [],          // { id, to, subject, body, createdAt, channel, status }
};

let db = null;

// ---- optional Firebase Firestore mirror ----------------------------------
let firestore = null;      // Firestore instance when configured
let firestoreReady = false;

function initFirestore() {
  const hasCreds = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!hasCreds) return null;
  try {
    const admin = require('firebase-admin'); // lazy: only needed when enabled
    if (!admin.apps.length) {
      const cred = process.env.FIREBASE_SERVICE_ACCOUNT
        ? admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
        : admin.credential.applicationDefault();
      admin.initializeApp({ credential: cred });
    }
    firestore = admin.firestore();
    firestoreReady = true;
    console.log('[store] Firestore mirror enabled.');
    return firestore;
  } catch (e) {
    console.warn('[store] Firestore not enabled (' + e.message + '); using local JSON file.');
    return null;
  }
}

function docRef() {
  const [col, doc] = FIRESTORE_DOC.split('/');
  return firestore.collection(col).doc(doc);
}

// Called once at startup (awaited) so cloud state seeds the in-memory db.
async function initFromCloud() {
  initFirestore();
  if (!firestoreReady) return;
  try {
    const snap = await docRef().get();
    if (snap.exists) {
      db = { ...EMPTY, ...load(), ...snap.data() };
      writeLocal();
      console.log('[store] Loaded state from Firestore.');
    }
  } catch (e) {
    console.warn('[store] Firestore read failed (' + e.message + '); using local state.');
  }
}

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
    db = { ...EMPTY, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch {
    db = structuredClone(EMPTY);
  }
  return db;
}

function save() {
  writeLocal();
  // Write through to Firestore (fire-and-forget; local file stays authoritative
  // for reads, so a transient cloud error never blocks or loses a learner's
  // progress locally).
  if (firestoreReady) {
    docRef().set(db).catch((e) => console.warn('[store] Firestore write failed: ' + e.message));
  }
}

function id(prefix) {
  return prefix + '_' + require('crypto').randomBytes(8).toString('hex');
}

module.exports = { load, save, id, initFromCloud };
