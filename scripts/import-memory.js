import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { memoryLimits, openStore, scopeOf } from '../src/store.js';

try {
  process.umask(0o077);
  const [source, data, telegram, vk, mode, ...extra] = process.argv.slice(2);
  if (!source || !data || ![telegram, vk].every((id) => /^[1-9]\d*$/.test(id ?? '')) ||
      !['--dry-run', '--apply'].includes(mode) || extra.length) {
    throw new Error('Usage: import-memory.js HERMES_MEMORIES DATA_DIR TELEGRAM_OWNER_ID VK_OWNER_ID --dry-run|--apply');
  }
  const entries = Object.entries({ telegram, vk }).flatMap(([platform, chat]) =>
    Object.entries(memoryLimits).map(([file, limit]) => {
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(join(source, file)));
      if ([...content].length > limit) throw new Error(`${file}: exceeds ${limit} characters; nothing imported`);
      return { scope: scopeOf({ platform, chat, group: false }), file, content };
    }));
  let store;
  let reader;
  try {
    if (mode === '--apply') {
      mkdirSync(data, { recursive: true, mode: 0o700 });
      store = openStore(join(data, 'gateway.sqlite'));
    } else if (existsSync(join(data, 'gateway.sqlite'))) {
      reader = new DatabaseSync(join(data, 'gateway.sqlite'), { readOnly: true });
    }
    const plan = store ? store.importNotes(entries, true) : entries.map(({ scope, file, content }) => {
      const existing = reader?.prepare('SELECT content FROM memory WHERE scope=? AND file=?').get(scope, file);
      return { scope, file, chars: [...content].length, action: !existing ? 'insert' : existing.content === content ? 'unchanged' : 'conflict' };
    });
    console.table(plan.map(({ scope, ...row }) => ({ platform: JSON.parse(scope)[0], ...row })));
    if (plan.some(({ action }) => action === 'conflict')) throw new Error('Different destination notes exist; nothing imported');
  } finally {
    store?.close();
    reader?.close();
  }
} catch (error) {
  console.error(error.code ?? error.message);
  process.exitCode = 1;
}
