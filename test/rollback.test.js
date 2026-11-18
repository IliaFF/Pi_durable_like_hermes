import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleRollback } from '../src/worker.js';
import { openStore } from '../src/store.js';

const now = 1000;
const owners = { telegram: '7', vk: '8' };
const command = { platform: 'telegram', sender: '7', chat: '7', group: false, text: '/hermes', sentAt: now };

function ingest(store, event, overrides = {}) {
  const input = { ...command, event, ...overrides };
  store.ingest(input.platform, event, [input]);
}

test('/hermes bypasses the agent backlog and runs once for each authorized platform', async () => {
  const store = openStore(':memory:');
  try {
    ingest(store, '1', { text: 'Обычный запрос' });
    ingest(store, '2');
    ingest(store, '3', { platform: 'vk', sender: '8', chat: '8' });
    let starts = 0;
    const start = async () => { starts++; };
    assert.equal(store.nextInput().event, '1');
    assert.equal(await handleRollback(store, owners, start, now), true);
    ingest(store, '2');
    assert.equal(await handleRollback(store, owners, start, now), true);
    assert.equal(await handleRollback(store, owners, start, now), false);
    assert.equal(starts, 2);
    assert.equal(store.nextSend('telegram', 0), undefined);
    assert.equal(store.nextSend('vk', 0), undefined);
    store.finish(store.nextInput().id, 'ответ');
    assert.equal(store.nextInput(), undefined);
  } finally { store.close(); }
});

test('/hermes rejects groups, other senders, stale messages, and a missing owner config', async () => {
  const store = openStore(':memory:');
  try {
    const cases = [
      { group: true, chat: '-50' }, { sender: '9', chat: '9' }, { chat: '9' },
      { sentAt: now - 121 }, { sentAt: now + 31 }, { sentAt: undefined },
      { platform: 'vk', sender: '7', chat: '7' },
    ];
    let starts = 0;
    const start = async () => { starts++; };
    for (const [index, event] of cases.entries()) ingest(store, String(index), event);
    for (const _ of cases) assert.equal(await handleRollback(store, owners, start, now), true);
    ingest(store, 'unconfigured');
    assert.equal(await handleRollback(store, {}, start, now), true);
    assert.equal(starts, 0);
    assert.equal(store.nextInput(), undefined);
    assert.equal(store.nextInput(true), undefined);
  } finally { store.close(); }
});

test('/hermes queues an error reply when systemd declines to schedule the switch', async () => {
  const store = openStore(':memory:');
  try {
    ingest(store, '1');
    await handleRollback(store, owners, async () => { throw new Error('systemd unavailable'); }, now);
    assert.match(store.nextSend('telegram', 0).text, /Не удалось запустить Hermes/);
  } finally { store.close(); }
});
