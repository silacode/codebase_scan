import { Select as BaseSelect } from '@base-ui/react/select';
import { ChevronDown } from 'lucide-react';

export function Select({
  label,
  value,
  onChange,
  choices,
  className = '',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  choices: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <BaseSelect.Root value={value} onValueChange={(v) => onChange(v ?? '')} items={choices}>
        <BaseSelect.Label className="sr-only">{label}</BaseSelect.Label>
        <BaseSelect.Trigger className="border-border-strong bg-surface text-text flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-md border px-3 text-sm">
          <BaseSelect.Value />{' '}
          <BaseSelect.Icon>
            <ChevronDown aria-hidden="true" className="size-4" />
          </BaseSelect.Icon>
        </BaseSelect.Trigger>
        <BaseSelect.Portal>
          <BaseSelect.Positioner sideOffset={4} className="z-20">
            <BaseSelect.Popup className="border-border bg-surface max-h-64 overflow-auto rounded-md border p-1 shadow-lg">
              <BaseSelect.List>
                {choices.map((item) => (
                  <BaseSelect.Item
                    key={item.value}
                    value={item.value}
                    className="text-text data-[highlighted]:bg-primary-tint data-[selected]:text-primary flex min-h-10 cursor-pointer items-center rounded-sm px-3 text-sm"
                  >
                    <BaseSelect.ItemText>{item.label}</BaseSelect.ItemText>
                  </BaseSelect.Item>
                ))}
              </BaseSelect.List>
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
    </div>
  );
}
