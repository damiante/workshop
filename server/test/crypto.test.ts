import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, initCrypto, seal, totp, unseal, verifyTotp } from '../src/crypto.ts';

describe('secrets at rest', () => {
  it('round-trips and is not plaintext', () => {
    initCrypto('k1');
    const sealed = seal('ghp_secret');
    expect(sealed).not.toContain('ghp_secret');
    expect(unseal(sealed)).toBe('ghp_secret');
  });

  it('refuses to open with a different key', () => {
    initCrypto('k1');
    const sealed = seal('x');
    initCrypto('k2');
    expect(() => unseal(sealed)).toThrow();
  });
});

describe('TOTP', () => {
  // RFC 6238 appendix B: ASCII secret "12345678901234567890", T = 59 s → 94287082 (last 6 digits).
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it('matches the RFC 6238 test vector', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totp(secret, 1)).toBe('287082');
  });

  it('accepts one step of drift and refuses replays', () => {
    const now = 59_000 + 30_000; // counter 2
    expect(verifyTotp(secret, '287082', now)).toBe(1);
    expect(verifyTotp(secret, '287082', now, 1)).toBeNull();
    expect(verifyTotp(secret, '287082', now + 60_000)).toBeNull();
  });
});
