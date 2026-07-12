import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/** Point SOUL_DIR at a fresh temp dir. Must run before importing dist modules. */
export function freshSoulDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `soul-test-${label}-`));
  process.env.SOUL_DIR = dir;
  return dir;
}
