import { useState } from 'react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { formatPaisa } from '../../lib/money';
import { downloadCsv } from '../../lib/csv';
import { AsOfNote, PrintTitle, ReportHeader, ScopePicker, type AsOfBranch } from '../../components/report';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { ErrorNote, Spinner } from '../../components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '../../components/ui/table';

interface PnlLine {
  id: string;
  code: string;
  name: string;
  amountPaisa: number;
}
interface PnlData {
  scope: string;
  asOf: AsOfBranch[];
  from: string;
  to: string;
  income: PnlLine[];
  cogsPaisa: number;
  grossProfitPaisa: number;
  operatingExpenses: PnlLine[];
  expensesPaisa: number;
  netProfitPaisa: number;
}

function firstOfMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('en-CA');
}
const today = () => new Date().toLocaleDateString('en-CA');

export function PnlPage() {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [scope, setScope] = useState('THIS');
  const { data, error, loading } = useApi(
    () => api.get<PnlData>(`/api/reports/pnl?from=${from}&to=${to}&scope=${scope}`),
    [from, to, scope],
  );

  function exportCsv() {
    if (!data) return;
    const revenue = data.income.reduce((s, r) => s + r.amountPaisa, 0);
    downloadCsv(`pnl-${from}-to-${to}.csv`, [
      ['Section', 'Account', 'Amount'],
      ...data.income.map((r) => ['Income', `${r.code} ${r.name}`, formatPaisa(r.amountPaisa)]),
      ['', 'Total Revenue', formatPaisa(revenue)],
      ['', 'Cost of Goods Sold', formatPaisa(data.cogsPaisa)],
      ['', 'Gross Profit', formatPaisa(data.grossProfitPaisa)],
      ...data.operatingExpenses.map((r) => ['Expense', `${r.code} ${r.name}`, formatPaisa(r.amountPaisa)]),
      ['', 'Total Expenses', formatPaisa(data.expensesPaisa)],
      ['', 'Net Profit', formatPaisa(data.netProfitPaisa)],
    ]);
  }

  const revenue = data ? data.income.reduce((s, r) => s + r.amountPaisa, 0) : 0;

  return (
    <div className="space-y-4">
      <ReportHeader title="Profit & Loss" onCsv={exportCsv}>
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
      <PrintTitle>Profit &amp; Loss — {from} to {to}</PrintTitle>
      {data && <AsOfNote asOf={data.asOf} />}
      {error && <ErrorNote message={error} />}
      {loading && !data ? (
        <Spinner />
      ) : (
        data && (
          <div className="max-w-2xl">
            <Table>
              <THead>
                <TR>
                  <TH>Account</TH>
                  <TH className="text-right">Amount</TH>
                </TR>
              </THead>
              <TBody>
                <TR className="bg-muted/50 font-semibold"><TD colSpan={2}>Income</TD></TR>
                {data.income.map((r) => (
                  <TR key={r.id}>
                    <TD className="pl-6">{r.code} — {r.name}</TD>
                    <TD className="text-right tabular-nums">{formatPaisa(r.amountPaisa)}</TD>
                  </TR>
                ))}
                <TR className="font-medium">
                  <TD>Total Revenue</TD>
                  <TD className="text-right tabular-nums">{formatPaisa(revenue)}</TD>
                </TR>
                <TR>
                  <TD>Less: Cost of Goods Sold</TD>
                  <TD className="text-right tabular-nums">({formatPaisa(data.cogsPaisa)})</TD>
                </TR>
                <TR className="border-t-2 font-semibold">
                  <TD>Gross Profit</TD>
                  <TD className="text-right tabular-nums">{formatPaisa(data.grossProfitPaisa)}</TD>
                </TR>
                <TR className="bg-muted/50 font-semibold"><TD colSpan={2}>Operating Expenses</TD></TR>
                {data.operatingExpenses.length === 0 && (
                  <TR><TD colSpan={2} className="pl-6 text-muted-foreground">None</TD></TR>
                )}
                {data.operatingExpenses.map((r) => (
                  <TR key={r.id}>
                    <TD className="pl-6">{r.code} — {r.name}</TD>
                    <TD className="text-right tabular-nums">{formatPaisa(r.amountPaisa)}</TD>
                  </TR>
                ))}
                <TR className="font-medium">
                  <TD>Total Expenses</TD>
                  <TD className="text-right tabular-nums">({formatPaisa(data.expensesPaisa)})</TD>
                </TR>
                <TR className="border-t-2 text-base font-bold">
                  <TD>Net Profit</TD>
                  <TD className={`text-right tabular-nums ${data.netProfitPaisa < 0 ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-400'}`}>
                    {formatPaisa(data.netProfitPaisa)}
                  </TD>
                </TR>
              </TBody>
            </Table>
          </div>
        )
      )}
    </div>
  );
}
