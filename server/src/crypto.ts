import crypto from 'node:crypto';

let key: Buffer | undefined;

/** Any string works as WORKSHOP_SECRET_KEY; it is stretched to 32 bytes. Changing it makes stored secrets unreadable. */
export function initCrypto(secret: string) {
  key = crypto.createHash('sha256').update(secret).digest();
}

function needKey(): Buffer {
  if (!key) throw new Error('initCrypto() was not called');
  return key;
}

/** AES-256-GCM: base64(iv | tag | ciphertext). */
export function seal(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', needKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function unseal(sealed: string): string {
  const raw = Buffer.from(sealed, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', needKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/** Constant-time comparison that also hides length differences. */
export function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));
}

export const randomToken = () => crypto.randomBytes(32).toString('base64url');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

/** RFC 6238 TOTP, SHA-1, 6 digits, 30 s step. */
export function totp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/**
 * Accepts the current step or one either side (clock drift). Returns the matched counter so the
 * caller can refuse to accept the same code twice; codes at or before `lastCounter` are rejected.
 */
export function verifyTotp(secret: string, code: string, now = Date.now(), lastCounter = -1): number | null {
  const current = Math.floor(now / 30_000);
  for (const counter of [current - 1, current, current + 1]) {
    if (counter > lastCounter && safeEqual(totp(secret, counter), code.trim())) return counter;
  }
  return null;
}
