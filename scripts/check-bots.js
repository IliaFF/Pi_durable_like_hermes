import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createPlatforms } from '../src/platforms.js';

try {
  const platforms = createPlatforms(parseEnv(readFileSync(process.argv[2] ?? '.env', 'utf8')));
  if (!platforms.length) throw new Error('No configured bots');
  await Promise.all(platforms.map(async (platform) => {
    try {
      const settings = await platform.inspect();
      const ready = platform.name === 'telegram' ? settings.can_join_groups === true
        : Boolean(settings.is_enabled && settings.events?.message_new);
      if (!ready) process.exitCode = 1;
      console.log(`${platform.name}: API reachable; group prerequisites: ${ready ? 'ok' : 'not enabled'}`);
    } catch (error) {
      process.exitCode = 1;
      console.error(`${platform.name}: ${error.message}`);
    }
  }));
} catch (error) {
  console.error(`Bot check could not start: ${error.code ?? error.message}`);
  process.exitCode = 1;
}
