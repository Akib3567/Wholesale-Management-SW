import { useState } from 'react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { formatPaisa } from '../../lib/money';
import { downloadCsv } from '../../lib/csv';
import { AsOfNote, PrintTitle, ReportHeader, ScopePicker, type AsOfBranch } from '../../components/report';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Select } from '../../components/ui/select';
import { ErrorNote, Spinner } from '../../components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '../../components/ui/table';

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  parentId: string | null;
}
interface LedgerRow {
  date: string;
  entryId: string;
  branchCode: string;
  refType: string;
  narration: string;
  partyName: string | null;
  debitPaisa: number;
  creditPaisa: number;
  balancePaisa: number;
}
interface LedgerData {
  scope: string;
  asOf: AsOfBranch[];
  account: { code: string; name: string };
  openingPaisa: number;
  closingPaisa: number;
  rows: LedgerRow[];
}

function firstOfMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('en-CA');
}
const today = () => new Date().toLocaleDateString('en-CA');

export function LedgerPage() {
  const accountsRes = useApi(() => api.get<{ accounts: Account[] }>('/api/accounts'), []);
  const [accountId, setAccountId] = useState('ACC-1010');
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [scope, setScope] = useState('THIS');
  const { data, error, loading } = useApi(
    () =>
      api.get<LedgerData>(
        `/api/accounting/ledger?accountId=${encodeURIComponent(accountId)}&from=${from}&to=${to}&scope=${scope}`,
      ),
    [accountId, from, to, scope],
  );

  function exportCsv() {
    if (!data) return;
    downloadCsv(`ledger-${data.account.code}-${from}-to-${to}.csv`, [
      ['Date', 'Branch', 'Type', 'Narration', 'Party', 'Debit', 'Credit', 'Balance'],
      ['', '', '', 'Opening balance', '', '', '', formatPaisa(data.openingPaisa)],
      ...data.rows.map((r) => [
        r.date, r.branchCode, r.refType, r.narration, r.partyName ?? '',
        formatPaisa(r.debitPaisa), formatPaisa(r.creditPaisa), formatPaisa(r.balancePaisa),
      ]),
    ]);
  }

  return (
    <div className="space-y-4">
      <ReportHeader title="Ledger" onCsv={exportCsv}>
        <div className="space-y-1">
          <Label>Account</Label>
          <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-64">
            {(accountsRes.data?.accounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </Select>
        </div>
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
      </ReportHeader>
      <PrintTitle>
        Ledger: {data?.account.code} {data?.account.name} — {from} to {to}
      </PrintTitle>
      {data && <AsOfNote asOf={data.asOf} />}
      {error && <ErrorNote message={error} />}
      {loading && !data ? (
        <Spinner />
      ) : (
        data && (
          <Table>
            <THead>
              <TR>
                <TH>Date</TH><TH>Branch</TH><TH>Narration</TH><TH>Party</TH>
                <TH className="text-right">Debit</TH>
                <TH className="text-right">Credit</TH>
                <TH className="text-right">Balance</TH>
              </TR>
            </THead>
            <TBody>
              <TR className="bg-muted/40 font-medium">
                <TD colSpan={6}>Opening balance</TD>
                <TD className="text-right tabular-nums">{formatPaisa(data.openingPaisa)}</TD>
              </TR>
              {data.rows.map((r, i) => (
                <TR key={`${r.entryId}-${i}`}>
                  <TD>{r.date}</TD>
                  <TD>{r.branchCode}</TD>
                  <TD>{r.narration}</TD>
                  <TD>{r.partyName ?? ''}</TD>
                  <TD className="text-right tabular-nums">{r.debitPaisa ? formatPaisa(r.debitPaisa) : ''}</TD>
                  <TD className="text-right tabular-nums">{r.creditPaisa ? formatPaisa(r.creditPaisa) : ''}</TD>
                  <TD className="text-right tabular-nums">{formatPaisa(r.balancePaisa)}</TD>
                </TR>
              ))}
              <TR className="bg-muted/40 font-semibold">
                <TD colSpan={6}>Closing balance</TD>
                <TD className="text-right tabular-nums">{formatPaisa(data.closingPaisa)}</TD>
              </TR>
            </TBody>
          </Table>
        )
      )}
    </div>
  );
}
