import { CircleHelp, Plus } from 'lucide-react';
import { Button as BaseButton } from '@base-ui/react/button';
import { Button, ScanLogo } from '../ui';

export function AppHeader({ id, onHome }: { id: string; onHome: () => void }) {
  return (
    <header className="border-border border-b">
      <div className="max-w-content mx-auto flex min-h-18 items-center justify-between gap-3 px-5 md:px-8 xl:px-0">
        <BaseButton
          onClick={() => onHome()}
          className="text-text flex min-h-11 items-center gap-2 font-semibold"
          aria-label="Scan Review home"
        >
          <ScanLogo />
          <span className="text-lg tracking-[-.02em]">Scan Review</span>
        </BaseButton>
        {id ? (
          <Button onClick={() => onHome()}>
            <Plus aria-hidden="true" className="size-4" />
            <span className="hidden sm:inline">New scan</span>
            <span className="sm:hidden">New</span>
          </Button>
        ) : (
          <nav aria-label="Help" className="flex items-center gap-2 text-sm">
            <a href="#how-it-works" className="hidden min-h-11 items-center px-2 sm:inline-flex">
              How it works
            </a>
            <a href="#how-we-rank" className="inline-flex min-h-11 items-center gap-1 px-2">
              <CircleHelp aria-hidden="true" className="size-4 sm:hidden" />
              <span className="hidden sm:inline">How we rank</span>
              <span className="sm:hidden">Help</span>
            </a>
          </nav>
        )}
      </div>
    </header>
  );
}
