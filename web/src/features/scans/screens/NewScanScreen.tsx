import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowRight, ChevronDown, Clock3, FolderTree, LockKeyhole } from 'lucide-react';
import { Accordion, Button, Checkbox, InputField, Notice } from '../../../components/ui';
import { repoUrlSchema } from '../../../../../src/contracts/repo-url.ts';

const examples = ['https://github.com/OWASP/NodeGoat', 'https://github.com/juice-shop/juice-shop'];
const submitFormSchema = z.object({
  url: repoUrlSchema,
  ref: z.string(),
  force: z.boolean(),
});
export function NewScanScreen({
  onScan,
  pending,
  error,
  initial,
}: {
  onScan: (url: string, ref: string, force: boolean) => void;
  pending: boolean;
  error: string;
  initial?: { url: string; ref: string; force?: boolean };
}) {
  const {
    register,
    handleSubmit,
    setValue,
    clearErrors,
    watch,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(submitFormSchema),
    defaultValues: {
      url: initial?.url ?? '',
      ref: initial?.ref ?? '',
      force: initial?.force ?? false,
    },
  });
  const invalid = errors.url?.message;
  return (
    <>
      <main className="max-w-content mx-auto w-full px-5 pt-12 pb-20 md:px-8 md:pt-16 xl:px-0">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,620px)_minmax(0,484px)] lg:gap-24">
          <section className="min-w-0">
            <p className="rounded-pill border-border bg-surface text-text-secondary inline-flex items-center gap-2 border px-3 py-2 text-xs font-medium">
              <span className="bg-primary size-2 rounded-full" /> npm dependency scan for public
              GitHub repos
            </p>
            <h1 className="text-text mt-9 text-[clamp(44px,6vw,72px)] leading-[1.055] font-bold tracking-[-.04em]">
              Know what to
              <br className="hidden sm:block" /> fix first.
            </h1>
            <p className="text-text-secondary mt-8 max-w-[540px] text-lg leading-8">
              Paste a public GitHub repository. We read its npm lockfiles and turn advisories into a
              short, ordered list of fixes, each with the reason behind it.
            </p>
            <form
              id="repo-scan"
              className="mt-12 space-y-4"
              onSubmit={handleSubmit((data) => onScan(data.url, data.ref, data.force))}
            >
              <div className="border-border-strong bg-surface flex min-w-0 flex-col gap-2 rounded-lg border p-2 shadow-[0_12px_32px_#14243b0f] sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <InputField
                    compact
                    label="Public GitHub repository URL"
                    placeholder="https://github.com/owner/repo"
                    required
                    error={invalid}
                    {...register('url')}
                  />
                </div>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={pending}
                  className="min-h-13 shrink-0"
                >
                  {pending ? 'Starting…' : 'Scan repository'}{' '}
                  <ArrowRight aria-hidden="true" className="size-4" />
                </Button>
              </div>
              {error && <Notice error>{error}</Notice>}
            </form>
            <div className="text-text-secondary mt-4 flex flex-wrap items-start justify-between gap-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                Try an example
                {examples.map((example) => (
                  <Button
                    key={example}
                    onClick={() => {
                      setValue('url', example);
                      clearErrors('url');
                    }}
                    className="rounded-pill min-h-8 px-3 font-mono text-xs"
                  >
                    {example.split('/').slice(-2).join('/')}
                  </Button>
                ))}
              </div>
              <Accordion.Root className="relative min-w-0 max-sm:w-full">
                <Accordion.Item value="options">
                  <Accordion.Header>
                    <Accordion.Trigger className="text-text-secondary flex min-h-11 items-center gap-2 text-sm font-medium max-sm:ml-auto">
                      Options <ChevronDown aria-hidden="true" data-chevron className="size-4" />
                    </Accordion.Trigger>
                  </Accordion.Header>
                  <Accordion.Panel className="border-border bg-surface w-full space-y-4 rounded-lg border p-4 shadow-lg sm:absolute sm:right-0 sm:z-10 sm:mt-2 sm:w-80">
                    <InputField
                      label="Branch, tag or commit (optional)"
                      form="repo-scan"
                      placeholder="Default branch"
                      {...register('ref')}
                    />
                    <Checkbox
                      checked={!!watch('force')}
                      onCheckedChange={(checked) => setValue('force', checked)}
                    >
                      Scan again even if a cached report exists
                    </Checkbox>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion.Root>
            </div>
            <ul className="border-border text-text-secondary mt-12 grid gap-5 border-t pt-6 text-sm sm:grid-cols-3">
              {(
                [
                  [
                    LockKeyhole,
                    'Read-only',
                    'We download a snapshot. Your code is never installed or run.',
                  ],
                  [
                    FolderTree,
                    'Monorepo-aware',
                    'Scans every supported lockfile, in any folder or workspace.',
                  ],
                  [
                    Clock3,
                    'Come back anytime',
                    'The scan link remains shareable while work continues.',
                  ],
                ] as const
              ).map(([Icon, label, detail]) => (
                <li key={label} className="flex items-start gap-3">
                  <Icon aria-hidden="true" className="text-primary size-5 shrink-0" />
                  <div>
                    <strong className="text-text">{label}</strong>
                    <p className="mt-1">{detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
          <aside
            aria-label="Illustrative sample report"
            className="border-border bg-surface self-start rounded-[20px] border p-6 shadow-[0_24px_48px_#14243b0f] md:p-7 lg:mt-[52px]"
          >
            <div className="text-text-muted flex flex-wrap items-center justify-between gap-2 text-xs font-medium">
              <span>SAMPLE REPORT · ILLUSTRATIVE</span>
              <span>Example only · not a live scan</span>
            </div>
            <div className="text-critical-ink mt-6 flex items-center gap-3 text-sm font-semibold">
              <span className="flex gap-1" aria-hidden="true">
                {[0, 1, 2, 3].map((n) => (
                  <span key={n} className="rounded-pill bg-critical h-1.5 w-7" />
                ))}
              </span>{' '}
              Example risk
            </div>
            <h2 className="mt-5 text-[28px] leading-[34px] font-bold tracking-[-.02em]">
              A short fix plan, backed by evidence.
            </h2>
            <div className="border-border mt-6 border-t">
              {[
                'Upgrade a direct package',
                'Update a dependency in multiple projects',
                'Refresh a lockfile',
              ].map((item, n) => (
                <div key={item} className="border-border flex items-center gap-3 border-b py-4">
                  <span className="text-text-muted font-mono text-sm">{n + 1}</span>
                  <span className="min-w-0 flex-1 text-sm font-medium">{item}</span>
                  <span className="rounded-pill bg-low-tint text-low-ink shrink-0 px-2 py-1 text-xs">
                    {n === 0 ? 'Priority' : 'Fix step'}
                  </span>
                </div>
              ))}
            </div>
            <p className="text-text-secondary mt-6 text-sm leading-6">
              Every fix includes the command to review, why it matters, and the advisories behind
              it.
            </p>
          </aside>
        </div>
      </main>
      <div className="max-w-content text-text-secondary mx-auto space-y-8 px-5 pb-20 text-sm md:px-8 xl:px-0">
        <section id="how-it-works" className="border-border border-t pt-6">
          <h2 className="text-text text-xl font-semibold">How it works</h2>
          <p className="mt-2">
            We fetch one public commit snapshot, read supported npm lockfiles without executing
            repository code, and match dependencies against OSV advisories. Optional enrichment gaps
            appear in Coverage.
          </p>
        </section>
        <section id="how-we-rank" className="border-border border-t pt-6">
          <h2 className="text-text text-xl font-semibold">How we rank</h2>
          <p className="mt-2">
            Severity, known exploitation, production exposure and repository context set the order.
            AI can only write explanations, not change evidence, scores or commands. Review every
            command before running it.
          </p>
        </section>
      </div>
    </>
  );
}
