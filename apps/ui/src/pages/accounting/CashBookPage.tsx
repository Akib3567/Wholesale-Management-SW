import { useState } from 'react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { formatPaisa } from '../../lib/money';
import { downloadCsv } from '../../lib/csv';
import { AsOfNote, PrintTitle, ReportHeader, ScopePicker, type AsOfBranch } from '../../components/report';
import { Card, CardContent } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { ErrorNote, Spinner } from '../../components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '../../components/ui/table';

interface BookRow {
  date: string;
  entryId: string;
  branchCode: string;
  refType: string;
  narration: string;
  accountName: string;
  partyName: string | null;
  debitPaisa: number;
  creditPaisa: number;
  balancePaisa: number;
}
interface BookData {
  scope: string;
  asOf: AsOfBranch[];
  kind: 'cash' | 'bank';
  openingPaisa: number;
  closingPaisa: number;
  totalInPaisa: number;
  totalOutPaisa: number;
  rows: BookRow[];
}

function firstOfMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('en-CA');
}
const today = () => new Date().toLocaleDateString('en-CA');

/** Cash Book and Bank Book share everything except the account flag. */
export function CashBookPage({ kind }: { kind: 'cash' | 'bank' }) {
  const title = kind === 'cash' ? 'Cash Book' : 'Bank Book';
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [scope, setScope] = useState('THIS');
  const { data, error, loading } = useApi(
    () => api.get<BookData>(`/api/accounting/cash-book?from=${from}&to=${to}&scope=${scope}&kind=${kind}`),
    [from, to, scope, kind],
  );

  function exportCsv() {
    if (!data) return;
    downloadCsv(`${kind}-book-${from}-to-${to}.csv`, [
      ['Date', 'Branch', 'Type', 'Narration', 'Party', 'In', 'Out', 'Balance'],
      ['', '', '', 'Opening', '', '', '', formatPaisa(data.openingPaisa)],
      ...data.rows.map((r) => [
        r.date, r.branchCode, r.refType, r.narration, r.partyName ?? '',
        formatPaisa(r.debitPaisa), formatPaisa(r.creditPaisa), formatPaisa(r.balancePaisa),
      ]),
    ]);
  }

  return (
    <div className="space-y-4">
      <ReportHeader title={title} onCsv={exportCsv}>
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
      <PrintTitle>{title} — {from} to {to}</PrintTitle>
      {data && <AsOfNote asOf={data.asOf} />}
      {error && <ErrorNote message={error} />}
      {loading && !data ? (
        <Spinner />
      ) : (
        data && (
          <>
            <div className="grid grid-cols-4 gap-3">
              {(
                [
                  ['Opening', data.openingPaisa],
                  ['Total In', data.totalInPaisa],
                  ['Total Out', data.totalOutPaisa],
                  ['Closing', data.closingPaisa],
                ] as const
              ).map(([label, v]) => (
                <Card key={label}>
                  <CardContent className="p-3">
                    <div className="text-xs text-muted-foreground">{label}</div>
                    <div className="text-lg font-bold tabular-nums">{formatPaisa(v)}</div>
                  </CardContent>
                </Card>
              ))}
            </div>
            <Table>
              <THead>
                <TR>
                  <TH>Date</TH><TH>Branch</TH><TH>Narration</TH><TH>Party</TH>
                  <TH className="text-right">In</TH>
                  <TH className="text-right">Out</TH>
                  <TH className="text-right">Balance</TH>
                </TR>
              </THead>
              <TBody>
                {data.rows.length === 0 && (
                  <TR><TD colSpan={7} className="py-8 text-center text-muted-foreground">No movements in range.</TD></TR>
                )}
                {data.rows.map((r, i) => (
                  <TR key={`${r.entryId}-${i}`}>
                    <TD>{r.date}</TD>
                    <TD>{r.branchCode}</TD>
                    <TD>{r.narration}</TD>
                    <TD>{r.partyName ?? ''}</TD>
                    <TD className="text-right tabular-nums text-emerald-700">
                      {r.debitPaisa ? formatPaisa(r.debitPaisa) : ''}
                    </TD>
                    <TD className="text-right tabular-nums text-red-700">
                      {r.creditPaisa ? formatPaisa(r.creditPaisa) : ''}
                    </TD>
                    <TD className="text-right font-medium tabular-nums">{formatPaisa(r.balancePaisa)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </>
        )
      )}
    </div>
  );
}
