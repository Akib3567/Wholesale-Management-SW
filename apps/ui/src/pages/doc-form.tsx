import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { api, ApiError, type Party, type Product, type TradeDoc } from '../lib/api';
import { useApi } from '../lib/useApi';
import { formatPaisa, parseQtyToMilli, parseTakaToPaisa, previewLineTotal } from '../lib/money';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select } from '../components/ui/select';
import { ErrorNote } from '../components/ui/spinner';

interface LineDraft {
  productId: string;
  qty: string;
  rate: string; // taka string (unit cost for purchases, unit price for sales)
}

function todayLocal(): string {
  return new Date().toLocaleDateString('en-CA');
}

/**
 * Shared entry form for purchases and sales. All on-screen totals are
 * PREVIEWS computed with exact integer math; the server recomputes the
 * authoritative figures when it posts the document.
 */
export function DocFormPage({ kind }: { kind: 'purchases' | 'sales' }) {
  const isSale = kind === 'sales';
  const navigate = useNavigate();
  const partiesRes = useApi(
    () => api.get<{ parties: Party[] }>(`/api/parties?kind=${isSale ? 'customer' : 'supplier'}`),
    [kind],
  );
  const productsRes = useApi(() => api.get<{ products: Product[] }>('/api/products'), []);

  const [partyId, setPartyId] = useState('');
  const [walkIn, setWalkIn] = useState(false);
  const [docDate, setDocDate] = useState(todayLocal());
  const [lines, setLines] = useState<LineDraft[]>([{ productId: '', qty: '', rate: '' }]);
  const [discount, setDiscount] = useState('');
  const [paid, setPaid] = useState('');
  const [paidMethod, setPaidMethod] = useState<'cash' | 'bank'>('cash');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const products = productsRes.data?.products ?? [];
  const parties = partiesRes.data?.parties ?? [];

  const preview = useMemo(() => {
    let subtotal = 0;
    const lineTotals = lines.map((l) => {
      const qtyMilli = parseQtyToMilli(l.qty);
      const ratePaisa = parseTakaToPaisa(l.rate);
      if (qtyMilli === null || ratePaisa === null || ratePaisa < 0) return null;
      const t = previewLineTotal(ratePaisa, qtyMilli);
      subtotal += t;
      return t;
    });
    const discountPaisa = discount.trim() === '' ? 0 : parseTakaToPaisa(discount);
    const paidPaisa = paid.trim() === '' ? 0 : parseTakaToPaisa(paid);
    const total = discountPaisa !== null ? subtotal - discountPaisa : subtotal;
    return { lineTotals, subtotal, discountPaisa, paidPaisa, total, due: paidPaisa !== null ? total - paidPaisa : total };
  }, [lines, discount, paid]);

  function setLine(i: number, patch: Partial<LineDraft>) {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    const items = [];
    for (const l of lines) {
      if (!l.productId) return setError('Pick a product for every line');
      const qtyMilli = parseQtyToMilli(l.qty);
      const ratePaisa = parseTakaToPaisa(l.rate);
      if (qtyMilli === null) return setError('Quantities must be positive numbers (max 3 decimals)');
      if (ratePaisa === null || ratePaisa < 0) return setError('Rates must be valid amounts (max 2 decimals)');
      items.push(
        isSale
          ? { productId: l.productId, qtyMilli, unitPricePaisa: ratePaisa }
          : { productId: l.productId, qtyMilli, unitCostPaisa: ratePaisa },
      );
    }
    if (items.length === 0) return setError('Add at least one line');
    const discountPaisa = discount.trim() === '' ? 0 : parseTakaToPaisa(discount);
    const paidPaisa = paid.trim() === '' ? 0 : parseTakaToPaisa(paid);
    if (discountPaisa === null || discountPaisa < 0) return setError('Discount must be a valid amount');
    if (paidPaisa === null || paidPaisa < 0) return setError('Paid must be a valid amount');
    if (!isSale && !partyId) return setError('Pick a supplier');
    if (isSale && !walkIn && !partyId) return setError('Pick a customer, or mark as walk-in');

    setBusy(true);
    try {
      const body = {
        ...(isSale ? (walkIn ? {} : { partyId }) : { partyId }),
        docDate,
        items,
        discountPaisa,
        paidPaisa,
        paidMethod,
        ...(note.trim() ? { note: note.trim() } : {}),
      };
      const res = await api.post<{ purchase?: TradeDoc; sale?: TradeDoc } & Record<string, unknown>>(
        `/api/${kind}`,
        body,
      );
      const doc = (res as { purchase?: TradeDoc; sale?: TradeDoc }).purchase ?? (res as { sale?: TradeDoc }).sale;
      navigate(`/${kind}`, { state: { flash: `${isSale ? 'Sale' : 'Purchase'} ${doc?.docNo ?? ''} posted` } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to post');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h1 className="text-xl font-bold">New {isSale ? 'Sale' : 'Purchase'}</h1>
      <form onSubmit={onSubmit}>
        <Card>
          <CardContent className="space-y-5 p-5">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>{isSale ? 'Customer' : 'Supplier'}</Label>
                <Select
                  value={partyId}
                  onChange={(e) => setPartyId(e.target.value)}
                  disabled={isSale && walkIn}
                >
                  <option value="">— select —</option>
                  {parties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.code})
                    </option>
                  ))}
                </Select>
                {isSale && (
                  <label className="flex items-center gap-2 pt-1 text-sm text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={walkIn}
                      onChange={(e) => setWalkIn(e.target.checked)}
                    />
                    Walk-in customer (must be fully paid)
                  </label>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>Date</Label>
                <Input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Items</Label>
              <div className="space-y-2">
                {lines.map((l, i) => (
                  <div key={i} className="grid grid-cols-[1fr_110px_130px_110px_36px] items-center gap-2">
                    <Select value={l.productId} onChange={(e) => setLine(i, { productId: e.target.value })}>
                      <option value="">— product —</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.unit}){p.isProvisional ? ' [provisional]' : ''}
                        </option>
                      ))}
                    </Select>
                    <Input
                      placeholder="Qty"
                      inputMode="decimal"
                      value={l.qty}
                      onChange={(e) => setLine(i, { qty: e.target.value })}
                    />
                    <Input
                      placeholder={isSale ? 'Price (৳)' : 'Cost (৳)'}
                      inputMode="decimal"
                      value={l.rate}
                      onChange={(e) => setLine(i, { rate: e.target.value })}
                    />
                    <div className="text-right text-sm font-medium tabular-nums">
                      {preview.lineTotals[i] !== null && preview.lineTotals[i] !== undefined
                        ? formatPaisa(preview.lineTotals[i])
                        : '—'}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                      disabled={lines.length === 1}
                      aria-label="Remove line"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLines((ls) => [...ls, { productId: '', qty: '', rate: '' }])}
              >
                <Plus className="h-4 w-4" /> Add line
              </Button>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label>Discount (৳)</Label>
                <Input inputMode="decimal" placeholder="0.00" value={discount} onChange={(e) => setDiscount(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>{isSale ? 'Received now (৳)' : 'Paid now (৳)'}</Label>
                <Input inputMode="decimal" placeholder="0.00" value={paid} onChange={(e) => setPaid(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Method</Label>
                <Select value={paidMethod} onChange={(e) => setPaidMethod(e.target.value as 'cash' | 'bank')}>
                  <option value="cash">Cash</option>
                  <option value="bank">Bank</option>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Note</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" />
            </div>

            <div className="flex items-center justify-between rounded-md bg-muted px-4 py-3 text-sm">
              <div className="space-x-4 tabular-nums">
                <span>Subtotal: <strong>{formatPaisa(preview.subtotal)}</strong></span>
                <span>Total: <strong>{formatPaisa(preview.total)}</strong></span>
                <span>Due: <strong>{formatPaisa(preview.due)}</strong></span>
                <span className="text-xs text-muted-foreground">(preview — server recomputes)</span>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => navigate(`/${kind}`)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? 'Posting…' : `Post ${isSale ? 'Sale' : 'Purchase'}`}
                </Button>
              </div>
            </div>

            {error && <ErrorNote message={error} />}
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
