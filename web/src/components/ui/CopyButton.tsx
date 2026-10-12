import { Check, Copy } from 'lucide-react';
import { useClipboard } from '../../hooks/useClipboard';
import { Button } from './Button';

export function CopyButton({
  value,
  label,
  text = label,
  compactOnMobile = false,
  inCommand = false,
  className = '',
}: {
  value: string;
  label: string;
  text?: string;
  compactOnMobile?: boolean;
  inCommand?: boolean;
  className?: string;
}) {
  const { status, copy } = useClipboard();
  return (
    <span
      className={`${inCommand ? 'contents' : 'inline-flex min-w-0 flex-col items-start gap-2'} ${className}`}
    >
      <Button aria-label={label} className="whitespace-nowrap" onClick={() => void copy(value)}>
        {status === 'Copied' ? (
          <Check aria-hidden="true" className="size-4 shrink-0" />
        ) : (
          <Copy aria-hidden="true" className="size-4 shrink-0" />
        )}
        <span className={compactOnMobile ? 'hidden sm:grid' : 'grid'}>
          <span aria-hidden="true" className="invisible col-start-1 row-start-1">
            {text}
          </span>
          <span className="invisible col-start-1 row-start-1">Copied</span>
          <span className="col-start-1 row-start-1">{status === 'Copied' ? 'Copied' : text}</span>
        </span>
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {status === 'Copied' ? `${label} copied` : ''}
      </span>
      {status && status !== 'Copied' && (
        <span
          role="alert"
          className={`flex max-w-full min-w-0 flex-col gap-2 text-xs break-words ${inCommand ? 'text-code-text col-span-2' : 'text-critical-ink'}`}
        >
          {status}
          <textarea
            aria-label={`Select ${label.toLowerCase()} text`}
            readOnly
            value={value}
            onFocus={(event) => event.currentTarget.select()}
            className="border-border-strong bg-surface text-text w-full min-w-0 rounded-md border p-2 font-mono text-sm"
            rows={2}
          />
        </span>
      )}
    </span>
  );
}
