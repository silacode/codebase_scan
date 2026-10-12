import { CopyButton } from './CopyButton';

export function CommandBlock({
  value,
  label,
  file,
}: {
  value: string;
  label: string;
  file?: string;
}) {
  return (
    <div className="min-w-0 space-y-2">
      {file && (
        <p className="text-text-secondary text-sm">
          Add to <code className="break-all">{file}</code>
        </p>
      )}
      <div className="bg-text grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md p-3">
        <pre tabIndex={0} className="text-code-text min-w-0 overflow-x-auto py-2 font-mono text-sm">
          <code>{value}</code>
        </pre>
        <CopyButton
          value={value}
          label={label}
          text={file ? 'Copy snippet' : 'Copy command'}
          compactOnMobile
          inCommand
          className="[&_button]:border-code-muted [&_button]:bg-text [&_button:hover]:bg-text [&_button]:text-white [&_button:hover]:text-white"
        />
      </div>
    </div>
  );
}
