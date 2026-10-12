import type { ReactNode } from 'react';
import { AppHeader } from './AppHeader';
import { AppFooter } from './AppFooter';

export function AppLayout({
  id,
  onHome,
  children,
}: {
  id: string;
  onHome: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <AppHeader id={id} onHome={onHome} />
      {children}
      <AppFooter />
    </>
  );
}
