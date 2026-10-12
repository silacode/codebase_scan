import type { ComponentProps } from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import { cn } from '../../utils/cn';

const buttonStyles = {
  primary: 'bg-primary text-white hover:bg-primary-strong',
  secondary: 'border border-border-strong bg-surface text-text hover:bg-primary-tint',
  quiet: 'text-text-secondary hover:text-primary hover:bg-primary-tint',
};
export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ComponentProps<typeof BaseButton> & { variant?: keyof typeof buttonStyles }) {
  return (
    <BaseButton
      {...props}
      className={cn(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold',
        buttonStyles[variant],
        className,
      )}
    />
  );
}
