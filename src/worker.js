import { ApiError } from './platforms.js';

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
