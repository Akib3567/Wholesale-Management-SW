import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { formatPaisa } from '../lib/money';
import { AsOfNote, PrintTitle, ReportHeader, ScopePicker, type AsOfBranch } from '../components/report';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { ErrorNote, Spinner } from '../components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/table';

interface DocLine { id: string; docNo: string; branchCode: string; partyName: string | null; totalPaisa: number; paidPaisa: number }
interface ExpenseLine { id: string; accountName: string; amountPaisa: number; note: string | null; branchCode: string }
interface PaymentLine { id: string; direction: 'in' | 'out'; amountPaisa: number; method: string; partyName: string | null; branchCode: string }
interface DailyData {
  scope: string;
  asOf: AsOfBranch[];
  date: string;
  openingCashPaisa: number;
  closingCashPaisa: number;
  sales: DocLine[];
  purchases: DocLine[];
  expenses: ExpenseLine[];
  payments: PaymentLine[];
  totals: { salesPaisa: number; purchasesPaisa: number; expensesPaisa: number };
}

const today = () => new Date().toLocaleDateString('en-CA');

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="border-b bg-muted/40 px-4 py-2 text-sm font-semibold">{title}</div>
        {children}
      </CardContent>
    </Card>
  );
}

export function DailyPage() {
  const [date, setDate] = useState(today());
  const [scope, setScope] = useState('THIS');
  const { data, error, loading } = useApi(
    () => api.get<DailyData>(`/api/reports/daily?date=${date}&scope=${scope}`),
    [date, scope],
  );

  return (
    <div className="space-y-4">
      <ReportHeader title="Daily Day-View">
        <div className="space-y-1">
          <Label>Date</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label>Scope</Label>
          <ScopePicker value={scope} onChange={setScope} />
        </div>
      </ReportHeader>
      <PrintTitle>Daily Day-View — {date}</PrintTitle>
      {data && <AsOfNote asOf={data.asOf} />}
      {error && <ErrorNote message={error} />}
      {loading && !data ? (
        <Spinner />
      ) : (
        data && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              {(
                [
                  ['Opening cash (B/F)', data.openingCashPaisa],
                  ['Sales', data.totals.salesPaisa],
                  ['Purchases', data.totals.purchasesPaisa],
                  ['Expenses', data.totals.expensesPaisa],
                  ['Closing cash', data.closingCashPaisa],
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

            <Section title={`Sales (${data.sales.length})`}>
              <Table>
                <THead><TR><TH>Doc</TH><TH>Branch</TH><TH>Customer</TH><TH className="text-right">Total</TH><TH className="text-right">Received</TH></TR></THead>
                <TBody>
                  {data.sales.length === 0 && <TR><TD colSpan={5} className="py-4 text-center text-muted-foreground">None</TD></TR>}
                  {data.sales.map((r) => (
                    <TR key={r.id}>
                      <TD className="font-medium">{r.docNo}</TD><TD>{r.branchCode}</TD><TD>{r.partyName ?? 'Walk-in'}</TD>
                      <TD className="text-right tabular-nums">{formatPaisa(r.totalPaisa)}</TD>
                      <TD className="text-right tabular-nums">{formatPaisa(r.paidPaisa)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Section>

            <Section title={`Purchases (${data.purchases.length})`}>
              <Table>
                <THead><TR><TH>Doc</TH><TH>Branch</TH><TH>Supplier</TH><TH className="text-right">Total</TH><TH className="text-right">Paid</TH></TR></THead>
                <TBody>
                  {data.purchases.length === 0 && <TR><TD colSpan={5} className="py-4 text-center text-muted-foreground">None</TD></TR>}
                  {data.purchases.map((r) => (
                    <TR key={r.id}>
                      <TD className="font-medium">{r.docNo}</TD><TD>{r.branchCode}</TD><TD>{r.partyName ?? '—'}</TD>
                      <TD className="text-right tabular-nums">{formatPaisa(r.totalPaisa)}</TD>
                      <TD className="text-right tabular-nums">{formatPaisa(r.paidPaisa)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Section>

            <div className="grid gap-4 lg:grid-cols-2">
              <Section title={`Expenses (${data.expenses.length})`}>
                <Table>
                  <THead><TR><TH>Account</TH><TH>Note</TH><TH className="text-right">Amount</TH></TR></THead>
                  <TBody>
                    {data.expenses.length === 0 && <TR><TD colSpan={3} className="py-4 text-center text-muted-foreground">None</TD></TR>}
                    {data.expenses.map((r) => (
                      <TR key={r.id}>
                        <TD>{r.accountName}</TD><TD className="text-muted-foreground">{r.note ?? ''}</TD>
                        <TD className="text-right tabular-nums">{formatPaisa(r.amountPaisa)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </Section>

              <Section title={`Payments / Receipts (${data.payments.length})`}>
                <Table>
                  <THead><TR><TH>Party</TH><TH>Direction</TH><TH>Method</TH><TH className="text-right">Amount</TH></TR></THead>
                  <TBody>
                    {data.payments.length === 0 && <TR><TD colSpan={4} className="py-4 text-center text-muted-foreground">None</TD></TR>}
                    {data.payments.map((r) => (
                      <TR key={r.id}>
                        <TD>{r.partyName ?? '—'}</TD>
                        <TD>{r.direction === 'in' ? 'Received' : 'Paid'}</TD>
                        <TD>{r.method}</TD>
                        <TD className="text-right tabular-nums">{formatPaisa(r.amountPaisa)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </Section>
            </div>
          </>
        )
      )}
    </div>
  );
}
