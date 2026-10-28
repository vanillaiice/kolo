/**
 * Suggest a download from what the browser reports. Bundled into the page script,
 * so it must stay a plain, dependency-free function.
 * @param {{ userAgent?: string, userAgentData?: { platform?: string } | null, maxTouchPoints?: number }} browser
 * @returns {'android'|'windows'|'linux'|'ios'|'mac'|null} A download card, an unsupported device, or null.
 */
export function detectPlatform({ userAgent = '', userAgentData, maxTouchPoints = 0 } = {}) {
  const hint = String(userAgentData?.platform ?? '').toLowerCase();
  const agent = String(userAgent).toLowerCase();
  // Android agents also contain "Linux", so Android is checked first.
  if (hint === 'android' || agent.includes('android')) return 'android';
  if (hint === 'ios' || /iphone|ipad|ipod/.test(agent)) return 'ios';
  if (hint === 'windows' || agent.includes('windows')) return 'windows';
  // iPadOS asks for desktop sites as "Macintosh"; only its touch screen tells it apart.
  if (hint === 'macos' || agent.includes('macintosh') || agent.includes('mac os x')) return maxTouchPoints > 1 ? 'ios' : 'mac';
  // ChromeOS runs Linux apps, so it gets the Linux build.
  if (hint === 'linux' || hint === 'chrome os' || hint === 'chromeos' || agent.includes('linux') || /\bcros\b/.test(agent)) return 'linux';
  return null;
}
