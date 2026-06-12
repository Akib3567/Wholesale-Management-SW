import { describe, expect, it } from 'vitest';
import { canonicalStringify } from './canonical';
import { buildManifest, openPacket, peekPacketMeta, sealPacket } from './packet';
import { SyncPacketError, type SyncPacket } from './types';

const PASS = 'company-sync-secret';

function samplePacket(): SyncPacket {
  return {
    header: {
      formatVersion: 1,
      packetId: '01JXXXXXXXXXXXXXXXXXXXXXX1',
      kind: 'branch',
      senderBranch: 'DHAKA',
      senderIsHub: true,
      createdAt: '2026-06-13T09:00:00.000Z',
      watermark: { fromSeq: 0, toSeq: 42 },
    },
    branches: [{ code: 'DHAKA', name: 'Dhaka Head Office', isHub: true }],
    tables: {
      parties: [
        { id: 'P1', branch_code: 'DHAKA', change_seq: 1, name: 'Hazaribagh Tannery', kind: 'supplier' },
        { id: 'P2', branch_code: 'DHAKA', change_seq: 2, name: 'Chawkbazar Stores', kind: 'customer' },
      ],
      journal_entries: [{ id: 'E1', branch_code: 'DHAKA', change_seq: 3, entry_date: '2026-06-13' }],
    },
  };
}

describe('canonicalStringify', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalStringify({ b: 1, a: { d: null, c: [2, 1] } })).toBe(
      canonicalStringify({ a: { c: [2, 1], d: null }, b: 1 }),
    );
  });
});

describe('seal -> open round trip', () => {
  it('returns the identical packet with a verified manifest', () => {
    const packet = samplePacket();
    const file = sealPacket(packet, PASS);
    const opened = openPacket(file, PASS);
    expect(opened.packet).toEqual(packet);
    expect(opened.manifest.counts).toEqual({ parties: 2, journal_entries: 1 });
    expect(opened.manifest).toEqual(buildManifest(packet));
  });

  it('peeks display meta without the passphrase', () => {
    const file = sealPacket(samplePacket(), PASS);
    expect(peekPacketMeta(file)).toEqual({
      sender: 'DHAKA',
      kind: 'branch',
      createdAt: '2026-06-13T09:00:00.000Z',
    });
    expect(peekPacketMeta(Buffer.from('garbage'))).toBeNull();
  });
});

describe('rejections', () => {
  it('wrong passphrase fails with DECRYPT_FAILED', () => {
    const file = sealPacket(samplePacket(), PASS);
    try {
      openPacket(file, 'some-other-secret');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SyncPacketError);
      expect((e as SyncPacketError).code).toBe('DECRYPT_FAILED');
    }
  });

  it('a tampered ciphertext byte fails authentication', () => {
    const file = sealPacket(samplePacket(), PASS);
    const json = JSON.parse(file.toString('utf8')) as { data: string };
    const chars = json.data.split('');
    const i = Math.floor(chars.length / 2);
    chars[i] = chars[i] === 'A' ? 'B' : 'A';
    json.data = chars.join('');
    const tampered = Buffer.from(JSON.stringify(json), 'utf8');

    try {
      openPacket(tampered, PASS);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SyncPacketError);
      expect((e as SyncPacketError).code).toBe('DECRYPT_FAILED'); // GCM auth tag catches it
    }
  });

  it('non-packet files fail with BAD_FORMAT', () => {
    try {
      openPacket(Buffer.from('{"hello":"world"}'), PASS);
      expect.unreachable();
    } catch (e) {
      expect((e as SyncPacketError).code).toBe('BAD_FORMAT');
    }
  });
});
