/** Select real assets from the newest published shared release, including betas. */
export const releasesURL = 'https://github.com/vanillaiice/kolo/releases';
const trustedDownload = /^https:\/\/github\.com\/vanillaiice\/kolo\/releases\/download\/v\d+\.\d+\.\d+\/[^/?#]+$/;
const patterns = {
  windows: /^KOLO-(\d+\.\d+\.\d+)-win-x64-setup\.exe$/,
  portable: /^KOLO-(\d+\.\d+\.\d+)-win-x64-portable\.exe$/,
  linux: /^KOLO-(\d+\.\d+\.\d+)-linux-x86_64\.AppImage$/,
  deb: /^KOLO-(\d+\.\d+\.\d+)-linux-amd64\.deb$/,
  android: /^KOLO-(\d+\.\d+\.\d+)-android-universal\.apk$/,
  arm64: /^KOLO-(\d+\.\d+\.\d+)-android-arm64-v8a\.apk$/,
  armv7: /^KOLO-(\d+\.\d+\.\d+)-android-armeabi-v7a\.apk$/,
};
export function selectRelease(releases) {
  const release = releases.filter(r => !r.draft && /^v\d+\.\d+\.\d+$/.test(r.tag_name)
    && Number.isFinite(Date.parse(r.published_at)))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  if (!release) return null;
  const assets = {};
  for (const [key, pattern] of Object.entries(patterns)) {
    const asset = release.assets?.find(a => pattern.test(a.name) && a.state === 'uploaded' && a.size > 0
      && trustedDownload.test(a.browser_download_url)
      && a.browser_download_url.endsWith(`/${a.name}`)
      && a.browser_download_url.includes(`/download/${release.tag_name}/`));
    if (asset) assets[key] = { url: asset.browser_download_url, version: asset.name.match(pattern)[1] };
  }
  return { tag: release.tag_name, beta: release.prerelease, url: `${releasesURL}/tag/${release.tag_name}`, assets };
}
