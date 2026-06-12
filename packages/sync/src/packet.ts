import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import { canonicalStringify } from './canonical';
import {
  decryptAesGcm,
  deriveKeys,
  encryptAesGcm,
  hmacHex,
  hmacMatches,
  newSalt,
} from './crypto';
import {
  SyncPacketError,
  type PacketManifest,
  type SyncPacket,
} from './types';

const PACKET_FORMAT = 'leather-erp-sync';

/** Plaintext outer envelope. `meta` is display-only — logic trusts ONLY the encrypted header. */
const envelopeSchema = z.object({
  format: z.literal(PACKET_FORMAT),
  version: z.literal(1),
  meta: z.object({
    sender: z.string(),
    kind: z.enum(['branch', 'combined']),
    createdAt: z.string(),
  }),
  salt: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
  data: z.string().min(1),
});

const headerSchema = z.object({
  formatVersion: z.literal(1),
  packetId: z.string().min(1),
  kind: z.enum(['branch', 'combined']),
  senderBranch: z.string().min(1),
  senderIsHub: z.boolean(),
  createdAt: z.string().min(1),
  watermark: z.object({ fromSeq: z.number().int(), toSeq: z.number().int() }),
});

const payloadSchema = z.object({
  header: headerSchema,
  branches: z.array(z.object({ code: z.string(), name: z.string(), isHub: z.boolean() })),
  tables: z.record(z.array(z.record(z.unknown()))),
  manifest: z.object({ counts: z.record(z.number().int()), sha256: z.string().length(64) }),
  signature: z.string().min(1),
});

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function bodyBytes(packet: SyncPacket): Buffer {
  return Buffer.from(
    canonicalStringify({
      header: packet.header,
      branches: packet.branches,
      tables: packet.tables,
    }),
    'utf8',
  );
}

export function buildManifest(packet: SyncPacket): PacketManifest {
  const counts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(packet.tables)) counts[table] = rows.length;
  return { counts, sha256: sha256Hex(bodyBytes(packet)) };
}

/**
 * packet -> manifest + HMAC signature -> gzip -> AES-256-GCM -> envelope JSON.
 * The returned Buffer is the .packet file content.
 */
export function sealPacket(packet: SyncPacket, passphrase: string): Buffer {
  const body = bodyBytes(packet);
  const manifest = buildManifest(packet);
  const salt = newSalt();
  const keys = deriveKeys(passphrase, salt);
  const signature = hmacHex(keys.macKey, body);

  const payload = {
    header: packet.header,
    branches: packet.branches,
    tables: packet.tables,
    manifest,
    signature,
  };
  const plaintext = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const blob = encryptAesGcm(keys.encKey, plaintext);

  const envelope = {
    format: PACKET_FORMAT,
    version: 1,
    meta: {
      sender: packet.header.senderBranch,
      kind: packet.header.kind,
      createdAt: packet.header.createdAt,
    },
    salt: salt.toString('base64'),
    iv: blob.iv.toString('base64'),
    tag: blob.tag.toString('base64'),
    data: blob.data.toString('base64'),
  };
  return Buffer.from(JSON.stringify(envelope), 'utf8');
}

export interface OpenedPacket {
  packet: SyncPacket;
  manifest: PacketManifest;
}

/** Verify EVERYTHING (format, GCM tag, gzip, schema, SHA-256, HMAC), or throw SyncPacketError. */
export function openPacket(file: Buffer, passphrase: string): OpenedPacket {
  let envelope: z.infer<typeof envelopeSchema>;
  try {
    envelope = envelopeSchema.parse(JSON.parse(file.toString('utf8')));
  } catch {
    throw new SyncPacketError('BAD_FORMAT', 'Not a leather-erp sync packet (or unsupported version)');
  }

  const keys = deriveKeys(passphrase, Buffer.from(envelope.salt, 'base64'));
  const plaintext = decryptAesGcm(keys.encKey, {
    iv: Buffer.from(envelope.iv, 'base64'),
    tag: Buffer.from(envelope.tag, 'base64'),
    data: Buffer.from(envelope.data, 'base64'),
  });

  let payload: z.infer<typeof payloadSchema>;
  try {
    payload = payloadSchema.parse(JSON.parse(gunzipSync(plaintext).toString('utf8')));
  } catch {
    throw new SyncPacketError('BAD_FORMAT', 'Packet decrypted but its contents are malformed');
  }

  const packet: SyncPacket = {
    header: payload.header,
    branches: payload.branches,
    tables: payload.tables as SyncPacket['tables'],
  };
  const body = bodyBytes(packet);

  if (sha256Hex(body) !== payload.manifest.sha256) {
    throw new SyncPacketError('HASH_MISMATCH', 'Packet manifest SHA-256 does not match contents');
  }
  if (!hmacMatches(keys.macKey, body, payload.signature)) {
    throw new SyncPacketError('SIGNATURE_INVALID', 'Packet signature verification failed');
  }
  return { packet, manifest: payload.manifest };
}

/** Read the plaintext display meta without the passphrase (UI hint only — never trusted). */
export function peekPacketMeta(
  file: Buffer,
): { sender: string; kind: 'branch' | 'combined'; createdAt: string } | null {
  try {
    return envelopeSchema.parse(JSON.parse(file.toString('utf8'))).meta;
  } catch {
    return null;
  }
}
