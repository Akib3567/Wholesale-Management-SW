import { useMemo, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { api, ApiError, type Party, type PaymentRow } from '../lib/api';
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

function firstOfMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('en-CA');
}
const today = () => new Date().toLocaleDateString('en-CA');

export function PaymentsPage() {
  const { install, hasRole } = useAuth();
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [direction, setDirection] = useState<'' | 'in' | 'out'>('');
  const list = useApi(
    () =>
      api.get<{ payments: PaymentRow[] }>(
        `/api/payments?from=${from}&to=${to}${direction ? `&direction=${direction}` : ''}`,
      ),
    [from, to, direction],
  );
  const partiesRes = useApi(
    () => api.get<{ parties: Party[] }>('/api/parties?includeInactive=true'),
    [],
  );
  const [open, setOpen] = useState(false);

  const parties = partiesRes.data?.parties ?? [];
  const partyName = useMemo(() => {
    const map = new Map(parties.map((p) => [p.id, p.name]));
    return (id: string) => map.get(id) ?? '…';
  }, [parties]);

  const rows = list.data?.payments ?? [];
  const totalIn = rows.filter((r) => r.direction === 'in').reduce((s, r) => s + r.amountPaisa, 0);
  const totalOut = rows.filter((r) => r.direction === 'out').reduce((s, r) => s + r.amountPaisa, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Payments &amp; Receipts (Taka Lenden)</h1>
        {hasRole('operator') && (
          <Button onClick={() => setOpen(true)} disabled={parties.length === 0}>
            <Plus className="h-4 w-4" /> New Payment / Receipt
          </Button>
        )}
      </div>

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
          <Label>Type</Label>
          <Select value={direction} onChange={(e) => setDirection(e.target.value as '' | 'in' | 'out')} className="w-40">
            <option value="">All</option>
            <option value="in">Receipts (money in)</option>
            <option value="out">Payments (money out)</option>
          </Select>
        </div>
      </div>

      {list.error && <ErrorNote message={list.error} />}
      {list.loading && !list.data ? (
        <Spinner />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Card>
              <CardContent className="p-3">
                <div className="text-xs text-muted-foreground">Received — Joma (in)</div>
                <div className="text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-400">{formatPaisa(totalIn)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <div className="text-xs text-muted-foreground">Paid — Porishodh (out)</div>
                <div className="text-lg font-bold tabular-nums text-red-700 dark:text-red-400">{formatPaisa(totalOut)}</div>
              </CardContent>
            </Card>
          </div>
          <Table>
            <THead>
              <TR>
                <TH>Date</TH><TH>Party</TH><TH>Type</TH><TH>Method</TH><TH>Ref</TH><TH>Branch</TH>
                <TH className="text-right">Amount</TH>
              </TR>
            </THead>
            <TBody>
              {rows.length === 0 && (
                <TR><TD colSpan={7} className="py-8 text-center text-muted-foreground">No payments in this range.</TD></TR>
              )}
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD>{r.paidDate}</TD>
                  <TD>{partyName(r.partyId)}</TD>
                  <TD>
                    <Badge variant={r.direction === 'in' ? 'success' : 'secondary'}>
                      {r.direction === 'in' ? 'Received' : 'Paid'}
                    </Badge>
                  </TD>
                  <TD>{r.method}</TD>
                  <TD className="text-muted-foreground">{r.refNo ?? ''}</TD>
                  <TD>
                    <Badge variant={r.branchCode === install?.branchCode ? 'secondary' : 'outline'}>
                      {r.branchCode}
                    </Badge>
                  </TD>
                  <TD className="text-right tabular-nums">{formatPaisa(r.amountPaisa)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </>
      )}

      {open && (
        <PaymentDialog
          parties={parties}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

function PaymentDialog({
  parties,
  onClose,
  onDone,
}: {
  parties: Party[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [partyId, setPartyId] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'cash' | 'bank'>('cash');
  const [paidDate, setPaidDate] = useState(today());
  const [refNo, setRefNo] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Receipts come from customers; payments go to suppliers ('both' parties qualify for either).
  const relevant = parties.filter((p) =>
    direction === 'in' ? p.kind === 'customer' || p.kind === 'both' : p.kind === 'supplier' || p.kind === 'both',
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const amountPaisa = parseTakaToPaisa(amount);
    if (amountPaisa === null || amountPaisa <= 0) return setError('Enter a valid amount');
    if (!partyId) return setError(direction === 'in' ? 'Pick a customer' : 'Pick a supplier');
    setBusy(true);
    try {
      await api.post('/api/payments', {
        partyId,
        direction,
        amountPaisa,
        method,
        paidDate,
        ...(refNo.trim() ? { refNo: refNo.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="New Payment / Receipt">
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label>Type</Label>
          <Select
            value={direction}
            onChange={(e) => {
              setDirection(e.target.value as 'in' | 'out');
              setPartyId('');
            }}
          >
            <option value="in">Receipt — money in from a customer (Taka Paowa)</option>
            <option value="out">Payment — money out to a supplier (Taka Deya)</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>{direction === 'in' ? 'Customer' : 'Supplier'}</Label>
          <Select value={partyId} onChange={(e) => setPartyId(e.target.value)} autoFocus>
            <option value="">— select —</option>
            {relevant.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.code})</option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Amount (৳)</Label>
            <Input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Method</Label>
            <Select value={method} onChange={(e) => setMethod(e.target.value as 'cash' | 'bank')}>
              <option value="cash">Cash</option>
              <option value="bank">Bank</option>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Date</Label>
            <Input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Reference no.</Label>
            <Input value={refNo} onChange={(e) => setRefNo(e.target.value)} placeholder="optional" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Note</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" />
        </div>
        {error && <ErrorNote message={error} />}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
