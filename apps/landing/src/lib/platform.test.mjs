import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform } from './platform.mjs';
const agents = {
  android: [
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-A155F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
    'Mozilla/5.0 (Linux; U; Android 9; TECNO KC8 Build/PPR1.180610.011) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/87.0.4280.141 Mobile Safari/537.36 OPR/52.1.2254.54298',
    'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  ],
  windows: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
    'Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; rv:11.0) like Gecko',
  ],
  linux: [
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  ],
  ios: [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 12_5_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1',
  ],
  mac: [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
  ],
};
for (const [expected, list] of Object.entries(agents)) {
  test(`real ${expected} user agents`, () => {
    for (const userAgent of list) assert.equal(detectPlatform({ userAgent }), expected, userAgent);
  });
}
test('iPadOS asking for the desktop site looks like a Mac but has a touch screen', () => {
  const userAgent = agents.mac[0];
  assert.equal(detectPlatform({ userAgent, maxTouchPoints: 5 }), 'ios');
  assert.equal(detectPlatform({ userAgent, maxTouchPoints: 0 }), 'mac');
});
test('client hints take precedence over a reduced or misleading user agent', () => {
  const reduced = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
  assert.equal(detectPlatform({ userAgent: reduced, userAgentData: { platform: 'Android' } }), 'android');
  assert.equal(detectPlatform({ userAgent: agents.linux[1], userAgentData: { platform: 'Windows' } }), 'windows');
  assert.equal(detectPlatform({ userAgent: '', userAgentData: { platform: 'Chrome OS' } }), 'linux');
  assert.equal(detectPlatform({ userAgent: '', userAgentData: { platform: 'macOS' } }), 'mac');
});
test('Android is never mistaken for desktop Linux, whatever else the agent says', () => {
  for (const userAgent of agents.android) assert.equal(detectPlatform({ userAgent, userAgentData: { platform: '' } }), 'android');
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', userAgentData: { platform: 'Android' } }), 'android');
});
test('unknown, empty and odd inputs suggest nothing and never throw', () => {
  for (const browser of [undefined, {}, { userAgent: '' }, { userAgent: 'curl/8.9.1' }, { userAgent: 'Googlebot/2.1 (+http://www.google.com/bot.html)' },
    { userAgent: 'Mozilla/5.0 (PlayStation; PlayStation 5/2.26)' }, { userAgentData: null }, { userAgentData: { platform: 'Unknown' } }, { userAgent: null }]) {
    assert.equal(detectPlatform(browser), null, JSON.stringify(browser));
  }
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Microsoft; Lumia 950)' }), 'windows', '"microsoft" must not read as CrOS');
});
