import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { api, ApiError, type Party } from '../lib/api';
import { useApi } from '../lib/useApi';
import { formatPaisa, parseTakaToPaisa } from '../lib/money';
import { useAuth } from '../auth/AuthContext';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select } from '../components/ui/select';
import { ErrorNote, Spinner } from '../components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/table';

/** Render a party's net balance as Pabo (they owe us) / Debo (we owe them). */
function BalanceCell({ paisa }: { paisa: number | undefined }) {
  if (paisa === undefined) return <span className="text-muted-foreground">—</span>;
  if (paisa > 0)
    return (
      <span className="font-medium text-emerald-700 dark:text-emerald-400">
        {formatPaisa(paisa)} <span className="text-xs font-normal">Pabo</span>
      </span>
    );
  if (paisa < 0)
    return (
      <span className="font-medium text-red-700 dark:text-red-400">
        {formatPaisa(-paisa)} <span className="text-xs font-normal">Debo</span>
      </span>
    );
  return <span className="text-muted-foreground">0.00</span>;
}

export function PartiesPage() {
  const { install, hasRole } = useAuth();
  const [q, setQ] = useState('');
  const res = useApi(
    () =>
      api.get<{ parties: Party[] }>(
        `/api/parties?withBalances=1${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      ),
    [q],
  );
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'customer' | 'supplier' | 'both'>('customer');
  const [phone, setPhone] = useState('');
  const [opening, setOpening] = useState('');
  const [openingSide, setOpeningSide] = useState<'they_owe' | 'we_owe'>('they_owe');
  const [shared, setShared] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError('');
    const openingPaisa = opening.trim() === '' ? 0 : parseTakaToPaisa(opening);
    if (openingPaisa === null || openingPaisa < 0) return setError('Opening balance must be a valid amount');
    setBusy(true);
    try {
      await api.post('/api/parties', {
        name: name.trim(),
        kind,
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        openingBalancePaisa: openingSide === 'they_owe' ? openingPaisa : -openingPaisa,
        shared,
      });
      setOpen(false);
      setName(''); setPhone(''); setOpening(''); setShared(false);
      res.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create');
    } finally {
      setBusy(false);
    }
  }

  const parties = res.data?.parties ?? [];
  const totalPabo = parties.reduce((s, p) => s + Math.max(p.balancePaisa ?? 0, 0), 0);
  const totalDebo = parties.reduce((s, p) => s + Math.max(-(p.balancePaisa ?? 0), 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Parties</h1>
        {hasRole('operator') && (
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> New Party
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Total Receivable — due to us (Pabo)</div>
            <div className="text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
              {formatPaisa(totalPabo)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Total Payable — we owe (Debo)</div>
            <div className="text-lg font-bold tabular-nums text-red-700 dark:text-red-400">
              {formatPaisa(totalDebo)}
            </div>
          </CardContent>
        </Card>
      </div>

      <Input
        placeholder="Search name / code / phone (khujun)…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="max-w-sm"
      />
      {res.error && <ErrorNote message={res.error} />}
      {res.loading && !res.data ? (
        <Spinner />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Code</TH>
              <TH>Name (Naam)</TH>
              <TH>Kind (Dhoron)</TH>
              <TH>Phone</TH>
              <TH>Owner (Branch)</TH>
              <TH className="text-right">Balance (Pabo / Debo)</TH>
              <TH className="text-right">Opening balance</TH>
            </TR>
          </THead>
          <TBody>
            {parties.length === 0 && (
              <TR>
                <TD colSpan={7} className="py-8 text-center text-muted-foreground">
                  No parties yet.
                </TD>
              </TR>
            )}
            {parties.map((p) => (
              <TR key={p.id}>
                <TD className="font-medium">{p.code}</TD>
                <TD>{p.name}</TD>
                <TD>{p.kind}</TD>
                <TD>{p.phone ?? '—'}</TD>
                <TD>
                  <Badge variant={p.branchCode === install?.branchCode ? 'secondary' : 'outline'}>
                    {p.branchCode}
                  </Badge>
                </TD>
                <TD className="text-right tabular-nums">
                  <BalanceCell paisa={p.balancePaisa} />
                </TD>
                <TD className="text-right tabular-nums">{formatPaisa(p.openingBalancePaisa)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} title="New Party">
        <form onSubmit={onCreate} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Kind (Dhoron)</Label>
              <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="customer">Customer</option>
                <option value="supplier">Supplier</option>
                <option value="both">Both</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Opening balance (৳)</Label>
              <Input inputMode="decimal" placeholder="0.00" value={opening} onChange={(e) => setOpening(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Direction</Label>
              <Select value={openingSide} onChange={(e) => setOpeningSide(e.target.value as typeof openingSide)}>
                <option value="they_owe">They owe us (Amra Pabo)</option>
                <option value="we_owe">We owe them (Amra Debo)</option>
              </Select>
            </div>
          </div>
          {install?.isHub && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
              SHARED party (company-wide, mastered at this hub)
            </label>
          )}
          {error && <ErrorNote message={error} />}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? 'Saving…' : 'Create'}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
