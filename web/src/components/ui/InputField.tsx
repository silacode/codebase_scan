import type { ComponentProps } from 'react';
import { Field } from '@base-ui/react/field';

export function InputField({
  label,
  error,
  compact = false,
  ...props
}: ComponentProps<typeof Field.Control> & { label: string; error?: string; compact?: boolean }) {
  return (
    <Field.Root invalid={!!error} className="flex min-w-0 flex-col gap-2">
      <Field.Label className={compact ? 'sr-only' : 'text-text text-sm font-semibold'}>
        {label}
      </Field.Label>
      <Field.Control
        {...props}
        className={
          compact
            ? 'text-text placeholder:text-text-muted min-h-11 w-full min-w-0 bg-transparent px-3 text-base'
            : 'border-border-strong bg-surface text-text placeholder:text-text-muted data-[invalid]:border-critical min-h-11 w-full min-w-0 rounded-md border px-4 text-base'
        }
      />
      {error && (
        <Field.Description className="text-critical-ink text-sm" role="alert">
          {error}
        </Field.Description>
      )}
    </Field.Root>
  );
}
