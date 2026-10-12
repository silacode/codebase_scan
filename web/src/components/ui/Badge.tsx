import type { ReactNode } from 'react';

export function Badge({ level, children }: { level: string; children?: ReactNode }) {
  const tone: Record<string, string> = {
    critical: 'bg-critical-tint text-critical-ink',
    high: 'bg-high-tint text-high-ink',
    medium: 'bg-medium-tint text-medium-ink',
    low: 'bg-low-tint text-low-ink',
    clean: 'bg-primary-tint text-primary',
    running: 'bg-primary-tint text-primary',
    queued: 'bg-primary-tint text-primary',
  };
  return (
    <span
      className={`rounded-pill inline-flex items-center px-3 py-1 text-xs font-semibold capitalize ${tone[level] ?? 'bg-low-tint text-low-ink'}`}
    >
      {children ?? level}
    </span>
  );
}
