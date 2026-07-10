import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Regression for fix/palette-q0-guard (+ extension). Two silent-no-op holes in the CLI palette
// wiring, made LOUD (clean exit 2, matching the existing --palette-k range guard idiom):
//   1. `--quality 0 --palette …` — Q0 uses rampGrid, which never reaches matchGrid's quality
//      guard, so the palette was silently dropped (a plain ramp render, no error).
//   2. `--palette-k K` without `--palette` — applyPalette early-returned, silently ignoring K.
// Both must reject with exit 2; valid Q3 + palette combinations must still run.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = resolve(root, 'docs/assets/demo.png');
const BASE = ['tsx', 'src/cli.ts', 'image', DEMO, '--cols', '20'];

function runCli(extra: string[]): { status: number; stderr: string } {
  try {
    execFileSync('npx', [...BASE, ...extra], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    return { status: 0, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer };
    return { status: err.status ?? -1, stderr: err.stderr?.toString() ?? '' };
  }
}

describe('cli palette guards (reject silent no-ops with exit 2)', () => {
  it('--quality 0 --palette 256 exits 2 (never a silent palette-ignoring ramp)', () => {
    const r = runCli(['--quality', '0', '--palette', '256']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/palette/);
  }, 60000);

  it('--palette-k 8 without --palette exits 2 (never a silent no-op)', () => {
    const r = runCli(['--quality', '3', '--palette-k', '8']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/palette-k/);
  }, 60000);

  it('--quality 3 --palette 256 (valid) is accepted', () => {
    const r = runCli(['--quality', '3', '--palette', '256', '-o', '/dev/null']);
    expect(r.status).toBe(0);
  }, 60000);

  it('--quality 3 --palette 256 --palette-k 8 (valid) is accepted', () => {
    const r = runCli(['--quality', '3', '--palette', '256', '--palette-k', '8', '-o', '/dev/null']);
    expect(r.status).toBe(0);
  }, 60000);
});
