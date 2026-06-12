import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, clearToken, getToken, setToken, type InstallInfo, type Role, type User, ROLE_RANK } from '../lib/api';

interface AuthContextValue {
  booted: boolean;
  user: User | null;
  install: InstallInfo | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshInstall: () => Promise<void>;
  hasRole: (min: Role) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [booted, setBooted] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [install, setInstall] = useState<InstallInfo | null>(null);

  const loadInstall = useCallback(async () => {
    const res = await api.get<{ install: InstallInfo | null }>('/api/install');
    setInstall(res.install);
  }, []);

  useEffect(() => {
    (async () => {
      if (getToken()) {
        try {
          const me = await api.get<{ user: User }>('/api/auth/me');
          setUser(me.user);
          await loadInstall();
        } catch {
          clearToken();
        }
      }
      setBooted(true);
    })();
  }, [loadInstall]);

  const login = useCallback(
    async (username: string, password: string) => {
      const res = await api.post<{ token: string; user: User }>('/api/auth/login', {
        username,
        password,
      });
      setToken(res.token);
      setUser(res.user);
      await loadInstall();
    },
    [loadInstall],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      // token may already be dead — clearing locally is what matters
    }
    clearToken();
    setUser(null);
    setInstall(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      booted,
      user,
      install,
      login,
      logout,
      refreshInstall: loadInstall,
      hasRole: (min) => user !== null && ROLE_RANK[user.role] >= ROLE_RANK[min],
    }),
    [booted, user, install, login, logout, loadInstall],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
