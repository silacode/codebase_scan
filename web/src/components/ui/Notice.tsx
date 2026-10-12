import type { ReactNode } from 'react';

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div
      role={error ? 'alert' : 'status'}
      className={`rounded-md border p-4 text-sm ${error ? 'border-critical bg-critical-tint text-critical-ink' : 'border-border bg-primary-tint text-text'}`}
    >
      {children}
    </div>
  );
}
