import { randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function scopeOf({ platform, chat, group, thread }) {
  return JSON.stringify([platform, group ? 'group' : 'private', chat, thread ?? null]);
}

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox (
      id INTEGER PRIMARY KEY, platform TEXT NOT NULL, event TEXT NOT NULL,
      scope TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(platform, event)
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY REFERENCES inbox(id), text TEXT NOT NULL, random_id INTEGER NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS memory (
      scope TEXT NOT NULL, file TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(scope, file)
    );
  `);
  const put = db.prepare('INSERT INTO inbox(platform,event,scope,payload) VALUES (?,?,?,?) ON CONFLICT(platform,event) DO NOTHING');
  const saveCursor = db.prepare('INSERT INTO cursors VALUES (?,?) ON CONFLICT(source) DO UPDATE SET value=excluded.value');
  const saveReply = db.prepare('INSERT INTO outbox(id,text,random_id) VALUES(?,?,?) ON CONFLICT DO NOTHING');
  return {
    close: () => db.close(),
    ingest(source, cursor, events) {
      db.exec('BEGIN');
      try {
        for (const e of events) put.run(e.platform, e.event, scopeOf(e), JSON.stringify(e));
        saveCursor.run(source, String(cursor));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    cursor: (source) => db.prepare('SELECT value FROM cursors WHERE source=?').get(source)?.value,
    nextInput: () => db.prepare('SELECT i.* FROM inbox i WHERE NOT EXISTS (SELECT 1 FROM outbox o WHERE o.id=i.id) ORDER BY i.id LIMIT 1').get(),
    finish(id, text) {
      while (!saveReply.run(id, text, randomInt(1, 2 ** 31)).changes) {
        if (db.prepare('SELECT 1 FROM outbox WHERE id=?').get(id)) return;
      }
    },
    recoverSends: () => db.exec(`UPDATE outbox SET state=CASE
      WHEN id IN (SELECT id FROM inbox WHERE platform='vk') THEN 'pending' ELSE 'uncertain' END
      WHERE state='sending'`),
    nextSend: (platform, now) => db.prepare(`SELECT i.payload, o.* FROM outbox o JOIN inbox i USING(id)
      WHERE i.platform=? AND o.state='pending' AND o.due<=? ORDER BY o.id LIMIT 1`).get(platform, now),
    sending: (id) => db.prepare("UPDATE outbox SET state='sending', attempts=attempts+1 WHERE id=?").run(id),
    sendState: (id, state, due = 0) => db.prepare('UPDATE outbox SET state=?, due=? WHERE id=?').run(state, due, id),
    readMemory: (scope, file) => db.prepare('SELECT content FROM memory WHERE scope=? AND file=?').get(scope, file)?.content ?? '',
    writeMemory(scope, file, content) {
      const limit = { 'MEMORY.md': 2200, 'USER.md': 1375 }[file];
      if (!limit || [...content].length > limit) throw new Error(`Недопустимый файл или превышен лимит (${limit ?? 0} символов).`);
      db.prepare('INSERT INTO memory VALUES(?,?,?) ON CONFLICT(scope,file) DO UPDATE SET content=excluded.content').run(scope, file, content);
    },
    search(scope, query, before) {
      // shortcut: substring search over the current chat; use FTS when large histories justify it.
      if (!query.trim()) return [];
      return db.prepare(`SELECT i.payload, o.text FROM inbox i JOIN outbox o USING(id)
        WHERE scope=? AND id<? ORDER BY id DESC`).iterate(scope, before)
        .map(({ payload, text }) => ({ input: JSON.parse(payload).text, answer: text }))
        .filter(({ input, answer }) => `${input}\n${answer}`.toLowerCase().includes(query.toLowerCase()))
        .take(5).map(({ input, answer }) => ({ input: input.slice(0, 500), answer: answer.slice(0, 500) })).toArray();
    },
  };
}
