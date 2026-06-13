import { useMemo, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { api, ApiError, type Account, type ExpenseRow } from '../lib/api';
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

export function ExpensesPage() {
  const { install, hasRole } = useAuth();
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const list = useApi(
    () => api.get<{ expenses: ExpenseRow[] }>(`/api/expenses?from=${from}&to=${to}`),
    [from, to],
  );
  const accountsRes = useApi(() => api.get<{ accounts: Account[] }>('/api/accounts'), []);
  const [open, setOpen] = useState(false);

  const accounts = accountsRes.data?.accounts ?? [];
  const expenseAccounts = accounts.filter((a) => a.type === 'expense' && a.parentId !== null);
  const cashBankAccounts = accounts.filter((a) => a.isCash || a.isBank);
  const accountName = useMemo(() => {
    const map = new Map(accounts.map((a) => [a.id, `${a.code} — ${a.name}`]));
    return (id: string | null) => (id ? (map.get(id) ?? '…') : '—');
  }, [accounts]);

  const rows = list.data?.expenses ?? [];
  const total = rows.reduce((s, r) => s + r.amountPaisa, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Expenses</h1>
        {hasRole('operator') && (
          <Button onClick={() => setOpen(true)} disabled={expenseAccounts.length === 0}>
            <Plus className="h-4 w-4" /> New Expense
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
      </div>

      {list.error && <ErrorNote message={list.error} />}
      {list.loading && !list.data ? (
        <Spinner />
      ) : (
        <>
          <Card>
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground">Total in range</div>
              <div className="text-lg font-bold tabular-nums">{formatPaisa(total)}</div>
            </CardContent>
          </Card>
          <Table>
            <THead>
              <TR>
                <TH>Date</TH><TH>Account</TH><TH>Note</TH><TH>Paid from</TH><TH>Branch</TH>
                <TH className="text-right">Amount</TH>
              </TR>
            </THead>
            <TBody>
              {rows.length === 0 && (
                <TR><TD colSpan={6} className="py-8 text-center text-muted-foreground">No expenses in this range.</TD></TR>
              )}
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD>{r.spentDate}</TD>
                  <TD>{accountName(r.expenseAccountId)}</TD>
                  <TD className="text-muted-foreground">{r.note ?? ''}</TD>
                  <TD>{accountName(r.paidFromAccountId)}</TD>
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
        <ExpenseDialog
          expenseAccounts={expenseAccounts}
          cashBankAccounts={cashBankAccounts}
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

function ExpenseDialog({
  expenseAccounts,
  cashBankAccounts,
  onClose,
  onDone,
}: {
  expenseAccounts: Account[];
  cashBankAccounts: Account[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [expenseAccountId, setExpenseAccountId] = useState(expenseAccounts[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [spentDate, setSpentDate] = useState(today());
  const [paidFromAccountId, setPaidFromAccountId] = useState(
    cashBankAccounts.find((a) => a.isCash)?.id ?? cashBankAccounts[0]?.id ?? '',
  );
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const amountPaisa = parseTakaToPaisa(amount);
    if (amountPaisa === null || amountPaisa <= 0) return setError('Enter a valid amount');
    if (!expenseAccountId) return setError('Pick an expense account');
    setBusy(true);
    try {
      await api.post('/api/expenses', {
        expenseAccountId,
        amountPaisa,
        spentDate,
        ...(paidFromAccountId ? { paidFromAccountId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save expense');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="New Expense">
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label>Expense account</Label>
          <Select value={expenseAccountId} onChange={(e) => setExpenseAccountId(e.target.value)} autoFocus>
            {expenseAccounts.map((a) => (
              <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Amount (৳)</Label>
            <Input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Date</Label>
            <Input type="date" value={spentDate} onChange={(e) => setSpentDate(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Paid from</Label>
          <Select value={paidFromAccountId} onChange={(e) => setPaidFromAccountId(e.target.value)}>
            {cashBankAccounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Note</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" />
        </div>
        {error && <ErrorNote message={error} />}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save expense'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
