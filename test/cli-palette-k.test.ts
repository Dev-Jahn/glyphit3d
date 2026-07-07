import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Regression for the "--palette-k < 1 / non-numeric silently produces an all-black image"
// finding (adversarial review, major). Pre-fix `applyPalette` did `parseInt(k, 10)` with no
// validation, so 0 / NaN / negative flowed into topKNearest, which returned zero candidates;
// bestPairRefine then scored Infinity and every cell emitted palette index 0 (black) for BOTH
// fg and bg. The fix rejects any k < 1 (or non-numeric) loudly with exit code 2, matching the
// existing loud validation of --palette itself.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = resolve(root, 'docs/assets/demo.png');
const BASE = ['tsx', 'src/cli.ts', 'image', DEMO, '--cols', '20', '--quality', '3', '--palette', '256'];

function runCli(extra: string[]): { status: number; stderr: string } {
  try {
    execFileSync('npx', [...BASE, ...extra], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    return { status: 0, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer };
    return { status: err.status ?? -1, stderr: err.stderr?.toString() ?? '' };
  }
}

describe('cli --palette-k validation (rejects k < 1 / non-numeric instead of emitting all-black)', () => {
  for (const bad of ['0', '-5', 'abc']) {
    it(`--palette-k ${bad} exits 2 with a clear error (never a silent all-black render)`, () => {
      const r = runCli([`--palette-k=${bad}`]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/palette-k/);
    }, 60000);
  }

  it('--palette-k 8 (valid) is accepted', () => {
    const r = runCli(['--palette-k', '8', '-o', '/dev/null']);
    expect(r.status).toBe(0);
  }, 60000);
});
