import { useState } from 'react';
import { api, type Party } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { formatPaisa } from '../../lib/money';
import { downloadCsv } from '../../lib/csv';
import { AsOfNote, PrintTitle, ReportHeader, ScopePicker, type AsOfBranch } from '../../components/report';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Select } from '../../components/ui/select';
import { ErrorNote, Spinner } from '../../components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '../../components/ui/table';

interface StatementRow {
  date: string;
  entryId: string;
  branchCode: string;
  refType: string;
  narration: string;
  debitPaisa: number;
  creditPaisa: number;
  balancePaisa: number;
}
interface StatementData {
  scope: string;
  asOf: AsOfBranch[];
  party: { code: string; name: string; kind: string };
  openingPaisa: number;
  closingPaisa: number;
  rows: StatementRow[];
}

function firstOfMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('en-CA');
}
const today = () => new Date().toLocaleDateString('en-CA');

/** Shows party balance as "they owe us" or "we owe them" so non-accountants read it correctly. */
function balanceLabel(paisa: number): string {
  if (paisa > 0) return `${formatPaisa(paisa)} (Due to us)`;
  if (paisa < 0) return `${formatPaisa(-paisa)} (We owe)`;
  return formatPaisa(0);
}

export function StatementPage() {
  const partiesRes = useApi(
    () => api.get<{ parties: Party[] }>('/api/parties?includeInactive=true'),
    [],
  );
  const [partyId, setPartyId] = useState('');
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [scope, setScope] = useState('ALL');

  const { data, error, loading } = useApi(
    () =>
      partyId
        ? api.get<StatementData>(
            `/api/reports/statement?partyId=${partyId}&from=${from}&to=${to}&scope=${scope}`,
          )
        : Promise.resolve(null),
    [partyId, from, to, scope],
  );

  function exportCsv() {
    if (!data) return;
    downloadCsv(`statement-${data.party.code}-${from}-to-${to}.csv`, [
      ['Date', 'Branch', 'Type', 'Narration', 'Debit', 'Credit', 'Balance'],
      ['', '', '', 'Opening', '', '', formatPaisa(data.openingPaisa)],
      ...data.rows.map((r) => [
        r.date, r.branchCode, r.refType, r.narration,
        formatPaisa(r.debitPaisa), formatPaisa(r.creditPaisa), formatPaisa(r.balancePaisa),
      ]),
    ]);
  }

  return (
    <div className="space-y-4">
      <ReportHeader title="Party Statement" onCsv={data ? exportCsv : undefined}>
        <div className="space-y-1">
          <Label>Party</Label>
          <Select value={partyId} onChange={(e) => setPartyId(e.target.value)} className="w-64">
            <option value="">— select customer / supplier —</option>
            {(partiesRes.data?.parties ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.code}) · {p.kind}
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

      {!partyId && <p className="text-sm text-muted-foreground">Select a party to view its statement.</p>}
      {data && <PrintTitle>Statement: {data.party.name} ({data.party.code}) — {from} to {to}</PrintTitle>}
      {data && <AsOfNote asOf={data.asOf} />}
      {error && <ErrorNote message={error} />}
      {loading && partyId && !data ? (
        <Spinner />
      ) : (
        data && (
          <>
            <div className="flex gap-6 text-sm">
              <div>Opening: <strong className="tabular-nums">{balanceLabel(data.openingPaisa)}</strong></div>
              <div>Closing: <strong className="tabular-nums">{balanceLabel(data.closingPaisa)}</strong></div>
            </div>
            <Table>
              <THead>
                <TR>
                  <TH>Date</TH><TH>Branch</TH><TH>Type</TH><TH>Narration</TH>
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
                    <TD>{r.refType}</TD>
                    <TD>{r.narration}</TD>
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
          </>
        )
      )}
    </div>
  );
}
