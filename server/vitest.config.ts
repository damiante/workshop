import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      WORKSHOP_PASSWORD: 'correct horse battery',
      WORKSHOP_SECRET_KEY: 'test-secret-key',
      // Run logs are written here during tests.
      DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-test-')),
    },
  },
});
