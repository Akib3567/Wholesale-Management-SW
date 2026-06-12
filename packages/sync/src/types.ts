/** One row as it travels in a packet: raw snake_case columns from SQLite. */
export type PacketRow = Record<string, unknown>;

/** table name -> rows. */
export type PacketTables = Record<string, PacketRow[]>;

export interface PacketHeader {
  formatVersion: 1;
  /** ULID, unique per packet. */
  packetId: string;
  /** 'branch' = one branch's own changes; 'combined' = hub's full snapshot of everyone. */
  kind: 'branch' | 'combined';
  senderBranch: string;
  senderIsHub: boolean;
  createdAt: string;
  /** Own-branch change_seq range covered: rows with fromSeq < change_seq <= toSeq. */
  watermark: { fromSeq: number; toSeq: number };
}

export interface BranchMeta {
  code: string;
  name: string;
  isHub: boolean;
}

export interface SyncPacket {
  header: PacketHeader;
  branches: BranchMeta[];
  tables: PacketTables;
}

export interface PacketManifest {
  /** rows per table. */
  counts: Record<string, number>;
  /** SHA-256 hex over the canonical JSON of {header, branches, tables}. */
  sha256: string;
}

export type SyncPacketErrorCode =
  | 'BAD_FORMAT'
  | 'UNSUPPORTED_VERSION'
  | 'DECRYPT_FAILED'
  | 'HASH_MISMATCH'
  | 'SIGNATURE_INVALID';

export class SyncPacketError extends Error {
  constructor(
    public readonly code: SyncPacketErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SyncPacketError';
  }
}
