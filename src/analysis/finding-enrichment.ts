import { z } from 'zod';
import { fetchJson } from '../integrations/http-client.ts';
import type { ScanContext, Finding } from '../scanners/scanner-types.ts';

// Bound URL length when many CVEs need enrichment.
const EPSS_BATCH_SIZE = 100;
const KEV_REQUEST_TIMEOUT_MS = 8_000;
const EPSS_REQUEST_TIMEOUT_MS = 8_000;
const KEV_CACHE_TTL_MS = 24 * 60 * 60_000;
const EPSS_CACHE_TTL_MS = 24 * 60 * 60_000;

const kevSchema = z.object({
  vulnerabilities: z.array(z.object({ cveID: z.string() })),
});
const epssSchema = z.object({
  data: z.array(z.object({ cve: z.string(), epss: z.string(), percentile: z.string() })),
});
/** CISA KEV membership and FIRST EPSS probability
 * per CVE alias. KEV is one catalog (cached 24h); EPSS is fetched per missing CVE in
 * batches of 100. Either source failing degrades to a warning + a notScanned entry —
 * never fails the scan.
 */
export async function enrich(findings: Finding[], ctx: ScanContext) {
  const warnings: string[] = [],
    notScanned: { what: string; why: string }[] = [];
  let kevCatalogAt: string | undefined;
  const cves = [
    ...new Set(
      findings.flatMap((f) =>
        [f.advisoryId, ...f.aliases].filter((a) => /^CVE-\d{4}-\d+$/.test(a)),
      ),
    ),
  ];
  let kev = new Set<string>();
  try {
    const cached = await ctx.cache.get<{ at: string; ids: string[] }>('kev');
    let data: { at: string; ids: string[] };
    if (cached) {
      data = cached;
    } else {
      const payload = kevSchema.safeParse(
        await fetchJson<unknown>(
          'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
          {},
          { timeoutMs: KEV_REQUEST_TIMEOUT_MS, signal: ctx.signal },
        ),
      );
      if (!payload.success) throw Error('Invalid KEV payload');
      data = {
        at: new Date().toISOString(),
        ids: payload.data.vulnerabilities.map((v) => v.cveID),
      };
    }
    if (!cached) await ctx.cache.set('kev', data, KEV_CACHE_TTL_MS);
    kevCatalogAt = data.at;
    kev = new Set(data.ids);
  } catch {
    warnings.push('KEV unavailable');
    notScanned.push({ what: 'CISA KEV', why: 'source unavailable' });
    await ctx.progress('Warning: CISA KEV unavailable');
  }
  const epss = new Map<string, { epss: number; percentile: number }>();
  try {
    const missing: string[] = [];
    for (const cve of cves) {
      const cached = await ctx.cache.get<{ epss: number; percentile: number }>(`epss:${cve}`);
      if (cached) epss.set(cve, cached);
      else missing.push(cve);
    }
    for (let i = 0; i < missing.length; i += EPSS_BATCH_SIZE) {
      const batch = missing.slice(i, i + EPSS_BATCH_SIZE);
      const payload = epssSchema.safeParse(
        await fetchJson<unknown>(
          `https://api.first.org/data/v1/epss?cve=${batch.map(encodeURIComponent).join(',')}`,
          {},
          { timeoutMs: EPSS_REQUEST_TIMEOUT_MS, signal: ctx.signal },
        ),
      );
      if (!payload.success) throw Error('Invalid EPSS payload');
      for (const row of payload.data.data) {
        const value = { epss: Number(row.epss), percentile: Number(row.percentile) };
        if (!Number.isFinite(value.epss) || !Number.isFinite(value.percentile)) continue;
        epss.set(row.cve, value);
        await ctx.cache.set(`epss:${row.cve}`, value, EPSS_CACHE_TTL_MS);
      }
    }
  } catch {
    warnings.push('EPSS unavailable');
    notScanned.push({ what: 'FIRST EPSS', why: 'source unavailable' });
    await ctx.progress('Warning: FIRST EPSS unavailable');
  }
  for (const f of findings) {
    const aliases = [f.advisoryId, ...f.aliases];
    const value = aliases.map((a) => epss.get(a)).find(Boolean);
    f.exploit = {
      kev: aliases.some((a) => kev.has(a)),
      ...(value ? { epss: value.epss, epssPercentile: value.percentile } : {}),
    };
  }
  return { findings, warnings, notScanned, kevCatalogAt, advisoryDataAt: new Date().toISOString() };
}
