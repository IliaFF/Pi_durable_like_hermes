import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

try {
  const db = new DatabaseSync(join(process.env.DATA_DIR ?? './data', 'gateway.sqlite'), { readOnly: true });
  try {
    const issues = db.prepare(`SELECT i.platform, coalesce(o.state,'generating') AS state, count(*) AS total
      FROM inbox i LEFT JOIN outbox o USING(id)
      WHERE o.state IN ('uncertain','failed') OR (
        i.received_at BETWEEN 1 AND unixepoch()-600 AND (o.state IS NULL OR o.state IN ('pending','sending')))
      GROUP BY 1,2`).all();
    if (issues.length) {
      console.error(`Queue needs attention: ${JSON.stringify(issues)}`);
      process.exitCode = 1;
    }
  } finally { db.close(); }
} catch (error) {
  console.error(`Health check failed: ${error.code ?? error.name}`);
  process.exitCode = 1;
}
