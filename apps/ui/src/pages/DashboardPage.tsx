import { useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, type DashboardData } from '../lib/api';
import { useApi } from '../lib/useApi';
import { formatPaisa } from '../lib/money';
import { useAuth } from '../auth/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Select } from '../components/ui/select';
import { Badge } from '../components/ui/badge';
import { ErrorNote, Spinner } from '../components/ui/spinner';

function StatCard({ title, value, accent }: { title: string; value: string; accent?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold ${accent ?? ''}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const { install } = useAuth();
  const [scope, setScope] = useState('THIS');
  const { data, error, loading } = useApi(
    () => api.get<DashboardData>(`/api/dashboard?scope=${encodeURIComponent(scope)}`),
    [scope],
  );

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;

  const scopeLabel =
    data.scope === 'ALL' ? 'Whole company' : data.scope === install?.branchCode ? 'This branch' : data.scope;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Dashboard</h1>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Scope</span>
          <Select value={scope} onChange={(e) => setScope(e.target.value)} className="w-52">
            <option value="THIS">This branch ({data.branchCode})</option>
            <option value="ALL">Whole company</option>
            {data.branches
              .filter((b) => !b.isSelf)
              .map((b) => (
                <option key={b.code} value={b.code}>
                  {b.code} — {b.name}
                </option>
              ))}
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard title={`Today's Sales (${scopeLabel})`} value={formatPaisa(data.today.salesPaisa)} />
        <StatCard title="Today's Purchases" value={formatPaisa(data.today.purchasesPaisa)} />
        <StatCard title="Today's Expenses" value={formatPaisa(data.today.expensesPaisa)} />
        <StatCard
          title={`Low Stock (${data.lowStockBranch})`}
          value={String(data.lowStockCount)}
          accent={data.lowStockCount > 0 ? 'text-destructive' : ''}
        />
        <StatCard title="Cash in Hand" value={formatPaisa(data.cashPaisa)} />
        <StatCard title="Bank" value={formatPaisa(data.bankPaisa)} />
        <StatCard title="Receivables (Due to us)" value={formatPaisa(data.receivablesPaisa)} />
        <StatCard title="Payables (We owe)" value={formatPaisa(data.payablesPaisa)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sales vs Purchases — last 30 days ({scopeLabel})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.series} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(28 15% 90%)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d: string) => d.slice(5)} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => formatPaisa(v)} width={90} />
                <Tooltip formatter={(v: number | string) => formatPaisa(Number(v))} />
                <Legend />
                <Line type="monotone" dataKey="salesPaisa" name="Sales" stroke="hsl(150 60% 35%)" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="purchasesPaisa" name="Purchases" stroke="hsl(24 60% 40%)" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Branches & last sync</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {data.branches.map((b) => (
            <div key={b.code} className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
              <Badge variant={b.isSelf ? 'default' : 'secondary'}>{b.code}</Badge>
              {b.isHub && <Badge variant="outline">hub</Badge>}
              <span className="text-muted-foreground">
                {b.isSelf
                  ? 'this PC (live)'
                  : b.lastImportAt
                    ? `data as of ${new Date(b.lastImportAt).toLocaleString()}`
                    : 'never synced'}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
