import { randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const memoryLimits = Object.freeze({ 'MEMORY.md': 2200, 'USER.md': 1375 });

export function scopeOf({ platform, chat, group, thread }) {
  return JSON.stringify([platform, group ? 'group' : 'private', chat, thread ?? null]);
}

function validateNote(file, content) {
  const limit = Object.hasOwn(memoryLimits, file) ? memoryLimits[file] : 0;
  if (!limit || [...content].length > limit) throw new Error(`Недопустимый файл или превышен лимит (${limit} символов).`);
}

function editNote(content, operation) {
  const { action, old_text, content: text } = operation;
  if (action === 'add') {
    if (!text?.trim()) throw new Error('Укажи непустой факт.');
    return content ? `${content}${content.endsWith('\n') ? '\n' : '\n\n'}${text.trim()}` : text.trim();
  }
  if (!['patch', 'remove'].includes(action) || !old_text?.trim() || (action === 'patch' && !text?.trim())) {
    throw new Error('Укажи непустой фрагмент и, для patch, новый текст.');
  }
  const start = content.indexOf(old_text);
  if (start === -1 || content.indexOf(old_text, start + 1) !== -1) {
    throw new Error('Фрагмент должен встречаться ровно один раз.');
  }
  return content.slice(0, start) + (action === 'patch' ? text : '') + content.slice(start + old_text.length);
}

function initHistoryIndex(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='history_fts'").get()) {
      db.exec(`
        CREATE VIRTUAL TABLE history_fts USING fts5(input, answer, tokenize='unicode61');
        INSERT INTO history_fts(rowid,input,answer)
          SELECT i.id,json_extract(i.payload,'$.text'),o.text FROM inbox i JOIN outbox o USING(id);
        CREATE TRIGGER history_after_finish AFTER INSERT ON outbox BEGIN
          INSERT INTO history_fts(rowid,input,answer)
            SELECT id,json_extract(payload,'$.text'),NEW.text FROM inbox WHERE id=NEW.id;
        END;
        CREATE TRIGGER history_after_delete AFTER DELETE ON outbox BEGIN
          DELETE FROM history_fts WHERE rowid=OLD.id;
        END;
        CREATE TRIGGER history_after_answer_change AFTER UPDATE OF text ON outbox BEGIN
          UPDATE history_fts SET answer=NEW.text WHERE rowid=NEW.id;
        END;
      `);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const exchangeColumns = "i.id, json_extract(i.payload,'$.text') AS input, o.text AS answer";
const excerpt = ({ id, input, answer }) => ({ id, input: input.slice(0, 500), answer: answer.slice(0, 500) });

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
    CREATE INDEX IF NOT EXISTS inbox_scope_id ON inbox(scope,id);
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY REFERENCES inbox(id), text TEXT NOT NULL, random_id INTEGER NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS memory (
      scope TEXT NOT NULL, file TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(scope, file)
    );
  `);
  if (!db.prepare('PRAGMA table_info(inbox)').all().some(({ name }) => name === 'received_at')) {
    db.exec('ALTER TABLE inbox ADD COLUMN received_at INTEGER NOT NULL DEFAULT 0');
  }
  initHistoryIndex(db);
  const put = db.prepare('INSERT INTO inbox(platform,event,scope,payload,received_at) VALUES (?,?,?,?,unixepoch()) ON CONFLICT(platform,event) DO NOTHING');
  const lookupNote = db.prepare('SELECT content FROM memory WHERE scope=? AND file=?');
  const insertNote = db.prepare('INSERT INTO memory VALUES(?,?,?)');
  const saveCursor = db.prepare('INSERT INTO cursors VALUES (?,?) ON CONFLICT(source) DO UPDATE SET value=excluded.value');
  const saveReply = db.prepare('INSERT INTO outbox(id,text,random_id,state) VALUES(?,?,?,?) ON CONFLICT DO NOTHING');
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
    nextInput: (rollback = false) => db.prepare(`SELECT i.* FROM inbox i
      WHERE (json_extract(i.payload,'$.text') IS '/hermes')=?
        AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.id=i.id) ORDER BY i.id LIMIT 1`).get(Number(rollback)),
    finish(id, text, state = 'pending') {
      while (!saveReply.run(id, text, randomInt(1, 2 ** 31), state).changes) {
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
    readMemory: (scope, file) => lookupNote.get(scope, file)?.content ?? '',
    editMemory(scope, file, operations) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = lookupNote.get(scope, file)?.content ?? '';
        const content = operations.reduce(editNote, current);
        validateNote(file, content);
        db.prepare('INSERT INTO memory VALUES(?,?,?) ON CONFLICT(scope,file) DO UPDATE SET content=excluded.content').run(scope, file, content);
        db.exec('COMMIT');
        return content;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    importNotes(entries, apply) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const plan = entries.map(({ scope, file, content }) => {
          validateNote(file, content);
          const existing = lookupNote.get(scope, file);
          return { scope, file, chars: [...content].length, action: !existing ? 'insert' : existing.content === content ? 'unchanged' : 'conflict' };
        });
        if (apply && !plan.some(({ action }) => action === 'conflict')) {
          for (const [index, entry] of entries.entries()) {
            if (plan[index].action === 'insert') insertNote.run(entry.scope, entry.file, entry.content);
          }
          db.exec('COMMIT');
        } else db.exec('ROLLBACK');
        return plan;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    search(scope, query, before) {
      const terms = query.match(/[\p{L}\p{N}\p{Co}]+/gu);
      if (!terms) return [];
      const match = terms.map((term) => `"${term}"`).join(' AND ');
      return db.prepare(`SELECT ${exchangeColumns} FROM history_fts
        JOIN inbox i ON i.id=history_fts.rowid JOIN outbox o ON o.id=i.id
        WHERE history_fts MATCH ? AND i.scope=? AND i.id<? ORDER BY i.id DESC LIMIT 5`)
        .all(match, scope, before).map(excerpt);
    },
    neighbors(scope, id, before) {
      const select = `SELECT ${exchangeColumns} FROM inbox i JOIN outbox o ON o.id=i.id WHERE i.scope=? AND i.id<?`;
      const center = db.prepare(`${select} AND i.id=?`).get(scope, before, id);
      if (!center) return [];
      const previous = db.prepare(`${select} AND i.id<? ORDER BY i.id DESC LIMIT 1`).get(scope, before, id);
      const next = db.prepare(`${select} AND i.id>? ORDER BY i.id LIMIT 1`).get(scope, before, id);
      return [previous, center, next].filter(Boolean);
    },
  };
}
