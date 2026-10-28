/** Umami visit statistics settings: `site.json` `analytics`, overridable per build through the environment. */

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the Umami script and website ID, or null when statistics are off.
 * `LANDING_UMAMI_SCRIPT` and `LANDING_UMAMI_WEBSITE_ID` replace the configured values;
 * `LANDING_UMAMI_SCRIPT=off` turns statistics off, so forks never report to someone else's server.
 * @param {{ umamiScript: string, umamiWebsiteId: string } | null | undefined} config
 * @param {Record<string, string | undefined>} env
 * @returns {{ script: string, websiteId: string, origin: string, host: string } | null}
 */
export function resolveAnalytics(config, env = {}) {
  const script = env.LANDING_UMAMI_SCRIPT ?? config?.umamiScript;
  const websiteId = env.LANDING_UMAMI_WEBSITE_ID ?? config?.umamiWebsiteId;
  if (!script || script === 'off') return null;
  let url;
  try { url = new URL(script); } catch { throw new Error(`Umami script ${script} is not a URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('The Umami script must be an HTTPS URL without credentials or a fragment.');
  if (!websiteId || !uuid.test(websiteId)) throw new Error('Umami needs its website ID (a UUID) next to the script URL.');
  return { script: url.href, websiteId, origin: url.origin, host: url.host };
}
