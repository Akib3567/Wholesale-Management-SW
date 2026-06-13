import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import { FirstRunSetup } from './auth/FirstRunSetup';
import { RequireAuth } from './auth/RequireAuth';
import { Layout } from './components/Layout';
import { DashboardPage } from './pages/DashboardPage';
import { PurchasesPage } from './pages/PurchasesPage';
import { PurchaseFormPage } from './pages/PurchaseFormPage';
import { SalesPage } from './pages/SalesPage';
import { SaleFormPage } from './pages/SaleFormPage';
import { PartiesPage } from './pages/PartiesPage';
import { ProductsPage } from './pages/ProductsPage';
import { JournalPage } from './pages/accounting/JournalPage';
import { LedgerPage } from './pages/accounting/LedgerPage';
import { CashBook, BankBook } from './pages/accounting/BooksPages';
import { TrialBalancePage } from './pages/accounting/TrialBalancePage';
import { DailySales, DailyPurchases } from './pages/reports/DailyPages';
import { StatementPage } from './pages/reports/StatementPage';
import { PnlPage } from './pages/reports/PnlPage';

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/setup" element={<FirstRunSetup />} />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/purchases" element={<PurchasesPage />} />
          <Route path="/purchases/new" element={<PurchaseFormPage />} />
          <Route path="/sales" element={<SalesPage />} />
          <Route path="/sales/new" element={<SaleFormPage />} />
          <Route path="/parties" element={<PartiesPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/accounting/journal" element={<JournalPage />} />
          <Route path="/accounting/ledger" element={<LedgerPage />} />
          <Route path="/accounting/cash-book" element={<CashBook />} />
          <Route path="/accounting/bank-book" element={<BankBook />} />
          <Route path="/accounting/trial-balance" element={<TrialBalancePage />} />
          <Route path="/reports/daily-sales" element={<DailySales />} />
          <Route path="/reports/daily-purchases" element={<DailyPurchases />} />
          <Route path="/reports/statement" element={<StatementPage />} />
          <Route path="/reports/pnl" element={<PnlPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
