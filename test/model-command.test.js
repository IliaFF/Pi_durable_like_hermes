import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { answerInput } from '../src/agent.js';
import { DEFAULT_MODEL, modelCommand, selectedModel } from '../src/model-command.js';
import { openStore, scopeOf } from '../src/store.js';
import { fixtureModels, model } from './fixture-model.js';

const owner = { platform: 'telegram', chat: '7', sender: '7', group: false };
const row = (event, text) => ({ scope: scopeOf(event), payload: JSON.stringify({ ...event, text }) });
const codex = { provider: 'openai-codex', id: 'gpt-6-sol', name: 'GPT 6 Sol' };

test('model commands list authenticated models and keep the subscription private', async () => {
  const store = openStore(':memory:');
  try {
    const catalog = [codex, { provider: 'openrouter', id: DEFAULT_MODEL.modelId, name: 'DeepSeek' }];
    const models = { getAvailable: (provider) => catalog.filter((m) => m.provider === provider),
      getModel: (provider, id) => catalog.find((m) => m.provider === provider && m.id === id), checkAuth: () => true };
    const owners = { telegram: '7' };
    const run = (event, command) => modelCommand(store, models, DEFAULT_MODEL, row(event, command), owners);
    const group = { ...owner, chat: '-2', group: true };
    const other = { ...owner, sender: '8', chat: '8' };
    assert.match(await run(owner, '/model'), /openai-codex\/gpt-6-sol/);
    assert.doesNotMatch(await run(other, '/model'), /codex/);
    assert.doesNotMatch(await run(group, '/model'), /codex/);
    const cmd = '/model openai-codex/gpt-6-sol';
    assert.match(await run(other, cmd), /не найдены/);
    assert.match(await run(owner, cmd), /Модель для этого чата/);
    assert.equal((await selectedModel(store, models, row(owner, ''), DEFAULT_MODEL, owners)).provider, 'openai-codex');
    assert.deepEqual(await selectedModel(store, models, row(owner, ''), DEFAULT_MODEL, {}), DEFAULT_MODEL);
    assert.deepEqual(await selectedModel(store, models, row(group, ''), DEFAULT_MODEL, owners), DEFAULT_MODEL);
    await run(owner, '/model default');
    assert.equal(store.getChatModel(scopeOf(owner)), undefined);
  } finally { store.close(); }
});

test('an existing Pi Durable conversation uses the newly selected model', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-model-switch-'));
  const store = openStore(join(directory, 'gateway.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  const models = fixtureModels((_context, requested) => requested.id);
  for (const [index, modelId] of ['echo', 'other', 'echo'].entries()) {
    const event = String(index + 1);
    store.ingest('telegram', event, [{ ...owner, event, text: 'проверка' }]);
    const current = store.nextInput();
    const result = await answerInput({ directory, store, models, row: current, model: { ...model, modelId } });
    assert.equal(result, modelId);
    store.finish(current.id, result);
  }
});
