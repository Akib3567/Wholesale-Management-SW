import { monotonicFactory } from 'ulid';

/**
 * Global record IDs are ULIDs: 26-char Crockford base32, lexicographically
 * sortable by creation time, and globally unique — so records created on
 * different branch PCs can never collide when sync packets merge them.
 *
 * The monotonic factory guarantees strictly increasing IDs even when many
 * are generated within the same millisecond on this PC.
 */

const generate = monotonicFactory();

export function newUlid(): string {
  return generate();
}

/** Crockford base32, 26 chars (excludes I, L, O, U). */
export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: string): boolean {
  return ULID_REGEX.test(value);
}
