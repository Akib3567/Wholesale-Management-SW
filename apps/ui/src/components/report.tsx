import type { ReactNode } from 'react';
import { Download, Printer } from 'lucide-react';
import { api, type BranchInfo, type InstallInfo } from '../lib/api';
import { useApi } from '../lib/useApi';
import { Button } from './ui/button';
import { Select } from './ui/select';

export interface AsOfBranch {
  code: string;
  name: string;
  lastImportAt: string | null;
}

/** The honest time-lag disclosure: foreign data is only as fresh as the last packet. */
export function AsOfNote({ asOf }: { asOf: AsOfBranch[] }) {
  if (asOf.length === 0) return null;
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      {asOf.map((b) => (
        <div key={b.code}>
          <strong>{b.code}</strong> data as of{' '}
          {b.lastImportAt ? new Date(b.lastImportAt).toLocaleString() : 'never synced'}
        </div>
      ))}
    </div>
  );
}

/** THIS / ALL / specific-branch scope select, shared by all reports. */
export function ScopePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const res = useApi(
    () => api.get<{ install: InstallInfo | null; branches: BranchInfo[] }>('/api/install'),
    [],
  );
  const mine = res.data?.install?.branchCode;
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-52">
      <option value="THIS">This branch{mine ? ` (${mine})` : ''}</option>
      <option value="ALL">Whole company</option>
      {(res.data?.branches ?? [])
        .filter((b) => b.code !== mine)
        .map((b) => (
          <option key={b.code} value={b.code}>
            {b.code} — {b.name}
          </option>
        ))}
    </Select>
  );
}

/** Title row + Print / CSV actions; children = filter controls. */
export function ReportHeader({
  title,
  onCsv,
  children,
}: {
  title: string;
  onCsv?: (() => void) | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
      <h1 className="text-xl font-bold">{title}</h1>
      <div className="flex flex-wrap items-end gap-3">
        {children}
        <div className="flex gap-2">
          {onCsv && (
            <Button variant="outline" size="sm" onClick={onCsv}>
              <Download className="h-3.5 w-3.5" /> CSV
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5" /> Print / PDF
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Heading shown only on the printed page. */
export function PrintTitle({ children }: { children: ReactNode }) {
  return <h1 className="hidden text-lg font-bold print:block">{children}</h1>;
}
