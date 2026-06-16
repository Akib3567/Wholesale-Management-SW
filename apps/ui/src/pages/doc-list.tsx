import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, type Party, type TradeDoc } from '../lib/api';
import { useApi } from '../lib/useApi';
import { formatPaisa } from '../lib/money';
import { useAuth } from '../auth/AuthContext';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { ErrorNote, Spinner } from '../components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/table';

function firstOfMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('en-CA');
}
function todayLocal(): string {
  return new Date().toLocaleDateString('en-CA');
}

/** Shared list screen for purchases and sales — they mirror each other. */
export function DocListPage({
  kind,
  title,
  partyLabel,
}: {
  kind: 'purchases' | 'sales';
  title: string;
  partyLabel: string;
}) {
  const { install, hasRole } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const flash = (location.state as { flash?: string } | null)?.flash;
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(todayLocal());

  const docs = useApi(
    () => api.get<Record<string, TradeDoc[]>>(`/api/${kind}?from=${from}&to=${to}`),
    [kind, from, to],
  );
  const partiesRes = useApi(() => api.get<{ parties: Party[] }>('/api/parties?includeInactive=true'), []);

  const partyName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of partiesRes.data?.parties ?? []) map.set(p.id, p.name);
    return (id: string | null) => (id ? (map.get(id) ?? '…') : 'Walk-in');
  }, [partiesRes.data]);

  const rows = docs.data?.[kind] ?? [];

  async function reverse(id: string) {
    if (!window.confirm('Reverse this document? A mirror journal entry will be posted and stock restored.')) return;
    try {
      await api.post(`/api/${kind}/${id}/reverse`, {});
      docs.reload();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Reverse failed');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">{title}</h1>
        {hasRole('operator') && (
          <Button onClick={() => navigate(`/${kind}/new`)}>
            <Plus className="h-4 w-4" /> New {title.slice(0, -1)}
          </Button>
        )}
      </div>

      {flash && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200">
          {flash}
        </div>
      )}

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

      {docs.error && <ErrorNote message={docs.error} />}
      {docs.loading && !docs.data ? (
        <Spinner />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Date</TH>
              <TH>Doc No</TH>
              <TH>Branch</TH>
              <TH>{partyLabel}</TH>
              <TH className="text-right">Total</TH>
              <TH className="text-right">Paid (Porishodh)</TH>
              <TH className="text-right">Due (Baki)</TH>
              <TH>Status</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {rows.length === 0 && (
              <TR>
                <TD colSpan={9} className="py-8 text-center text-muted-foreground">
                  Nothing in this date range.
                </TD>
              </TR>
            )}
            {rows.map((d) => {
              const own = d.branchCode === install?.branchCode;
              return (
                <TR key={d.id} className={d.status === 'reversed' ? 'opacity-50' : ''}>
                  <TD>{d.docDate}</TD>
                  <TD className="font-medium">{d.docNo}</TD>
                  <TD>
                    <Badge variant={own ? 'secondary' : 'outline'}>
                      {d.branchCode}
                      {!own && ' (read-only)'}
                    </Badge>
                  </TD>
                  <TD>{partyName(d.partyId)}</TD>
                  <TD className="text-right font-medium">{formatPaisa(d.totalPaisa)}</TD>
                  <TD className="text-right">{formatPaisa(d.paidPaisa)}</TD>
                  <TD className="text-right">{formatPaisa(d.totalPaisa - d.paidPaisa)}</TD>
                  <TD>
                    {d.status === 'reversed' ? (
                      <Badge variant="destructive">reversed</Badge>
                    ) : (
                      <Badge variant="success">posted</Badge>
                    )}
                  </TD>
                  <TD className="text-right">
                    {own && d.status === 'posted' && hasRole('manager') && (
                      <Button variant="ghost" size="sm" onClick={() => void reverse(d.id)}>
                        Reverse
                      </Button>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </div>
  );
}
