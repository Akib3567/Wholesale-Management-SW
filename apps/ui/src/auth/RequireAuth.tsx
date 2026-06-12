import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { Spinner } from '../components/ui/spinner';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { booted, user, install } = useAuth();
  if (!booted) return <Spinner className="mt-24" />;
  if (!user) return <Navigate to="/login" replace />;
  if (!install) return <Navigate to="/setup" replace />;
  return <>{children}</>;
}
