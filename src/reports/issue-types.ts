import type { Finding } from '../scanners/scanner-types.ts';

export interface Issue {
  id: string;
  title: string;
  directDependency: string;
  lockfile: string;
  project: { lockfile: string; dir: string; workspaces: string[] };
  alsoIn?: { issueId: string; lockfile: string; dir: string }[];
  findings: Finding[];
  findingIds: string[];
  otherIntroducers: string[];
  priority: number;
  fix: {
    kind: 'upgrade_direct' | 'refresh_lockfile' | 'upgrade_parent' | 'override' | 'no_fix';
    from?: string;
    target?: string;
    command?: string;
    baseCommand?: string;
    applyTo?: string;
    effort: 'low' | 'medium' | 'high';
    text: string;
    note?: string;
    fixableCount: number;
    unfixableCount: number;
  };
  problem: string;
  rootCause: string;
  fixText: string;
  whyItMatters: string;
  whySource: 'template' | 'ai';
}
