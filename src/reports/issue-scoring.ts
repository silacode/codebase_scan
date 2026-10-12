import type { Finding } from '../scanners/scanner-types.ts';

/** Prioritize more severe findings while retaining lower-severity evidence in ranking. */
export const weights = { critical: 10, high: 7, medium: 4, low: 1 };
/** Elevate findings with confirmed exploitation evidence in issue ranking. */
const KEV_EXPLOIT_MULTIPLIER = 2;
/** Use a meaningful probability signal before boosting a finding's rank. */
const EPSS_EXPLOIT_THRESHOLD = 0.1;
/** Elevate strong predictive evidence less than known exploitation. */
const EPSS_EXPLOIT_MULTIPLIER = 1.5;
/** Rank dev-only exposure lower without treating it as harmless. */
const DEV_DEPENDENCY_MULTIPLIER = 0.3;
/** Give web services extra weight for impacts relevant to network exposure. */
const WEB_IMPACT_MULTIPLIER = 1.2;
/** Keep finding volume from overwhelming the strongest finding's score. */
export const ISSUE_BONUS_MAX_SHARE = 0.5;
/** Let additional findings affect priority without dominating the top risk. */
export const ISSUE_BONUS_OTHER_SCORES_SHARE = 0.1;
/**
 * Priority weight of one finding: severity × exploit boost (KEV ×2 / EPSS ≥ 0.1 ×1.5) ×
 * dev-dependency discount (×0.3) × impact boost (×1.2) for web services exposed to the
 * impactful classes (RCE, DoS, XSS, SSRF, traversal, injection, auth bypass).
 */
export function score(f: Finding, repoType: string) {
  const impact = f.context?.impactClass;
  return (
    weights[f.severity] *
    (f.exploit?.kev
      ? KEV_EXPLOIT_MULTIPLIER
      : f.exploit?.epss && f.exploit.epss >= EPSS_EXPLOIT_THRESHOLD
        ? EPSS_EXPLOIT_MULTIPLIER
        : 1) *
    (f.dev ? DEV_DEPENDENCY_MULTIPLIER : 1) *
    (repoType === 'web_service' &&
    [
      'code_execution',
      'denial_of_service',
      'xss',
      'ssrf',
      'path_traversal',
      'injection',
      'auth_bypass',
    ].includes(impact ?? '')
      ? WEB_IMPACT_MULTIPLIER
      : 1)
  );
}
/** Break priority ties consistently in favor of easier fixes. */
export const effortRank = { low: 0, medium: 1, high: 2 };
