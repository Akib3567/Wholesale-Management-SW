import { NavLink, Outlet } from 'react-router-dom';
import {
  CalendarDays,
  DatabaseBackup,
  LayoutDashboard,
  LogOut,
  Package,
  Receipt,
  RefreshCw,
  ShoppingCart,
  Tag,
  Users,
  Wallet,
  Warehouse,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ThemeToggle } from '../theme/ThemeToggle';
import { cn } from '../lib/utils';

const nav = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/sales', label: 'Sales', icon: Tag },
  { to: '/purchases', label: 'Purchases', icon: ShoppingCart },
  { to: '/payments', label: 'Payments', icon: Wallet },
  { to: '/expenses', label: 'Expenses', icon: Receipt },
  { to: '/daily', label: 'Daily', icon: CalendarDays },
  { to: '/parties', label: 'Parties', icon: Users },
  { to: '/products', label: 'Products', icon: Package },
  { to: '/inventory', label: 'Inventory', icon: Warehouse },
  { to: '/sync', label: 'Sync Center', icon: RefreshCw },
  { to: '/backups', label: 'Backups', icon: DatabaseBackup },
];

const accountingNav = [
  { to: '/accounting/journal', label: 'Journal' },
  { to: '/accounting/ledger', label: 'Ledger' },
  { to: '/accounting/cash-book', label: 'Cash Book' },
  { to: '/accounting/bank-book', label: 'Bank Book' },
  { to: '/accounting/trial-balance', label: 'Trial Balance' },
];

const reportsNav = [
  { to: '/reports/daily-sales', label: 'Daily Sales' },
  { to: '/reports/daily-purchases', label: 'Daily Purchase' },
  { to: '/reports/statement', label: 'Statement' },
  { to: '/reports/pnl', label: 'Profit & Loss' },
];

const comingSoon = ['Settings'];

export function Layout() {
  const { user, install, logout } = useAuth();

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 flex-col border-r bg-card print:hidden">
        <div className="border-b px-4 py-4">
          <div className="text-base font-bold leading-tight">NSK Enterprise</div>
          {install && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <Badge variant="secondary">{install.branchCode}</Badge>
              {install.isHub && <Badge>HUB</Badge>}
            </div>
          )}
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
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
          {(
            [
              ['Accounting', accountingNav],
              ['Reports', reportsNav],
            ] as const
          ).map(([section, items]) => (
            <div key={section} className="pt-2">
              <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                {section}
              </div>
              {items.map(({ to, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    cn(
                      'block rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                      isActive && 'bg-accent font-medium text-accent-foreground',
                    )
                  }
                >
                  {label}
                </NavLink>
              ))}
            </div>
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
        <div className="space-y-2 border-t p-3">
          <div className="px-1 text-sm">
            <div className="font-medium">{user?.fullName}</div>
            <div className="text-xs text-muted-foreground">{user?.role}</div>
          </div>
          <ThemeToggle className="w-full" />
          <Button variant="outline" size="sm" className="w-full" onClick={() => void logout()}>
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-x-hidden bg-muted/30 p-6 print:bg-white print:p-0">
        <Outlet />
      </main>
    </div>
  );
}
