import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { answerInput } from '../src/agent.js';
import { openStore, scopeOf } from '../src/store.js';
import { fixtureModels, model } from './fixture-model.js';

const importer = fileURLToPath(new URL('../scripts/import-memory.js', import.meta.url));
const health = fileURLToPath(new URL('../scripts/health.js', import.meta.url));

test('Hermes import survives reopening, stays private in model prompts, and refuses overwrite', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-h-import-'));
  t.after(() => rmSync(root, { recursive: true }));
  const data = join(root, 'data');
  writeFileSync(join(root, 'MEMORY.md'), 'private-sentinel\n');
  writeFileSync(join(root, 'USER.md'), 'profile-sentinel');
  const run = (mode) => spawnSync(process.execPath, [importer, root, data, '7', '8', mode], { encoding: 'utf8' });
  const dry = run('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(existsSync(data), false);
  assert.equal(run('--apply').status, 0);
  const database = join(data, 'gateway.sqlite');
  const store = openStore(database);
  t.after(() => store.close());
  for (const [platform, chat] of [['telegram','7'], ['vk','8']]) {
    assert.equal(store.readMemory(scopeOf({ platform, chat, group: false }), 'MEMORY.md'), 'private-sentinel\n');
  }
  writeFileSync(join(root, 'USER.md'), 'changed');
  assert.equal(run('--apply').status, 1);
  assert.equal(store.readMemory(scopeOf({ platform: 'telegram', chat: '7', group: false }), 'USER.md'), 'profile-sentinel');
  const directory = join(data, 'sessions');
  mkdirSync(directory);
  for (const [group, chat] of [[false, '7'], [true, '-50']]) {
    const input = { platform: 'telegram', sender: '7', event: chat, chat, group, text: 'Проверка памяти' };
    store.ingest('telegram', '50', [input]);
    const row = store.nextInput();
    const models = fixtureModels((context) => {
      assert.equal(JSON.stringify(context).includes('private-sentinel'), !group);
      assert.equal(JSON.stringify(context).includes('profile-sentinel'), !group);
      return 'OK';
    });
    assert.equal(await answerInput({ directory, store, models, model, row }), 'OK');
    store.finish(row.id, 'OK');
    if (group) store.sendState(row.id, 'uncertain');
  }
  const check = spawnSync(process.execPath, [health], { env: { ...process.env, DATA_DIR: data }, encoding: 'utf8' });
  assert.equal(check.status, 1);
  assert.match(check.stderr, /uncertain/);
  assert.doesNotMatch(check.stderr, /sentinel/);
});
