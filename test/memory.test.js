import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openStore, scopeOf } from '../src/store.js';

const group = { platform: 'telegram', chat: '-50', group: true, thread: 3 };
const privateChat = { platform: 'telegram', chat: '7', group: false };

test('note edits preserve unrelated text and batches roll back on an error', () => {
  const store = openStore(':memory:');
  try {
    const scope = scopeOf(privateChat);
    const file = 'USER.md';
    const edit = (...operations) => store.editMemory(scope, file, operations);
    store.importNotes([{ scope, file, content: 'Стиль: кратко. Напиток: чай.\n\nВременно: 9.' }], true);
    assert.equal(edit({ action: 'patch', old_text: 'чай', content: 'кофе' },
      { action: 'remove', old_text: '\n\nВременно: 9.' }, { action: 'add', content: 'Язык: русский.' }),
    'Стиль: кратко. Напиток: кофе.\n\nЯзык: русский.');
    const full = 'а'.repeat(1375);
    store.importNotes([{ scope: scopeOf(group), file: 'MEMORY.md', content: 'заметка группы' }], true);
    assert.throws(() => edit({ action: 'add', content: 'test' }, { action: 'remove', old_text: 'нет такого' }), /ровно один/);
    assert.throws(() => edit({ action: 'add', content: full }), /лимит/);
    assert.match(store.readMemory(scope, file), /кофе/);
    assert.doesNotMatch(store.readMemory(scope, file), /test/);
    assert.equal(store.readMemory(scopeOf(group), 'MEMORY.md'), 'заметка группы');
    assert.equal(edit({ action: 'add', content: full },
      { action: 'remove', old_text: 'Стиль: кратко. Напиток: кофе.\n\nЯзык: русский.\n\n' }), full);
    assert.throws(() => edit({ action: 'remove', old_text: 'аа' }), /ровно один/);
  } finally { store.close(); }
});

test('FTS migrates existing exchanges and leaves foreign chats, topics and future IDs out', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-fts-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'gateway.sqlite');
  let store = openStore(path);
  const insert = (scope, event, text, answer = 'ответ') => {
    store.ingest(scope.platform, event, [{ ...scope, event, text }]);
    const { id } = store.nextInput();
    store.finish(id, answer);
    return id;
  };
  const previous = insert(group, '1', 'до');
  const hidden = insert(privateChat, '2', 'скрытая заметка альфа');
  const center = insert(group, '3', 'ЗАМЕТКА СЕГОДНЯ', 'проект Альфа');
  insert({ ...group, thread: 4 }, '4', 'заметка альфа другая тема');
  const next = insert(group, '5', 'после');
  store.close();
  // Recreate the pre-FTS schema without changing the persisted history.
  const db = new DatabaseSync(path);
  db.exec('DROP TRIGGER history_after_finish; DROP TRIGGER history_after_delete; DROP TRIGGER history_after_answer_change; DROP TABLE history_fts;');
  db.close();
  store = openStore(path);
  try {
    const current = insert(group, '6', 'заметка альфа ещё не в прошлом');
    const scope = scopeOf(group);
    assert.deepEqual(store.search(scope, '"альфа" заметка', current).map(({ id }) => id), [center]);
    assert.deepEqual(store.search(scope, 'альф', current), []);
    assert.deepEqual(store.search(scope, '"*()', current), []);
    assert.deepEqual(store.neighbors(scope, hidden, current), []);
    assert.deepEqual(store.neighbors(scope, current, current), []);
    assert.deepEqual(store.neighbors(scope, center, current).map(({ id }) => id), [previous, center, next]);
    assert.deepEqual(store.search(scope, 'прошлом', current + 1).map(({ id }) => id), [current]);
  } finally { store.close(); }
});
