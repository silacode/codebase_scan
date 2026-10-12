/**
 * Wire types derive from the server modules that produce the JSON — never redeclared here.
 * `Json<T>` maps the server's Date columns to the ISO strings the wire actually carries.
 * The overlays below keep a few fields optional where the UI renders them with fallbacks,
 * because reports stored by older scanner versions may predate them (see the legacy report
 * contract in test/e2e/scan.spec.ts).
 */
type Json<T> = T extends Date
  ? string
  : T extends (infer A)[]
    ? Json<A>[]
    : T extends object
      ? { [K in keyof T]: Json<T[K]> }
      : T;

type ServerFinding = import('../../../../../src/scanners/scanner-types.ts').Finding;
type ServerIssue = import('../../../../../src/reports/issue-types.ts').Issue;
type BuiltReport = ReturnType<
  typeof import('../../../../../src/reports/report-builder.ts').buildReport
>;
type ServerScan = Json<
  Awaited<ReturnType<typeof import('../../../../../src/scans/scan-queries.ts').snapshot>>
>;

/** Older stored findings may lack the human-readable fields Evidence falls back from. */
export type Finding = Omit<ServerFinding, 'title' | 'lockfile' | 'path'> & {
  title?: string;
  lockfile?: string;
  path?: string[];
};

/** Older stored issues may lack project metadata and per-fix counts FixPlan falls back from. */
export type Issue = Omit<ServerIssue, 'project' | 'lockfile' | 'fix' | 'findings'> & {
  project?: ServerIssue['project'];
  lockfile?: string;
  findings: Finding[];
  fix: Omit<ServerIssue['fix'], 'text' | 'fixableCount' | 'unfixableCount'> & {
    text?: string;
    fixableCount?: number;
    unfixableCount?: number;
  };
};

type Action = BuiltReport['actionPlan'][number];
type Location = Action['locations'][number];

/** Older stored action-plan entries may predate grouped ids/kinds/locations (legacy reports). */
export type Report = Omit<BuiltReport, 'actionPlan' | 'topIssues' | 'stats' | 'provenance'> & {
  topIssues: Issue[];
  // Scanner stats pass through with keys (packages, lockfiles, …) beyond the four
  // buildReport computes; the spread drops that from its return type, so take the four
  // as optional and name the scanner keys the UI renders.
  stats: Partial<BuiltReport['stats']> & { packages?: number; lockfiles?: number };
  // Older stored reports may predate the KEV catalog timestamp; the UI falls back to
  // 'Not recorded' rather than failing.
  provenance: Omit<BuiltReport['provenance'], 'kevCatalogAt'> & { kevCatalogAt?: string };
  actionPlan: (Omit<Action, 'issueIds' | 'kind' | 'baseCommand' | 'locations'> & {
    issueId?: string;
    issueIds?: string[];
    kind?: Action['kind'];
    baseCommand?: string;
    locations?: (Omit<Location, 'from' | 'command' | 'applyTo' | 'note'> & {
      from?: string;
      command?: string;
      applyTo?: string;
      note?: string;
    })[];
  })[];
};

export type Scan = Omit<ServerScan, 'report'> & {
  report: Report | null;
  cached?: boolean;
  deduplicated?: boolean;
};
