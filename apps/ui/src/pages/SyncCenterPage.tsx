import { useRef, useState, type FormEvent } from 'react';
import { Download, Upload } from 'lucide-react';
import {
  api,
  ApiError,
  downloadAuthed,
  type ExportResult,
  type ImportResult,
  type Product,
  type SyncStatus,
} from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuth } from '../auth/AuthContext';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select } from '../components/ui/select';
import { ErrorNote, Spinner } from '../components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/table';

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '');
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function SyncCenterPage() {
  const { hasRole } = useAuth();
  const status = useApi(() => api.get<SyncStatus>('/api/sync/status'), []);
  const reloadAll = () => status.reload();

  if (status.loading && !status.data) return <Spinner />;
  if (status.error) return <ErrorNote message={status.error} />;
  const s = status.data!;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Sync Center</h1>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{s.branchCode}</Badge>
          {s.isHub && <Badge>HUB</Badge>}
          {s.passphraseSet ? (
            <Badge variant="success">passphrase set</Badge>
          ) : (
            <Badge variant="destructive">no passphrase</Badge>
          )}
        </div>
      </div>

      {!s.passphraseSet && <PassphraseSetup canSet={hasRole('admin')} onDone={reloadAll} />}

      {s.passphraseSet && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <ExportCard onDone={reloadAll} />
            <ImportCard onDone={reloadAll} />
          </div>
          {s.isHub && <HubTools onDone={reloadAll} />}
        </>
      )}

      <Card>
        <CardHeader><CardTitle>Per-branch sync state</CardTitle></CardHeader>
        <CardContent>
          {s.state.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sync activity yet.</p>
          ) : (
            <Table>
              <THead><TR><TH>Peer</TH><TH>Last export</TH><TH>Last import</TH></TR></THead>
              <TBody>
                {s.state.map((r) => (
                  <TR key={r.peerBranch}>
                    <TD className="font-medium">{r.peerBranch}</TD>
                    <TD>{r.lastExportAt ? new Date(r.lastExportAt).toLocaleString() : '—'}</TD>
                    <TD>{r.lastImportAt ? new Date(r.lastImportAt).toLocaleString() : '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Sync log</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <THead><TR><TH>When</TH><TH>Direction</TH><TH>Peer</TH><TH className="text-right">Rows</TH><TH>Status</TH></TR></THead>
            <TBody>
              {s.log.length === 0 && <TR><TD colSpan={5} className="py-4 text-center text-muted-foreground">No packets yet.</TD></TR>}
              {s.log.map((l) => (
                <TR key={l.id}>
                  <TD>{new Date(l.at).toLocaleString()}</TD>
                  <TD>{l.direction}</TD>
                  <TD>{l.peerBranch}</TD>
                  <TD className="text-right tabular-nums">{l.recordCount}</TD>
                  <TD>
                    <Badge variant={l.status === 'ok' ? 'success' : 'destructive'}>{l.status}</Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
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
      await api.post('/api/sync/passphrase', { passphrase: value });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to set passphrase');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Sync encryption passphrase</CardTitle></CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-muted-foreground">
          Sync packets are encrypted and signed with one shared company passphrase. <strong>Every
          branch PC must use the exact same passphrase</strong>, or packets can't be read.
        </p>
        {!canSet ? (
          <ErrorNote message="Only an administrator can set the sync passphrase." />
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

function ExportCard({ onDone }: { onDone: () => void }) {
  const { hasRole } = useAuth();
  const [dest, setDest] = useState('HUB');
  const [full, setFull] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function doExport() {
    setError('');
    setBusy(true);
    try {
      const res = await api.post<ExportResult>('/api/sync/export', { destBranch: dest, full });
      setResult(res);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    if (!result) return;
    try {
      const name = basename(result.filePath);
      await downloadAuthed(`/api/sync/download?name=${encodeURIComponent(name)}`, name);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Download failed');
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Export packet (changes to carry out)</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-end gap-3">
          <div className="space-y-1">
            <Label>Destination</Label>
            <Input value={dest} onChange={(e) => setDest(e.target.value.toUpperCase())} className="w-32" />
          </div>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} />
            Full resend
          </label>
          {hasRole('manager') && (
            <Button onClick={doExport} disabled={busy}>
              <Upload className="h-4 w-4" /> {busy ? 'Exporting…' : 'Export'}
            </Button>
          )}
        </div>
        {error && <ErrorNote message={error} />}
        {result && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <div className="mb-1 font-medium">
              {result.totalRows} rows · {result.kind} packet (seq {result.fromSeq}→{result.toSeq})
            </div>
            <div className="mb-2 break-all text-xs text-muted-foreground">{result.filePath}</div>
            <Button variant="outline" size="sm" onClick={download}>
              <Download className="h-3.5 w-3.5" /> Download .packet
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ImportCard({ onDone }: { onDone: () => void }) {
  const { hasRole } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setResult(null);
    setBusy(true);
    try {
      const fileBase64 = await fileToBase64(file);
      const res = await api.post<ImportResult>('/api/sync/import-upload', {
        fileName: file.name,
        fileBase64,
      });
      setResult(res);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Import failed');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Import packet (carried in from another branch)</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <input ref={fileRef} type="file" accept=".packet" className="hidden" onChange={onFile} />
        {hasRole('manager') && (
          <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Upload className="h-4 w-4" /> {busy ? 'Importing…' : 'Choose .packet file'}
          </Button>
        )}
        {error && <ErrorNote message={error} />}
        {result && (
          <div className="rounded-md border bg-emerald-50 p-3 text-sm text-emerald-900">
            Imported from <strong>{result.senderBranch}</strong> ({result.kind}):{' '}
            {result.counts.inserted} new, {result.counts.updated} updated,{' '}
            {result.counts.skippedUnchanged} unchanged, {result.counts.skippedOwn} own-rows skipped
            {result.counts.mergedProducts > 0 && `, ${result.counts.mergedProducts} product merges applied`}.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HubTools({ onDone }: { onDone: () => void }) {
  const { hasRole } = useAuth();
  const products = useApi(() => api.get<{ products: Product[] }>('/api/products'), []);
  const [combined, setCombined] = useState<ExportResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const provisionals = (products.data?.products ?? []).filter((p) => p.isProvisional && !p.masterId);
  const masters = (products.data?.products ?? []).filter((p) => !p.isProvisional && p.branchCode === 'SHARED');

  async function buildCombined() {
    setError('');
    setBusy(true);
    try {
      setCombined(await api.post<ExportResult>('/api/sync/combined', {}));
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Build failed');
    } finally {
      setBusy(false);
    }
  }

  async function downloadCombined() {
    if (!combined) return;
    const name = basename(combined.filePath);
    await downloadAuthed(`/api/sync/download?name=${encodeURIComponent(name)}`, name);
  }

  return (
    <Card>
      <CardHeader><CardTitle>Hub tools</CardTitle></CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <div className="text-sm font-medium">Combined company packet</div>
          <p className="text-sm text-muted-foreground">
            Build one packet containing every branch's latest data, for branches to import and see
            the whole company.
          </p>
          <div className="flex items-center gap-2">
            {hasRole('manager') && (
              <Button onClick={buildCombined} disabled={busy}>{busy ? 'Building…' : 'Build combined packet'}</Button>
            )}
            {combined && (
              <Button variant="outline" size="sm" onClick={downloadCombined}>
                <Download className="h-3.5 w-3.5" /> Download ({combined.totalRows} rows)
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">Provisional products to merge ({provisionals.length})</div>
          {error && <ErrorNote message={error} />}
          {provisionals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No provisional products awaiting merge.</p>
          ) : (
            <Table>
              <THead><TR><TH>Product</TH><TH>From branch</TH><TH>Merge into</TH></TR></THead>
              <TBody>
                {provisionals.map((p) => (
                  <MergeRow key={p.id} product={p} masters={masters} onDone={() => { products.reload(); onDone(); }} />
                ))}
              </TBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function MergeRow({
  product,
  masters,
  onDone,
}: {
  product: Product;
  masters: Product[];
  onDone: () => void;
}) {
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function merge() {
    setBusy(true);
    setError('');
    try {
      await api.post('/api/sync/merge-product', {
        provisionalId: product.id,
        ...(target ? { masterId: target } : {}),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Merge failed');
      setBusy(false);
    }
  }

  return (
    <TR>
      <TD className="font-medium">
        {product.name} ({product.unit})
        {error && <div className="text-xs text-destructive">{error}</div>}
      </TD>
      <TD>{product.branchCode}</TD>
      <TD>
        <div className="flex items-center gap-2">
          <Select value={target} onChange={(e) => setTarget(e.target.value)} className="w-48">
            <option value="">New master product</option>
            {masters.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </Select>
          <Button size="sm" onClick={merge} disabled={busy}>{busy ? '…' : 'Merge'}</Button>
        </div>
      </TD>
    </TR>
  );
}
