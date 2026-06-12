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
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
