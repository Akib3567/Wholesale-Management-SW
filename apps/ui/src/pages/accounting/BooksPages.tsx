import { CashBookPage } from './CashBookPage';

export function CashBook() {
  return <CashBookPage kind="cash" />;
}
export function BankBook() {
  return <CashBookPage kind="bank" />;
}
