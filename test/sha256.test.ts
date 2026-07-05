import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../web/src/sha256.js';

const enc = new TextEncoder();

// Random-content buffer of exactly n bytes; used to cross-check the pure-JS digest
// against node:crypto at chosen lengths.
function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = (Math.random() * 256) | 0;
  return buf;
}

function nodeSha(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('sha256Hex', () => {
  it('matches the FIPS 180-2 known-answer vectors', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(enc.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    // 56-byte two-block vector: forces a chunk whose padding spills into a new block.
    expect(
      sha256Hex(enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('agrees with node:crypto at padding-boundary lengths', () => {
    // Lengths around the 56/64-byte block/padding boundaries plus larger buffers.
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 128, 1000, 65536]) {
      const buf = randomBytes(n);
      expect(sha256Hex(buf)).toBe(nodeSha(buf));
    }
  });

  it('agrees with node:crypto for random lengths up to ~100KB', () => {
    for (let t = 0; t < 20; t++) {
      const buf = randomBytes((Math.random() * 100_000) | 0);
      expect(sha256Hex(buf)).toBe(nodeSha(buf));
    }
  });
});
