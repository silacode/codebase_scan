import type { ReactNode } from 'react';
import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { Check } from 'lucide-react';

export function Checkbox({
  checked,
  onCheckedChange,
  children,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="text-text-secondary flex cursor-pointer items-center gap-3 text-sm">
      <BaseCheckbox.Root
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        className="border-border-strong bg-surface data-[checked]:border-primary data-[checked]:bg-primary flex size-6 shrink-0 items-center justify-center rounded-sm border"
      >
        <BaseCheckbox.Indicator>
          <Check aria-hidden="true" className="size-4 text-white" />
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      {children}
    </label>
  );
}
