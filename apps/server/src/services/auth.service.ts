import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { newUlid } from '@leather-erp/core';
import { users, USER_ROLES, type Db, type UserRole } from '@leather-erp/db';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from '../errors';
import { writeAudit } from './audit';
import { nowIso } from './change-seq';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h sliding

export const ROLE_RANK: Record<UserRole, number> = {
  viewer: 0,
  operator: 1,
  manager: 2,
  admin: 3,
};

export const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

export const createUserSchema = z.object({
  username: z
    .string()
    .trim()
    .regex(/^[a-z0-9_.-]{3,32}$/i, 'Username: 3-32 chars, letters/digits/._-'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  fullName: z.string().trim().min(1).max(80),
  role: z.enum(USER_ROLES),
});

export const updateUserSchema = z
  .object({
    fullName: z.string().trim().min(1).max(80),
    role: z.enum(USER_ROLES),
    isActive: z.boolean(),
    newPassword: z.string().min(6),
  })
  .partial();

export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(6, 'Password must be at least 6 characters'),
});

export interface PublicUser {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
}

interface SessionRecord {
  userId: string;
  expiresAt: number;
}

function toPublic(row: typeof users.$inferSelect): PublicUser {
  return {
    id: row.id,
    username: row.username,
    fullName: row.fullName,
    role: row.role,
    isActive: row.isActive,
    createdAt: row.createdAt,
  };
}

/**
 * Session-token auth. Sessions are in-memory: this is a single-PC desktop
 * app, so an app restart simply requires logging in again. The user row is
 * re-read on every request, so deactivation/role changes apply immediately.
 */
export class AuthService {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly db: Db) {}

  async login(input: z.infer<typeof loginSchema>): Promise<{ token: string; user: PublicUser }> {
    const { username, password } = loginSchema.parse(input);
    const row = this.db.select().from(users).where(eq(users.username, username)).get();
    const valid = row && row.isActive && (await argon2.verify(row.passwordHash, password));
    if (!valid || !row) {
      writeAudit(this.db, { action: 'auth.login_failed', detail: { username } });
      throw new UnauthorizedError('Invalid username or password');
    }
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { userId: row.id, expiresAt: Date.now() + SESSION_TTL_MS });
    writeAudit(this.db, { userId: row.id, action: 'auth.login' });
    return { token, user: toPublic(row) };
  }

  logout(token: string): void {
    this.sessions.delete(token);
  }

  /** Returns the live user for a valid session (sliding expiry), else null. */
  resolveSession(token: string): PublicUser | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    const row = this.db.select().from(users).where(eq(users.id, session.userId)).get();
    if (!row || !row.isActive) {
      this.sessions.delete(token);
      return null;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return toPublic(row);
  }

  async changePassword(userId: string, input: z.infer<typeof changePasswordSchema>): Promise<void> {
    const { oldPassword, newPassword } = changePasswordSchema.parse(input);
    const row = this.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) throw new NotFoundError('User not found');
    if (!(await argon2.verify(row.passwordHash, oldPassword))) {
      throw new BadRequestError('Current password is incorrect');
    }
    const passwordHash = await argon2.hash(newPassword);
    this.db
      .update(users)
      .set({ passwordHash, updatedAt: nowIso() })
      .where(eq(users.id, userId))
      .run();
    writeAudit(this.db, { userId, action: 'auth.change_password' });
  }

  listUsers(): PublicUser[] {
    return this.db.select().from(users).all().map(toPublic);
  }

  async createUser(input: z.infer<typeof createUserSchema>, actorId: string): Promise<PublicUser> {
    const parsed = createUserSchema.parse(input);
    const existing = this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, parsed.username))
      .get();
    if (existing) throw new ConflictError(`Username '${parsed.username}' is already taken`);
    const passwordHash = await argon2.hash(parsed.password);
    const id = newUlid();
    this.db
      .insert(users)
      .values({
        id,
        username: parsed.username,
        passwordHash,
        fullName: parsed.fullName,
        role: parsed.role,
      })
      .run();
    writeAudit(this.db, {
      userId: actorId,
      action: 'user.create',
      tableName: 'users',
      recordId: id,
      detail: { username: parsed.username, role: parsed.role },
    });
    const row = this.db.select().from(users).where(eq(users.id, id)).get();
    if (!row) throw new Error('user insert failed');
    return toPublic(row);
  }

  async updateUser(
    id: string,
    input: z.infer<typeof updateUserSchema>,
    actorId: string,
  ): Promise<PublicUser> {
    const patch = updateUserSchema.parse(input);
    const row = this.db.select().from(users).where(eq(users.id, id)).get();
    if (!row) throw new NotFoundError('User not found');

    // Never lock everyone out: keep at least one active admin.
    const losesAdmin =
      row.role === 'admin' &&
      ((patch.role !== undefined && patch.role !== 'admin') || patch.isActive === false);
    if (losesAdmin) {
      const admins = this.db.select().from(users).all();
      const otherActiveAdmins = admins.filter(
        (u) => u.id !== id && u.role === 'admin' && u.isActive,
      );
      if (otherActiveAdmins.length === 0) {
        throw new ConflictError('Cannot demote or deactivate the last active admin');
      }
    }

    const update: Partial<typeof users.$inferInsert> = { updatedAt: nowIso() };
    if (patch.fullName !== undefined) update.fullName = patch.fullName;
    if (patch.role !== undefined) update.role = patch.role;
    if (patch.isActive !== undefined) update.isActive = patch.isActive;
    if (patch.newPassword !== undefined) {
      update.passwordHash = await argon2.hash(patch.newPassword);
    }
    this.db.update(users).set(update).where(eq(users.id, id)).run();
    writeAudit(this.db, {
      userId: actorId,
      action: 'user.update',
      tableName: 'users',
      recordId: id,
      detail: { ...patch, newPassword: patch.newPassword ? '***' : undefined },
    });
    const updated = this.db.select().from(users).where(eq(users.id, id)).get();
    if (!updated) throw new Error('user update failed');
    return toPublic(updated);
  }
}
