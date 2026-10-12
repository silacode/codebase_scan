import type { ComponentProps } from 'react';
import { cn } from '../../utils/cn';

/** Card container; padding and layout merge over the `p-6` default. */
export function Panel({
  as: Tag = 'div',
  className,
  ...props
}: { as?: 'div' | 'section' | 'aside'; className?: string } & ComponentProps<'div'>) {
  return (
    <Tag {...props} className={cn('border-border bg-surface rounded-lg border p-6', className)} />
  );
}
