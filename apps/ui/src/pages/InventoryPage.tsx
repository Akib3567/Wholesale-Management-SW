import { useState, type FormEvent } from 'react';
import { api, ApiError, type InventoryData, type StockRow } from '../lib/api';
import { useApi } from '../lib/useApi';
import { formatPaisa, formatQtyMilli, parseQtyToMilli, parseTakaToPaisa } from '../lib/money';
import { downloadCsv } from '../lib/csv';
import { useAuth } from '../auth/AuthContext';
import { AsOfNote, PrintTitle, ReportHeader, ScopePicker } from '../components/report';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { ErrorNote, Spinner } from '../components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/table';

export function InventoryPage() {
  const { install, hasRole } = useAuth();
  const [scope, setScope] = useState('THIS');
  const inv = useApi(() => api.get<InventoryData>(`/api/inventory?scope=${scope}`), [scope]);
  const [lowOnly, setLowOnly] = useState(false);
  const [adjust, setAdjust] = useState<StockRow | null>(null);

  const rows = (inv.data?.rows ?? []).filter((r) => !lowOnly || r.isLow);
  // Adjustments only make sense for this branch's own stock.
  const ownBranch = scope === 'THIS' || scope === install?.branchCode;

  function exportCsv() {
    if (!inv.data) return;
    downloadCsv(`inventory-${inv.data.branch}.csv`, [
      ['Product', 'SKU', 'Unit', 'On hand', 'Avg cost', 'Value', 'Reorder level', 'Low?'],
      ...inv.data.rows.map((r) => [
        r.name, r.sku ?? '', r.unit, formatQtyMilli(r.qtyOnHandMilli),
        formatPaisa(r.avgCostPaisa), formatPaisa(r.valuePaisa),
        r.reorderLevelMilli ? formatQtyMilli(r.reorderLevelMilli) : '', r.isLow ? 'LOW' : '',
      ]),
      ['', '', '', '', '', formatPaisa(inv.data.totalValuePaisa), '', ''],
    ]);
  }

  return (
    <div className="space-y-4">
      <ReportHeader title="Inventory" onCsv={exportCsv}>
        <div className="space-y-1">
          <Label>Scope</Label>
          <ScopePicker value={scope} onChange={setScope} />
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
          Low stock only
        </label>
      </ReportHeader>
      <PrintTitle>Stock on hand &amp; valuation — {inv.data?.branch}</PrintTitle>
      {inv.data && <AsOfNote asOf={[]} />}
      {!ownBranch && (
        <p className="text-xs text-muted-foreground">
          Viewing another branch's stock (read-only). Adjustments are only allowed for{' '}
          {install?.branchCode}.
        </p>
      )}

      {inv.error && <ErrorNote message={inv.error} />}
      {inv.loading && !inv.data ? (
        <Spinner />
      ) : (
        inv.data && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Card>
                <CardContent className="p-3">
                  <div className="text-xs text-muted-foreground">Total valuation</div>
                  <div className="text-lg font-bold tabular-nums">{formatPaisa(inv.data.totalValuePaisa)}</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3">
                  <div className="text-xs text-muted-foreground">Products</div>
                  <div className="text-lg font-bold tabular-nums">{inv.data.rows.length}</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3">
                  <div className="text-xs text-muted-foreground">Low stock</div>
                  <div className={`text-lg font-bold tabular-nums ${inv.data.lowStockCount ? 'text-destructive' : ''}`}>
                    {inv.data.lowStockCount}
                  </div>
                </CardContent>
              </Card>
            </div>

            <Table>
              <THead>
                <TR>
                  <TH>Product</TH><TH>Unit</TH>
                  <TH className="text-right">On hand</TH>
                  <TH className="text-right">Avg cost</TH>
                  <TH className="text-right">Value</TH>
                  <TH className="text-right">Reorder</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {rows.length === 0 && (
                  <TR><TD colSpan={7} className="py-8 text-center text-muted-foreground">No products.</TD></TR>
                )}
                {rows.map((r) => (
                  <TR key={r.productId} className={r.isLow ? 'bg-destructive/5' : ''}>
                    <TD className="font-medium">
                      {r.name}
                      {r.isProvisional && <Badge variant="outline" className="ml-2">provisional</Badge>}
                      {r.isLow && <Badge variant="destructive" className="ml-2">low</Badge>}
                    </TD>
                    <TD>{r.unit}</TD>
                    <TD className="text-right tabular-nums">{formatQtyMilli(r.qtyOnHandMilli)}</TD>
                    <TD className="text-right tabular-nums">{formatPaisa(r.avgCostPaisa)}</TD>
                    <TD className="text-right tabular-nums">{formatPaisa(r.valuePaisa)}</TD>
                    <TD className="text-right tabular-nums">
                      {r.reorderLevelMilli ? formatQtyMilli(r.reorderLevelMilli) : '—'}
                    </TD>
                    <TD className="text-right">
                      {ownBranch && hasRole('operator') && (
                        <Button variant="ghost" size="sm" onClick={() => setAdjust(r)}>
                          Adjust
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </>
        )
      )}

      {adjust && (
        <AdjustDialog
          row={adjust}
          onClose={() => setAdjust(null)}
          onDone={() => {
            setAdjust(null);
            inv.reload();
          }}
        />
      )}
    </div>
  );
}

function AdjustDialog({
  row,
  onClose,
  onDone,
}: {
  row: StockRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [counted, setCounted] = useState(formatQtyMilli(row.qtyOnHandMilli));
  const [cost, setCost] = useState(formatPaisa(row.avgCostPaisa));
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const countedMilli = parseQtyToMilli(counted === '0' ? '0.001' : counted) ?? null;
  // parseQtyToMilli rejects 0; handle the "counted to zero" case explicitly
  const countedValue = counted.trim() === '0' ? 0 : countedMilli;
  const delta = countedValue !== null ? countedValue - row.qtyOnHandMilli : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (countedValue === null) return setError('Enter a valid counted quantity (max 3 decimals)');
    if (delta === 0) return setError('Counted quantity equals current stock — nothing to adjust');
    const body: Record<string, unknown> = { productId: row.productId, countedQtyMilli: countedValue };
    if (note.trim()) body['note'] = note.trim();
    if (delta !== null && delta > 0) {
      const costPaisa = parseTakaToPaisa(cost);
      if (costPaisa === null || costPaisa < 0) return setError('Enter a valid unit cost for the increase');
      body['unitCostPaisa'] = costPaisa;
    }
    setBusy(true);
    try {
      await api.post('/api/inventory/adjust', body);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Adjustment failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={`Adjust stock — ${row.name}`}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="text-sm text-muted-foreground">
          Current on hand: <strong>{formatQtyMilli(row.qtyOnHandMilli)} {row.unit}</strong>
        </div>
        <div className="space-y-1.5">
          <Label>Counted quantity ({row.unit})</Label>
          <Input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus />
        </div>
        {delta !== null && delta > 0 && (
          <div className="space-y-1.5">
            <Label>Unit cost for the +{formatQtyMilli(delta)} increase (৳)</Label>
            <Input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
          </div>
        )}
        {delta !== null && delta !== 0 && (
          <div className="rounded-md bg-muted px-3 py-2 text-sm">
            Adjustment: <strong>{delta > 0 ? '+' : ''}{formatQtyMilli(delta)} {row.unit}</strong>{' '}
            ({delta > 0 ? 'increase / found' : 'decrease / loss'})
          </div>
        )}
        <div className="space-y-1.5">
          <Label>Reason</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. stock-take, damaged" />
        </div>
        {error && <ErrorNote message={error} />}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Posting…' : 'Post adjustment'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
