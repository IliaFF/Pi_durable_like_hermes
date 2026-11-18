import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { answerInput } from './agent.js';
import { createPlatforms, ApiError } from './platforms.js';
import { openStore } from './store.js';
import { deliver, handleRollback } from './worker.js';

async function main() {
  process.umask(0o077);
  const env = process.env;
  const owners = { telegram: env.TELEGRAM_ROLLBACK_OWNER_ID, vk: env.VK_ROLLBACK_OWNER_ID };
  const platforms = createPlatforms(env);
  if (!platforms.length) throw new Error('Configure at least one messaging platform.');
  const provider = env.MODEL_PROVIDER ?? 'openrouter';
  const modelId = env.MODEL_ID;
  const factory = { openrouter: openrouterProvider, openai: openaiProvider }[provider];
  if (!factory || !modelId || !env[`${provider.toUpperCase()}_API_KEY`]) throw new Error('Configure MODEL_PROVIDER, MODEL_ID and the provider API key.');
  const models = createModels();
  models.setProvider(factory());
  if (!models.getModel(provider, modelId)) throw new Error('The configured model is not registered in Pi AI.');
  const data = env.DATA_DIR ?? './data';
  const directory = join(data, 'sessions');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(join(data, 'worker-lock.sqlite'));
  lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
  const store = openStore(join(data, 'gateway.sqlite'));
  store.recoverSends();
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
  const loop = async (fn, name) => {
    while (!stop.signal.aborted) {
      try { await fn(); }
      catch (error) {
        if (stop.signal.aborted) return;
        if (!(error instanceof ApiError)) throw error;
        console.error(`${name}: ${error.message}`);
        await delay(Math.max(3, error.retryAfter ?? 0) * 1000);
      }
    }
  };
  try {
    await Promise.all([
      ...platforms.map((platform) => loop(() => platform.poll(store, stop.signal), platform.name)),
      ...platforms.map((platform) => loop(async () => { if (!await deliver(store, platform)) await delay(300); }, platform.name)),
      loop(async () => { if (!await handleRollback(store, owners)) await delay(300); }, 'rollback'),
      loop(async () => {
        const row = store.nextInput();
        if (!row) return delay(300);
        const text = await answerInput({ directory, store, models, model: { provider, modelId }, row });
        store.finish(row.id, text);
      }, 'agent'),
    ]);
  } catch (error) {
    // Other loops may still reference the database, so let the OS close it on a fatal error.
    console.error(`Gateway stopped: ${error.code ?? error.name}`);
    process.exit(1);
  }
  store.close();
  lock.close();
}

main().catch((error) => {
  console.error(`Could not start gateway: ${error.code ?? error.message}`);
  process.exitCode = 1;
});
