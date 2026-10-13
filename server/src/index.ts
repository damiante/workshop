import path from 'node:path';
import { seedAgents } from './agents.ts';
import { createApp } from './app.ts';
import { config } from './config.ts';
import { initCrypto, seal, unseal } from './crypto.ts';
import { db, initDb } from './db.ts';
import { resetTotp } from './http/auth.ts';
import { startScheduler } from './scheduler/loop.ts';
import { getValue, setValue } from './settings.ts';

initCrypto(config.secretKey);
initDb(path.join(config.dataDir, 'workshop.db'));

// Refuse to start with a different key: every stored credential would be unreadable.
const canary = getValue('key_check');
if (!canary) setValue('key_check', seal('workshop'));
else {
  try {
    unseal(canary);
  } catch {
    throw new Error('WORKSHOP_SECRET_KEY differs from the one this data was saved with. Restore the original key (stored credentials depend on it).');
  }
}

seedAgents();
if (config.resetTotp) resetTotp();

createApp().listen(config.port, () => {
  console.log(`Workshop ${config.version} listening on port ${config.port}`);
});
startScheduler();

// As PID 1 in a container Node gets no default signal handling, so exit explicitly. Agents keep
// running in their own containers and are re-attached when Workshop starts again.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    db.close();
    process.exit(0);
  });
}
