import { describe, expect, it } from 'vitest';
import { ULID_REGEX, isUlid, newUlid } from './ulid';

describe('newUlid', () => {
  it('generates 26-char Crockford base32 IDs', () => {
    const id = newUlid();
    expect(id).toHaveLength(26);
    expect(ULID_REGEX.test(id)).toBe(true);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newUlid()));
    expect(ids.size).toBe(10_000);
  });

  it('is monotonic — later IDs sort after earlier ones (sync-merge ordering)', () => {
    const ids = Array.from({ length: 1_000 }, () => newUlid());
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });
});

describe('isUlid', () => {
  it('accepts valid ULIDs and rejects everything else', () => {
    expect(isUlid(newUlid())).toBe(true);
    expect(isUlid('')).toBe(false);
    expect(isUlid('not-a-ulid')).toBe(false);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe(false); // 25 chars
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAVX')).toBe(false); // 27 chars
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false); // contains I
    expect(isUlid('01arz3ndektsv4rrffq69g5fav')).toBe(false); // lowercase
  });
});
