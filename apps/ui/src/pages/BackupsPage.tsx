import { useState, type FormEvent } from 'react';
import { Database, ShieldCheck } from 'lucide-react';
import { api, ApiError, type BackupRecord, type BackupsData } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuth } from '../auth/AuthContext';
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
    </div>
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
