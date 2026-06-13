import { Fragment, useState } from 'react';
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

interface JournalLine {
  lineNo: number;
  accountCode: string;
  accountName: string;
  partyName: string | null;
  debitPaisa: number;
  creditPaisa: number;
  lineNote: string | null;
}
interface JournalEntry {
  id: string;
  date: string;
  narration: string;
  refType: string;
  branchCode: string;
  isReversed: boolean;
  lines: JournalLine[];
}
interface JournalData {
  scope: string;
  asOf: AsOfBranch[];
  entries: JournalEntry[];
}

function firstOfMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('en-CA');
}
const today = () => new Date().toLocaleDateString('en-CA');

export function JournalPage() {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [scope, setScope] = useState('THIS');
  const { data, error, loading } = useApi(
    () => api.get<JournalData>(`/api/accounting/journal?from=${from}&to=${to}&scope=${scope}`),
    [from, to, scope],
  );

  function exportCsv() {
    if (!data) return;
    const rows: Array<Array<string | number>> = [
      ['Date', 'Entry', 'Branch', 'Type', 'Account', 'Party', 'Debit', 'Credit'],
    ];
    for (const e of data.entries) {
      for (const l of e.lines) {
        rows.push([
          e.date, e.narration, e.branchCode, e.refType,
          `${l.accountCode} ${l.accountName}`, l.partyName ?? '',
          formatPaisa(l.debitPaisa), formatPaisa(l.creditPaisa),
        ]);
      }
    }
    downloadCsv(`journal-${from}-to-${to}.csv`, rows);
  }

  return (
    <div className="space-y-4">
      <ReportHeader title="Journal" onCsv={exportCsv}>
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
      <PrintTitle>Journal — {from} to {to}</PrintTitle>
      {data && <AsOfNote asOf={data.asOf} />}
      {error && <ErrorNote message={error} />}
      {loading && !data ? (
        <Spinner />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Date / Narration</TH>
              <TH>Account</TH>
              <TH>Party</TH>
              <TH className="text-right">Debit</TH>
              <TH className="text-right">Credit</TH>
            </TR>
          </THead>
          <TBody>
            {data?.entries.length === 0 && (
              <TR><TD colSpan={5} className="py-8 text-center text-muted-foreground">No entries in range.</TD></TR>
            )}
            {data?.entries.map((e) => (
              <Fragment key={e.id}>
                <TR className="bg-muted/50">
                  <TD colSpan={5} className="py-1.5">
                    <span className="font-medium">{e.date}</span>
                    <span className="mx-2 text-muted-foreground">{e.narration}</span>
                    <Badge variant="outline">{e.refType}</Badge>{' '}
                    <Badge variant="secondary">{e.branchCode}</Badge>
                    {e.isReversed && <Badge variant="destructive" className="ml-1">reversed</Badge>}
                  </TD>
                </TR>
                {e.lines.map((l) => (
                  <TR key={`${e.id}-${l.lineNo}`}>
                    <TD />
                    <TD>{l.accountCode} — {l.accountName}</TD>
                    <TD>{l.partyName ?? ''}</TD>
                    <TD className="text-right tabular-nums">{l.debitPaisa ? formatPaisa(l.debitPaisa) : ''}</TD>
                    <TD className="text-right tabular-nums">{l.creditPaisa ? formatPaisa(l.creditPaisa) : ''}</TD>
                  </TR>
                ))}
              </Fragment>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
