/** Minimal typed API client. Token in localStorage; 401 clears it and bounces to login. */

const TOKEN_KEY = 'leather-erp-token';
/** Electron (phase 10) injects an absolute base; the Vite dev server proxies '/api'. */
const API_BASE: string =
  (globalThis as { __ERP_API_BASE__?: string }).__ERP_API_BASE__ ?? '';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly issues?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, init);
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    clearToken();
    window.location.hash = '#/login';
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; issues?: Array<{ path: string; message: string }> } })?.error;
    throw new ApiError(err?.message ?? res.statusText, err?.code ?? 'UNKNOWN', res.status, err?.issues);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

// ---------- shared entity types (server returns drizzle camelCase rows) ----------

export type Role = 'admin' | 'manager' | 'operator' | 'viewer';
export const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, manager: 2, admin: 3 };

export interface User {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  isActive: boolean;
}

export interface InstallInfo {
  branchCode: string;
  isHub: boolean;
  nextChangeSeq: number;
  installedAt: string;
}

export interface BranchInfo {
  code: string;
  name: string;
  isHub: boolean;
}

export interface Party {
  id: string;
  branchCode: string;
  code: string;
  name: string;
  kind: 'customer' | 'supplier' | 'both';
  phone: string | null;
  address: string | null;
  openingBalancePaisa: number;
  isActive: boolean;
}

export interface Product {
  id: string;
  branchCode: string;
  name: string;
  sku: string | null;
  unit: 'pcs' | 'sqft' | 'kg';
  category: string | null;
  reorderLevelMilli: number;
  isProvisional: boolean;
  masterId: string | null;
  isActive: boolean;
}

export interface TradeDoc {
  id: string;
  branchCode: string;
  partyId: string | null;
  docNo: string;
  docDate: string;
  subtotalPaisa: number;
  discountPaisa: number;
  totalPaisa: number;
  paidPaisa: number;
  status: 'posted' | 'reversed';
  note: string | null;
}

export interface DashboardData {
  scope: string;
  branchCode: string;
  isHub: boolean;
  today: { salesPaisa: number; purchasesPaisa: number; expensesPaisa: number };
  cashPaisa: number;
  bankPaisa: number;
  receivablesPaisa: number;
  payablesPaisa: number;
  lowStockCount: number;
  lowStockBranch: string;
  series: Array<{ date: string; salesPaisa: number; purchasesPaisa: number }>;
  branches: Array<{
    code: string;
    name: string;
    isHub: boolean;
    isSelf: boolean;
    lastImportAt: string | null;
  }>;
}
