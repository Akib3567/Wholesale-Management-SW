import { useState, type FormEvent } from 'react';
import { Database, Download, ShieldCheck } from 'lucide-react';
import {
  api,
  ApiError,
  type BackupRecord,
  type BackupsData,
  type ExportData,
} from '../lib/api';
import { useApi } from '../lib/useApi';
import { formatPaisa } from '../lib/money';
import { downloadCsv } from '../lib/csv';
import { useAuth } from '../auth/AuthContext';
import { AsOfNote, ScopePicker } from '../components/report';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { ErrorNote, Spinner } from '../components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/table';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Plain decimal (no thousands separators) so spreadsheets treat it as a number. */
function csvAmount(paisa: number): string {
  return formatPaisa(paisa).replace(/,/g, '');
}

export function BackupsPage() {
  const { hasRole } = useAuth();
  const data = useApi(() => api.get<BackupsData>('/api/backups'), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function createBackup() {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await api.post('/api/backups', { kind: 'manual' });
      setNotice('Backup created.');
      data.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Backup failed');
    } finally {
      setBusy(false);
    }
  }

  async function verify(b: BackupRecord) {
    setError('');
    setNotice('');
    try {
      await api.post(`/api/backups/${b.id}/verify`, {});
      setNotice(`Backup ${b.kind} (${new Date(b.takenAt).toLocaleString()}) verified OK.`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Verify failed');
    }
  }

  async function restore(b: BackupRecord) {
    if (
      !window.confirm(
        `Restore from this ${b.kind} backup taken ${new Date(b.takenAt).toLocaleString()}?\n\n` +
          'A safety backup of the current data is taken first. The app must then be restarted to apply the restore.',
      )
    )
      return;
    setError('');
    setNotice('');
    try {
      await api.post(`/api/backups/${b.id}/restore`, {});
      setNotice(
        'Restore staged and a safety backup was taken. CLOSE and REOPEN the app to apply the restore.',
      );
      data.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Restore failed');
    }
  }

  if (data.loading && !data.data) return <Spinner />;
  if (data.error) return <ErrorNote message={data.error} />;
  const d = data.data!;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Backups</h1>
        {d.passphraseSet && hasRole('manager') && (
          <Button onClick={createBackup} disabled={busy}>
            <Database className="h-4 w-4" /> {busy ? 'Backing up…' : 'Back up now'}
          </Button>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        Backups are encrypted snapshots of this PC's data, stored locally. They protect against
        data loss on this machine — separate from <strong>sync</strong>, which shares data between
        branches. Scheduled automatically: daily, weekly, monthly, yearly, and on app close.
      </p>

      {notice && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200">
          {notice}
        </div>
      )}
      {error && <ErrorNote message={error} />}

      {!d.passphraseSet ? (
        <PassphraseSetup canSet={hasRole('admin')} onDone={data.reload} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Local backups ({d.backups.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH>Taken</TH>
                  <TH>Kind</TH>
                  <TH className="text-right">Size</TH>
                  <TH>Status</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {d.backups.length === 0 && (
                  <TR>
                    <TD colSpan={5} className="py-8 text-center text-muted-foreground">
                      No backups yet — click "Back up now".
                    </TD>
                  </TR>
                )}
                {d.backups.map((b) => (
                  <TR key={b.id}>
                    <TD>{new Date(b.takenAt).toLocaleString()}</TD>
                    <TD>
                      <Badge variant="secondary">{b.kind}</Badge>
                    </TD>
                    <TD className="text-right tabular-nums">{formatBytes(b.sizeBytes)}</TD>
                    <TD>
                      <Badge variant={b.status === 'ok' ? 'success' : 'outline'}>{b.status}</Badge>
                    </TD>
                    <TD className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => verify(b)}>
                          <ShieldCheck className="h-3.5 w-3.5" /> Verify
                        </Button>
                        {hasRole('admin') && (
                          <Button variant="ghost" size="sm" onClick={() => restore(b)}>
                            Restore
                          </Button>
                        )}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <CsvExportCard />
    </div>
  );
}

function firstOfMonth(): string {
  const dt = new Date();
  return new Date(dt.getFullYear(), dt.getMonth(), 1).toLocaleDateString('en-CA');
}
const today = () => new Date().toLocaleDateString('en-CA');

/** Download business records for a chosen date range as CSV spreadsheet files. */
function CsvExportCard() {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [scope, setScope] = useState('THIS');
  const { data, error, loading } = useApi(
    () => api.get<ExportData>(`/api/export/data?from=${from}&to=${to}&scope=${scope}`),
    [from, to, scope],
  );

  const rangeName = `${from}_to_${to}`;

  function downloadSales(kind: 'sales' | 'purchases') {
    if (!data) return;
    const rows = data[kind];
    const partyLabel = kind === 'sales' ? 'Customer' : 'Supplier';
    downloadCsv(`${kind}-${rangeName}.csv`, [
      ['Date', 'Doc No', 'Branch', partyLabel, 'Subtotal', 'Discount', 'Total', 'Paid', 'Due', 'Status', 'Note'],
      ...rows.map((r) => [
        r.date, r.docNo, r.branchCode, r.partyName ?? (kind === 'sales' ? 'Walk-in' : ''),
        csvAmount(r.subtotalPaisa), csvAmount(r.discountPaisa), csvAmount(r.totalPaisa),
        csvAmount(r.paidPaisa), csvAmount(r.totalPaisa - r.paidPaisa), r.status, r.note ?? '',
      ]),
    ]);
  }

  function downloadPayments() {
    if (!data) return;
    downloadCsv(`payments-${rangeName}.csv`, [
      ['Date', 'Party', 'Type', 'Method', 'Reference', 'Amount', 'Branch', 'Note'],
      ...data.payments.map((r) => [
        r.date, r.partyName ?? '', r.direction === 'in' ? 'Received' : 'Paid', r.method,
        r.refNo ?? '', csvAmount(r.amountPaisa), r.branchCode, r.note ?? '',
      ]),
    ]);
  }

  function downloadExpenses() {
    if (!data) return;
    downloadCsv(`expenses-${rangeName}.csv`, [
      ['Date', 'Account', 'Paid From', 'Amount', 'Branch', 'Note'],
      ...data.expenses.map((r) => [
        r.date, r.accountName, r.paidFromName ?? '', csvAmount(r.amountPaisa), r.branchCode, r.note ?? '',
      ]),
    ]);
  }

  const datasets = data
    ? ([
        ['Sales', data.sales.length, () => downloadSales('sales')],
        ['Purchases', data.purchases.length, () => downloadSales('purchases')],
        ['Payments & Receipts', data.payments.length, downloadPayments],
        ['Expenses', data.expenses.length, downloadExpenses],
      ] as const)
    : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Export data to CSV (date range)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Download your records for a chosen period as CSV spreadsheet files (open in Excel). This
          is a readable data export — separate from the encrypted snapshots above, which are for
          restoring this PC.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label>From</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
          </div>
          <div className="space-y-1">
            <Label>To</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
          </div>
          <div className="space-y-1">
            <Label>Scope</Label>
            <ScopePicker value={scope} onChange={setScope} />
          </div>
        </div>

        {data && <AsOfNote asOf={data.asOf} />}
        {error && <ErrorNote message={error} />}
        {loading && !data ? (
          <Spinner />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {datasets.map(([label, count, dl]) => (
              <div key={label} className="flex items-center justify-between rounded-md border px-3 py-2">
                <span className="text-sm">
                  {label} <span className="text-muted-foreground">({count} records)</span>
                </span>
                <Button variant="outline" size="sm" onClick={dl} disabled={count === 0}>
                  <Download className="h-3.5 w-3.5" /> CSV
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PassphraseSetup({ canSet, onDone }: { canSet: boolean; onDone: () => void }) {
  const [value, setValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (value !== confirm) return setError('Passphrases do not match');
    setBusy(true);
    try {
      await api.post('/api/backups/passphrase', { passphrase: value });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to set passphrase');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Backup encryption passphrase</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-muted-foreground">
          Backups are encrypted with this passphrase. <strong>Keep it safe</strong> — without it,
          backups cannot be restored. It is local to this PC and can differ from the sync
          passphrase.
        </p>
        {!canSet ? (
          <ErrorNote message="Only an administrator can set the backup passphrase." />
        ) : (
          <form onSubmit={onSubmit} className="max-w-sm space-y-3">
            <div className="space-y-1.5">
              <Label>Passphrase (min 8 chars)</Label>
              <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Confirm</Label>
              <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            {error && <ErrorNote message={error} />}
            <Button type="submit" disabled={busy || value.length < 8}>
              {busy ? 'Saving…' : 'Set passphrase'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
