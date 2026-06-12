import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { SyncPacketError } from './types';

/**
 * One shared company passphrase → two independent 256-bit keys (encryption
 * + HMAC signing) via scrypt with a fresh random salt per packet. Trust
 * model: every branch of one company holds the same secret; packets are
 * unreadable and unforgeable to anyone without it.
 */

export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
export const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface DerivedKeys {
  encKey: Buffer;
  macKey: Buffer;
}

export function deriveKeys(passphrase: string, salt: Buffer): DerivedKeys {
  const material = scryptSync(passphrase, salt, 64, SCRYPT_PARAMS);
  return { encKey: material.subarray(0, 32), macKey: material.subarray(32, 64) };
}

export function newSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

export function hmacHex(macKey: Buffer, data: Buffer): string {
  return createHmac('sha256', macKey).update(data).digest('hex');
}

export function hmacMatches(macKey: Buffer, data: Buffer, expectedHex: string): boolean {
  const actual = Buffer.from(hmacHex(macKey, data), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface EncryptedBlob {
  iv: Buffer;
  tag: Buffer;
  data: Buffer;
}

export function encryptAesGcm(encKey: Buffer, plaintext: Buffer): EncryptedBlob {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), data };
}

export function decryptAesGcm(encKey: Buffer, blob: EncryptedBlob): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', encKey, blob.iv);
    decipher.setAuthTag(blob.tag);
    return Buffer.concat([decipher.update(blob.data), decipher.final()]);
  } catch {
    throw new SyncPacketError(
      'DECRYPT_FAILED',
      'Could not decrypt packet — wrong sync passphrase, or the file is corrupted/tampered',
    );
  }
}
