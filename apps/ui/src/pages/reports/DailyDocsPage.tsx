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

interface DocRow {
  id: string;
  docNo: string;
  branchCode: string;
  partyName: string | null;
  subtotalPaisa: number;
  discountPaisa: number;
  totalPaisa: number;
  paidPaisa: number;
  duePaisa: number;
}
interface DailyData {
  scope: string;
  asOf: AsOfBranch[];
  date: string;
  rows: DocRow[];
  totals: { count: number; totalPaisa: number; paidPaisa: number; duePaisa: number };
}

const today = () => new Date().toLocaleDateString('en-CA');

/** Daily Sales and Daily Purchase share everything except endpoint and labels. */
export function DailyDocsPage({ kind }: { kind: 'sales' | 'purchases' }) {
  const isSales = kind === 'sales';
  const title = isSales ? 'Daily Sales' : 'Daily Purchase';
  const partyLabel = isSales ? 'Customer' : 'Supplier';
  const [date, setDate] = useState(today());
  const [scope, setScope] = useState('THIS');
  const { data, error, loading } = useApi(
    () => api.get<DailyData>(`/api/reports/daily-${kind}?date=${date}&scope=${scope}`),
    [kind, date, scope],
  );

  function exportCsv() {
    if (!data) return;
    downloadCsv(`daily-${kind}-${date}.csv`, [
      ['Doc No', 'Branch', partyLabel, 'Subtotal', 'Discount', 'Total', 'Paid', 'Due'],
      ...data.rows.map((r) => [
        r.docNo, r.branchCode, r.partyName ?? 'Walk-in',
        formatPaisa(r.subtotalPaisa), formatPaisa(r.discountPaisa), formatPaisa(r.totalPaisa),
        formatPaisa(r.paidPaisa), formatPaisa(r.duePaisa),
      ]),
      ['', '', 'TOTAL', '', '', formatPaisa(data.totals.totalPaisa), formatPaisa(data.totals.paidPaisa), formatPaisa(data.totals.duePaisa)],
    ]);
  }

  return (
    <div className="space-y-4">
      <ReportHeader title={title} onCsv={exportCsv}>
        <div className="space-y-1">
          <Label>Date</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label>Scope</Label>
          <ScopePicker value={scope} onChange={setScope} />
        </div>
      </ReportHeader>
      <PrintTitle>{title} — {date}</PrintTitle>
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
                  ['Documents', String(data.totals.count)],
                  ['Total', formatPaisa(data.totals.totalPaisa)],
                  [isSales ? 'Received' : 'Paid', formatPaisa(data.totals.paidPaisa)],
                  ['Due', formatPaisa(data.totals.duePaisa)],
                ] as const
              ).map(([label, v]) => (
                <Card key={label}>
                  <CardContent className="p-3">
                    <div className="text-xs text-muted-foreground">{label}</div>
                    <div className="text-lg font-bold tabular-nums">{v}</div>
                  </CardContent>
                </Card>
              ))}
            </div>
            <Table>
              <THead>
                <TR>
                  <TH>Doc No</TH><TH>Branch</TH><TH>{partyLabel}</TH>
                  <TH className="text-right">Total</TH>
                  <TH className="text-right">{isSales ? 'Received' : 'Paid'}</TH>
                  <TH className="text-right">Due</TH>
                </TR>
              </THead>
              <TBody>
                {data.rows.length === 0 && (
                  <TR><TD colSpan={6} className="py-8 text-center text-muted-foreground">Nothing on this date.</TD></TR>
                )}
                {data.rows.map((r) => (
                  <TR key={r.id}>
                    <TD className="font-medium">{r.docNo}</TD>
                    <TD>{r.branchCode}</TD>
                    <TD>{r.partyName ?? 'Walk-in'}</TD>
                    <TD className="text-right tabular-nums">{formatPaisa(r.totalPaisa)}</TD>
                    <TD className="text-right tabular-nums">{formatPaisa(r.paidPaisa)}</TD>
                    <TD className="text-right tabular-nums">{formatPaisa(r.duePaisa)}</TD>
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
