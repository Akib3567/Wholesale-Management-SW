import { useState } from 'react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { formatPaisa } from '../../lib/money';
import { downloadCsv } from '../../lib/csv';
import { AsOfNote, PrintTitle, ReportHeader, ScopePicker, type AsOfBranch } from '../../components/report';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { ErrorNote, Spinner } from '../../components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '../../components/ui/table';

interface TbAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  debitBalancePaisa: number;
  creditBalancePaisa: number;
}
interface TbData {
  scope: string;
  asOfDate: string;
  asOf: AsOfBranch[];
  accounts: TbAccount[];
  totalDebitPaisa: number;
  totalCreditPaisa: number;
  balanced: boolean;
}

const today = () => new Date().toLocaleDateString('en-CA');

export function TrialBalancePage() {
  const [asOf, setAsOf] = useState(today());
  const [scope, setScope] = useState('THIS');
  const { data, error, loading } = useApi(
    () => api.get<TbData>(`/api/accounting/trial-balance?asOf=${asOf}&scope=${scope}`),
    [asOf, scope],
  );

  function exportCsv() {
    if (!data) return;
    downloadCsv(`trial-balance-${asOf}.csv`, [
      ['Code', 'Account', 'Type', 'Debit', 'Credit'],
      ...data.accounts.map((a) => [
        a.code, a.name, a.type,
        a.debitBalancePaisa ? formatPaisa(a.debitBalancePaisa) : '',
        a.creditBalancePaisa ? formatPaisa(a.creditBalancePaisa) : '',
      ]),
      ['', 'TOTAL', '', formatPaisa(data.totalDebitPaisa), formatPaisa(data.totalCreditPaisa)],
    ]);
  }

  return (
    <div className="space-y-4">
      <ReportHeader title="Trial Balance" onCsv={exportCsv}>
        <div className="space-y-1">
          <Label>As of</Label>
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label>Scope</Label>
          <ScopePicker value={scope} onChange={setScope} />
        </div>
      </ReportHeader>
      <PrintTitle>Trial Balance as of {asOf}</PrintTitle>
      {data && <AsOfNote asOf={data.asOf} />}
      {error && <ErrorNote message={error} />}
      {loading && !data ? (
        <Spinner />
      ) : (
        data && (
          <>
            <div>
              {data.balanced ? (
                <Badge variant="success">Balanced — Σ debit = Σ credit</Badge>
              ) : (
                <Badge variant="destructive">NOT BALANCED — investigate immediately</Badge>
              )}
            </div>
            <Table>
              <THead>
                <TR>
                  <TH>Code</TH><TH>Account</TH><TH>Type</TH>
                  <TH className="text-right">Debit</TH>
                  <TH className="text-right">Credit</TH>
                </TR>
              </THead>
              <TBody>
                {data.accounts.map((a) => (
                  <TR key={a.id}>
                    <TD>{a.code}</TD>
                    <TD>{a.name}</TD>
                    <TD className="text-muted-foreground">{a.type}</TD>
                    <TD className="text-right tabular-nums">
                      {a.debitBalancePaisa ? formatPaisa(a.debitBalancePaisa) : ''}
                    </TD>
                    <TD className="text-right tabular-nums">
                      {a.creditBalancePaisa ? formatPaisa(a.creditBalancePaisa) : ''}
                    </TD>
                  </TR>
                ))}
                <TR className="bg-muted/50 font-semibold">
                  <TD colSpan={3}>TOTAL</TD>
                  <TD className="text-right tabular-nums">{formatPaisa(data.totalDebitPaisa)}</TD>
                  <TD className="text-right tabular-nums">{formatPaisa(data.totalCreditPaisa)}</TD>
                </TR>
              </TBody>
            </Table>
          </>
        )
      )}
    </div>
  );
}
