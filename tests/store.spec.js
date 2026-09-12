// Unit tests for the per-record Firestore persistence path (the production
// backend). Firestore is faked in-process so we can prove the scale-critical
// behaviour without an emulator: records are stored one document each, only
// changed records are written, removals delete their document, a restart
// reloads everything, and a legacy single-document store migrates cleanly.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

// Point the store at a throwaway data dir before requiring it (module reads it once).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'store-spec-'));
const store = require('../lib/store');

// ---- minimal in-process Firestore fake -----------------------------------
function makeFake() {
  const data = new Map(); // full path -> object
  const ops = [];         // log of {kind, path} for dirty-tracking assertions
  const docRef = (p) => ({
    path: p,
    async get() { return { exists: data.has(p), id: p.split('/').pop(), data: () => data.get(p) }; },
    async set(d) { data.set(p, JSON.parse(JSON.stringify(d))); ops.push({ kind: 'set', path: p }); },
    async delete() { data.delete(p); ops.push({ kind: 'delete', path: p }); },
  });
  const colRef = (p) => ({
    async get() {
      const prefix = p + '/';
      const docs = [];
      for (const [k, v] of data) {
        if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) {
          docs.push({ id: k.slice(prefix.length), data: () => v });
        }
      }
      return { docs, forEach: (cb) => docs.forEach(cb) };
    },
  });
  return {
    settings() {},
    doc: (p) => docRef(p),
    collection: (p) => colRef(p),
    batch() {
      const q = [];
      return { set: (ref, d) => q.push(() => ref.set(d)), delete: (ref) => q.push(() => ref.delete()), commit: async () => { for (const f of q) await f(); } };
    },
    _data: data,
    _ops: ops,
  };
}

async function freshStore(fake) {
  store._reset();
  store._injectFirestore(fake);
  await store.initFromCloud();
  return store.load();
}

test('writes each record as its own document, and only changed records on later saves', async () => {
  const fake = makeFake();
  const db = await freshStore(fake);
  db.courses.push({ id: 'c1', title: 'C1' });
  db.users.push({ id: 'u1', email: 'a@b.com' }, { id: 'u2', email: 'c@d.com' });
  db.enrollments.push({ userId: 'u1', courseId: 'c1', startedAt: 't' });
  db.lessonProgress.push({ userId: 'u1', courseId: 'c1', lessonId: 'l1', watchedSeconds: 5 });
  db.sessions.tok1 = 'u1';
  store.save();
  await store._drain();

  expect(fake._data.get('ncysa-learn/store').courses.length).toBe(1);
  expect(fake._data.has('ncysa-learn/store/users/u1')).toBe(true);
  expect(fake._data.has('ncysa-learn/store/users/u2')).toBe(true);
  expect(fake._data.has('ncysa-learn/store/enrollments/u1__c1')).toBe(true);
  expect(fake._data.has('ncysa-learn/store/lessonProgress/u1__c1__l1')).toBe(true);
  expect(fake._data.has('ncysa-learn/store/sessions/tok1')).toBe(true);

  // Changing one lessonProgress record must write that one document and nothing else.
  fake._ops.length = 0;
  db.lessonProgress[0].watchedSeconds = 60;
  store.save();
  await store._drain();
  expect(fake._ops).toEqual([{ kind: 'set', path: 'ncysa-learn/store/lessonProgress/u1__c1__l1' }]);
});

test('removing a record deletes its document', async () => {
  const fake = makeFake();
  const db = await freshStore(fake);
  db.users.push({ id: 'u1', email: 'a@b.com' }, { id: 'u2', email: 'c@d.com' });
  store.save();
  await store._drain();
  expect(fake._data.has('ncysa-learn/store/users/u2')).toBe(true);

  fake._ops.length = 0;
  db.users = db.users.filter((u) => u.id !== 'u2');
  store.save();
  await store._drain();
  expect(fake._data.has('ncysa-learn/store/users/u2')).toBe(false);
  expect(fake._ops).toContainEqual({ kind: 'delete', path: 'ncysa-learn/store/users/u2' });
});

test('a restart reloads per-record state back into memory', async () => {
  const fake = makeFake();
  const db = await freshStore(fake);
  db.courses.push({ id: 'c1' });
  db.users.push({ id: 'u1', email: 'x' });
  db.enrollments.push({ userId: 'u1', courseId: 'c1' });
  db.sessions.t = 'u1';
  store.save();
  await store._drain();

  // Simulate a container restart: same cloud data, fresh memory.
  const db2 = await freshStore(fake);
  expect(db2.users.map((u) => u.id)).toEqual(['u1']);
  expect(db2.courses.map((c) => c.id)).toEqual(['c1']);
  expect(db2.enrollments[0]).toMatchObject({ userId: 'u1', courseId: 'c1' });
  expect(db2.sessions.t).toBe('u1');
});

test('migrates a legacy single-document store to the per-record layout', async () => {
  const fake = makeFake();
  fake._data.set('ncysa-learn/db', {
    courses: [{ id: 'c1' }],
    users: [{ id: 'u1', email: 'x' }, { id: 'u2', email: 'y' }],
    enrollments: [{ userId: 'u1', courseId: 'c1' }],
    migrations: { m1: 'done' },
    sessions: { tok: 'u1' },
  });
  const db = await freshStore(fake);

  expect(fake._data.get('ncysa-learn/store').migrations.m1).toBe('done');
  expect(fake._data.has('ncysa-learn/store/users/u1')).toBe(true);
  expect(fake._data.has('ncysa-learn/store/users/u2')).toBe(true);
  expect(fake._data.has('ncysa-learn/store/enrollments/u1__c1')).toBe(true);
  expect(fake._data.has('ncysa-learn/store/sessions/tok')).toBe(true);
  expect(db.users.length).toBe(2);
});
