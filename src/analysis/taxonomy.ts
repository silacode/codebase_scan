/**
 * Product taxonomy for classification. NOTE: mock data for now — buckets serve scoring
 * and report copy; their evidence comes from elsewhere (see references). Keep every label defined here in sync
 * with its evidence: repo labels with the framework lists below, impact buckets with
 * {@link ./cwe-impact-map.ts} (guarded by test).
 *
 * References: coarse repo layers follow SPDX 2.3 `primaryPackagePurpose`
 * (application vs library); `cli` follows npm `bin` semantics (a package declaring
 * `bin` is a CLI by platform definition); impact buckets follow MITRE CWE definitions.
 */
export const repoCriteria: Record<string, string> = {
  cli: 'A command-line tool run from a terminal',
  web_service: 'A server application handling network requests (HTTP API or website backend)',
  frontend: 'A browser-facing user interface or client application',
  library: 'Reusable code imported by other applications',
};
// Provisional: well-known dependency names as repo evidence. Prefer dependencies' own
// registry keywords/descriptions once that evidence path exists; this list rots.
export const serverFrameworks: string[] = [
  'express',
  'fastify',
  'koa',
  '@hapi/hapi',
  'hapi',
  '@nestjs/core',
  'next',
  'restify',
  'polka',
];
export const uiFrameworks: string[] = ['react', 'vue', 'svelte', '@angular/core', 'preact'];
export const impactCriteria: Record<string, string> = {
  code_execution: 'Allows an attacker to run unintended code or commands',
  prototype_pollution: 'Modifies object prototypes to affect other application behavior',
  denial_of_service: 'Disrupts availability by exhausting resources or crashing the service',
  xss: 'Injects scripts into a browser page viewed by users',
  path_traversal: 'Accesses files outside an intended filesystem path',
  ssrf: 'Tricks a server into making requests to unintended destinations',
  open_redirect: 'Redirects a user to an attacker-controlled destination',
  injection: 'Injects input into an interpreter such as a database query',
  auth_bypass: 'Avoids authorization or authentication checks',
  information_exposure: 'Reveals data that should not be accessible',
  other: 'A security impact not covered by these categories',
};
