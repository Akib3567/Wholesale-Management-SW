import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { api, ApiError, type Product } from '../lib/api';
import { useApi } from '../lib/useApi';
import { formatQtyMilli, parseQtyToMilli } from '../lib/money';
import { useAuth } from '../auth/AuthContext';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select } from '../components/ui/select';
import { ErrorNote, Spinner } from '../components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/table';

export function ProductsPage() {
  const { install, hasRole } = useAuth();
  const [q, setQ] = useState('');
  const res = useApi(
    () => api.get<{ products: Product[] }>(`/api/products${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    [q],
  );
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<'pcs' | 'sqft' | 'kg'>('pcs');
  const [sku, setSku] = useState('');
  const [category, setCategory] = useState('');
  const [reorder, setReorder] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError('');
    let reorderLevelMilli = 0;
    if (reorder.trim() !== '') {
      const parsed = parseQtyToMilli(reorder);
      if (parsed === null) return setError('Reorder level must be a positive quantity');
      reorderLevelMilli = parsed;
    }
    setBusy(true);
    try {
      await api.post('/api/products', {
        name: name.trim(),
        unit,
        ...(sku.trim() ? { sku: sku.trim() } : {}),
        ...(category.trim() ? { category: category.trim() } : {}),
        reorderLevelMilli,
      });
      setOpen(false);
      setName(''); setSku(''); setCategory(''); setReorder('');
      res.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Products</h1>
        {hasRole('operator') && (
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> New Product
          </Button>
        )}
      </div>
      {!install?.isHub && (
        <p className="text-sm text-muted-foreground">
          This is not the hub: new products are created as <strong>provisional</strong> (owned by{' '}
          {install?.branchCode}) and merged into the company master list at the hub.
        </p>
      )}
      <Input
        placeholder="Search name / SKU / category…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="max-w-sm"
      />
      {res.error && <ErrorNote message={res.error} />}
      {res.loading && !res.data ? (
        <Spinner />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH><TH>SKU</TH><TH>Unit</TH><TH>Category</TH><TH>Status</TH>
              <TH className="text-right">Reorder level</TH>
            </TR>
          </THead>
          <TBody>
            {(res.data?.products ?? []).map((p) => (
              <TR key={p.id}>
                <TD className="font-medium">{p.name}</TD>
                <TD>{p.sku ?? '—'}</TD>
                <TD>{p.unit}</TD>
                <TD>{p.category ?? '—'}</TD>
                <TD>
                  {p.isProvisional ? (
                    <Badge variant="outline">provisional · {p.branchCode}</Badge>
                  ) : (
                    <Badge variant="secondary">master</Badge>
                  )}
                </TD>
                <TD className="text-right tabular-nums">
                  {p.reorderLevelMilli > 0 ? formatQtyMilli(p.reorderLevelMilli) : '—'}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} title="New Product">
        <form onSubmit={onCreate} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Unit</Label>
              <Select value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)}>
                <option value="pcs">pcs</option>
                <option value="sqft">sqft</option>
                <option value="kg">kg</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>SKU</Label>
              <Input value={sku} onChange={(e) => setSku(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Input value={category} onChange={(e) => setCategory(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Reorder level</Label>
              <Input inputMode="decimal" placeholder="0" value={reorder} onChange={(e) => setReorder(e.target.value)} />
            </div>
          </div>
          {error && <ErrorNote message={error} />}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? 'Saving…' : 'Create'}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
