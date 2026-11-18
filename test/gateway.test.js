import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { answerInput } from '../src/agent.js';
import { createPlatforms, telegramEvent, vkEvent } from '../src/platforms.js';
import { openStore, scopeOf } from '../src/store.js';
import { deliver } from '../src/worker.js';
import { fixtureModels, model } from './fixture-model.js';

const input = (overrides = {}) => ({ platform: 'telegram', event: '1', chat: '7', sender: '7', group: false,
  message: 21, text: 'Помни это', ...overrides });
const bot = { id: 100, username: 'MyBot' };
const telegram = (fields = {}, update_id = 1) => ({ update_id, message: { message_id: 1, from: { id: 7 },
  chat: { type: 'supergroup', id: -50 }, text: 'Привет', ...fields } });
const vk = (fields = {}) => ({ type: 'message_new', object: { message: { peer_id: 2000000001, from_id: 7,
  conversation_message_id: 21, text: 'Привет', ...fields } } });

test('group mention/reply detection, direct messages and topic isolation', () => {
  assert.equal(telegramEvent(telegram(), bot), undefined);
  assert.equal(telegramEvent(telegram({ chat: { type: 'private', id: 7 } }), bot).group, false);
  const mention = telegram({ text: '@MyBot привет', entities: [{ type: 'mention', offset: 0, length: 6 }], is_topic_message: true, message_thread_id: 5 });
  const topic = telegramEvent(mention, bot);
  assert.equal(topic.thread, 5);
  assert.notEqual(scopeOf(topic), scopeOf({ ...topic, thread: 6 }));
  assert.equal(telegramEvent(telegram({ reply_to_message: { from: bot } }), bot).group, true);
  assert.equal(vkEvent(vk(), '42'), undefined);
  assert.equal(vkEvent(vk({ peer_id: 7 }), '42').group, false);
  assert.equal(vkEvent(vk({ text: '[club42|Наш бот] привет' }), '42').group, true);
  assert.equal(vkEvent(vk({ reply_message: { from_id: -42 } }), '42').event, '2000000001:21');
});

test('both adapters enforce allowlists and persist cursors with accepted events', async () => {
  const store = openStore(':memory:');
  try {
    const mockFetch = async (url, options) => {
      const path = new URL(url).pathname;
      if (path.endsWith('getMe')) return Response.json({ ok: true, result: bot });
      if (path.endsWith('getUpdates')) return Response.json({ ok: true, result: [
        telegram({ reply_to_message: { from: bot } }, 3),
        telegram({ reply_to_message: { from: bot }, from: { id: 8 } }, 4),
      ] });
      if (path.endsWith('getLongPollServer')) return Response.json({ response: { server: 'https://example.test/poll', key: 'test', ts: '2' } });
      assert.equal(options.body.get('ts'), '2');
      return Response.json({ ts: '6', updates: [vk({ text: '[club42|Бот]' }), vk({ peer_id: 2000000002, text: '[club42|Бот]' })] });
    };
    const platforms = createPlatforms({ TELEGRAM_BOT_TOKEN: '100:test', TELEGRAM_ALLOWED_USERS: '7', TELEGRAM_ALLOWED_GROUPS: '-50',
      VK_GROUP_TOKEN: 'test', VK_GROUP_ID: '42', VK_ALLOWED_USERS: '7', VK_ALLOWED_PEERS: '2000000001' }, mockFetch);
    for (const platform of platforms) await platform.poll(store);
    assert.equal(store.cursor('telegram'), '5');
    assert.equal(store.cursor('vk'), '6');
    assert.equal(store.nextInput().event, '3');
    store.finish(store.nextInput().id, 'Telegram');
    assert.equal(store.nextInput().event, '2000000001:21');
    store.finish(store.nextInput().id, 'VK');
    assert.equal(store.nextInput(), undefined);
  } finally { store.close(); }
});

test('outbox crash recovery does not blindly resend Telegram; VK reuses random_id', async () => {
  const store = openStore(':memory:');
  try {
    store.ingest('telegram', '2', [input(), input()]);
    store.ingest('vk', '3', [input({ platform: 'vk', event: '7:1' })]);
    for (let row; (row = store.nextInput());) store.finish(row.id, 'ответ');
    const tg = store.nextSend('telegram', 0);
    const vkRow = store.nextSend('vk', 0);
    store.sending(tg.id);
    store.sending(vkRow.id);
    store.recoverSends();
    assert.equal(store.nextSend('telegram', 0), undefined);
    assert.equal(await deliver(store, { name: 'vk', send: async (_event, text, randomId) => {
      assert.equal(randomId, vkRow.random_id);
      assert.equal(text, 'ответ');
    } }), true);
    assert.equal(store.nextSend('vk', 0), undefined);
  } finally { store.close(); }
});

test('real Pi Durable runs memory and session_search tools without crossing scopes', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-h-memory-'));
  const store = openStore(join(directory, 'gateway.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  const group = input({ event: '6', group: true, chat: '-50', text: 'групповой секрет' });
  store.ingest('telegram', '8', [group, input(), input({ event: '7', text: 'найди старое' })]);
  store.finish(store.nextInput().id, 'групповой ответ');
  let calls = 0;
  const models = fixtureModels((context) => {
    calls++;
    if (calls === 1) return { type: 'toolCall', id: 'set-memory', name: 'memory', arguments: { file: 'USER.md', content: 'Люблю чай' } };
    if (calls === 2) return 'Запомнил';
    if (calls === 3) return { type: 'toolCall', id: 'search', name: 'session_search', arguments: { query: 'Помни' } };
    const last = context.messages.at(-1);
    assert.equal(last.role, 'toolResult');
    assert.match(last.content[0].text, /Запомнил/);
    assert.doesNotMatch(last.content[0].text, /групп/);
    return 'Нашёл';
  });
  const options = { directory, store, models, model };
  const row = store.nextInput();
  assert.equal(await answerInput({ ...options, row }), 'Запомнил');
  store.finish(row.id, 'Запомнил');
  assert.equal(store.readMemory(scopeOf(input()), 'USER.md'), 'Люблю чай');
  assert.equal(store.readMemory(scopeOf(group), 'USER.md'), '');
  assert.equal(await answerInput({ ...options, row: store.nextInput() }), 'Нашёл');
  assert.throws(() => store.writeMemory(scopeOf(input()), 'USER.md', 'x'.repeat(1376)));
});

test('SIGKILL during a real Pi Durable turn: resume once and reuse the stored answer', { timeout: 20_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-h-crash-'));
  const store = openStore(join(directory, 'gateway.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  store.ingest('telegram', '2', [input()]);
  const child = fork(new URL('./crash-child.js', import.meta.url), [directory]);
  t.after(() => child.kill('SIGKILL'));
  const exit = once(child, 'exit');
  assert.equal((await Promise.race([once(child, 'message'), exit]))[0], 'model-started');
  child.kill('SIGKILL');
  assert.equal((await exit)[1], 'SIGKILL');
  let calls = 0;
  const options = { directory, store, row: store.nextInput(), model, models: fixtureModels(() => { calls++; return 'Продолжил'; }) };
  assert.equal(await answerInput(options), 'Продолжил');
  assert.equal(await answerInput(options), 'Продолжил');
  assert.equal(calls, 1);
});
