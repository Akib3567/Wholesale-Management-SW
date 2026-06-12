import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { api, ApiError } from '../lib/api';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { ErrorNote } from '../components/ui/spinner';

/** One-time branch identity setup. The branch code is permanent. */
export function FirstRunSetup() {
  const { user, install, refreshInstall } = useAuth();
  const navigate = useNavigate();
  const [branchCode, setBranchCode] = useState('');
  const [branchName, setBranchName] = useState('');
  const [isHub, setIsHub] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!user) return <Navigate to="/login" replace />;
  if (install) return <Navigate to="/" replace />;
  if (user.role !== 'admin') {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="max-w-md">
          <CardContent className="p-6 text-sm">
            This PC has not been assigned a branch yet. Ask an administrator to sign in and
            complete the one-time branch setup.
          </CardContent>
        </Card>
      </div>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/api/install/bootstrap', {
        branchCode: branchCode.toUpperCase().trim(),
        branchName: branchName.trim(),
        isHub,
      });
      await refreshInstall();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Setup failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md">
        <CardContent className="p-6">
          <h1 className="mb-1 text-xl font-bold">Branch setup</h1>
          <p className="mb-6 text-sm text-muted-foreground">
            Assign this PC its permanent branch identity. <strong>This cannot be changed later</strong> —
            every record this PC creates is stamped with it forever.
          </p>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="code">Branch code (e.g. DHAKA, CTG)</Label>
              <Input
                id="code"
                autoFocus
                placeholder="DHAKA"
                value={branchCode}
                onChange={(e) => setBranchCode(e.target.value.toUpperCase())}
                maxLength={12}
              />
              <p className="text-xs text-muted-foreground">2–12 chars: A–Z, 0–9, underscore.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="name">Branch name</Label>
              <Input
                id="name"
                placeholder="Dhaka Head Office"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
              />
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={isHub}
                onChange={(e) => setIsHub(e.target.checked)}
              />
              <span>
                <strong>This PC is the HUB</strong> — it collects every branch's packets and
                publishes the combined company packet. Exactly one PC should be the hub.
              </span>
            </label>
            {error && <ErrorNote message={error} />}
            <Button
              type="submit"
              className="w-full"
              disabled={busy || !branchCode.trim() || !branchName.trim()}
            >
              {busy ? 'Saving…' : 'Set branch identity'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
