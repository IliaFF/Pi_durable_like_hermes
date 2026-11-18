import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ApiError } from './platforms.js';

const run = promisify(execFile);
const startHermes = () => run('/usr/bin/systemctl', ['--user', '--no-block', 'start', 'hermes-gateway.service'], { timeout: 5000 });

export async function handleRollback(store, owners, start = startHermes, now = Math.floor(Date.now() / 1000)) {
  const row = store.nextInput(true);
  if (!row) return false;
  const { platform, sender, chat, group, sentAt } = JSON.parse(row.payload);
  if (group !== false || !sender || chat !== sender || owners[platform] !== sender ||
      !Number.isSafeInteger(sentAt) || sentAt < now - 120 || sentAt > now + 30) {
    store.finish(row.id, '', 'skipped');
    return true;
  }
  try {
    // systemd stops this gateway through Conflicts=; waiting for start would block that stop.
    await start();
  } catch (error) {
    console.error(`Hermes rollback could not be queued: ${error.code ?? error.name}`);
    store.finish(row.id, 'Не удалось запустить Hermes. Попробуй ещё раз или выполни откат с сервера.');
    return true;
  }
  console.info(`Hermes rollback queued from ${platform}`);
  store.finish(row.id, '', 'skipped');
  return true;
}

export async function deliver(store, platform, now = Date.now()) {
  const row = store.nextSend(platform.name, now);
  if (!row) return false;
  if (row.attempts >= 5) {
    store.sendState(row.id, 'uncertain');
    return true;
  }
  store.sending(row.id);
  try {
    await platform.send(JSON.parse(row.payload), row.text, row.random_id);
  } catch (error) {
    const known = error instanceof ApiError;
    const ambiguous = !known || error.ambiguous;
    const attempts = row.attempts + 1;
    const retry = platform.name === 'vk' ? ambiguous || [1, 6, 9, 10, 29].includes(error.code) : error.code === 429;
    if (retry && attempts < 5) store.sendState(row.id, 'pending', now + Math.max(2 ** attempts, error.retryAfter ?? 0) * 1000);
    else {
      const state = ambiguous ? 'uncertain' : 'failed';
      store.sendState(row.id, state);
      console.error(`Delivery ${platform.name} #${row.id}: ${state}`);
    }
    return true;
  }
  store.sendState(row.id, 'sent');
  return true;
}
