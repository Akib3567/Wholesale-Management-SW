import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  LogOut,
  Package,
  ShoppingCart,
  Tag,
  Users,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { cn } from '../lib/utils';

const nav = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/sales', label: 'Sales', icon: Tag },
  { to: '/purchases', label: 'Purchases', icon: ShoppingCart },
  { to: '/parties', label: 'Parties', icon: Users },
  { to: '/products', label: 'Products', icon: Package },
];

const comingSoon = ['Daily', 'Accounting', 'Reports', 'Inventory', 'Sync Center', 'Settings'];

export function Layout() {
  const { user, install, logout } = useAuth();

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 flex-col border-r bg-card">
        <div className="border-b px-4 py-4">
          <div className="text-base font-bold leading-tight">Leather ERP</div>
          {install && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <Badge variant="secondary">{install.branchCode}</Badge>
              {install.isHub && <Badge>HUB</Badge>}
            </div>
          )}
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  isActive && 'bg-accent text-accent-foreground',
                )
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
          <div className="pt-3">
            {comingSoon.map((label) => (
              <div
                key={label}
                className="cursor-not-allowed select-none rounded-md px-3 py-1.5 text-sm text-muted-foreground/50"
                title="Coming in a later phase"
              >
                {label}
              </div>
            ))}
          </div>
        </nav>
        <div className="border-t p-3">
          <div className="mb-2 px-1 text-sm">
            <div className="font-medium">{user?.fullName}</div>
            <div className="text-xs text-muted-foreground">{user?.role}</div>
          </div>
          <Button variant="outline" size="sm" className="w-full" onClick={() => void logout()}>
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-x-hidden bg-muted/30 p-6">
        <Outlet />
      </main>
    </div>
  );
}
