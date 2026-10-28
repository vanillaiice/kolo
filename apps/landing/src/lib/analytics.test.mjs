import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAnalytics } from './analytics.mjs';

const config = { umamiScript: 'https://stats.example.org/script.js', umamiWebsiteId: '9e1c1208-ee0e-4ac5-83db-2631a1db803d' };

test('configured values are used and expose the origin for the CSP', () => {
  assert.deepEqual(resolveAnalytics(config), { script: config.umamiScript, websiteId: config.umamiWebsiteId, origin: 'https://stats.example.org', host: 'stats.example.org' });
});

test('missing configuration or the off switch disables statistics', () => {
  for (const [value, env] of [[null, {}], [undefined, {}], [config, { LANDING_UMAMI_SCRIPT: 'off' }], [config, { LANDING_UMAMI_SCRIPT: '' }]]) assert.equal(resolveAnalytics(value, env), null);
});

test('environment values replace the configured ones', () => {
  const resolved = resolveAnalytics(config, { LANDING_UMAMI_SCRIPT: 'https://u.fork.test/umami.js', LANDING_UMAMI_WEBSITE_ID: '00000000-0000-4000-8000-000000000000' });
  assert.equal(resolved.origin, 'https://u.fork.test');
  assert.equal(resolved.websiteId, '00000000-0000-4000-8000-000000000000');
  assert.equal(resolveAnalytics(null, { LANDING_UMAMI_SCRIPT: config.umamiScript, LANDING_UMAMI_WEBSITE_ID: config.umamiWebsiteId }).host, 'stats.example.org');
});

test('unsafe or incomplete settings fail the build', () => {
  for (const bad of [
    { ...config, umamiScript: 'http://stats.example.org/script.js' },
    { ...config, umamiScript: 'javascript:alert(1)' },
    { ...config, umamiScript: 'https://user:pw@stats.example.org/script.js' },
    { ...config, umamiScript: 'not a url' },
    { ...config, umamiWebsiteId: '' },
    { ...config, umamiWebsiteId: '9e1c1208' },
    { ...config, umamiWebsiteId: '9e1c1208-ee0e-4ac5-83db-2631a1db803d"><script>' },
  ]) assert.throws(() => resolveAnalytics(bad), undefined, JSON.stringify(bad));
});
