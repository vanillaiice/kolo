import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRelease } from './releases.mjs';
const asset = (tag, name, extra={}) => ({ name,state:'uploaded',size:123,browser_download_url:`https://github.com/vanillaiice/kolo/releases/download/${tag}/${name}`,...extra });
const release = (tag, date, extra={}) => ({ tag_name:tag, published_at:date, draft:false, prerelease:true, assets:[], ...extra });
test('selects published beta over older stable; ignores drafts and historical platform tags',()=>{
  const chosen=selectRelease([
    release('v0.2.0','2026-10-01',{prerelease:false}),
    release('v0.3.0','2026-10-02',{assets:[asset('v0.3.0','KOLO-0.2.0-android-universal.apk'),asset('v0.3.0','KOLO-0.3.0-win-x64-setup.exe')]}),
    release('v0.4.0','2026-10-03',{draft:true}),release('desktop-v9.0.0','2026-10-04'),
  ]);
  assert.equal(chosen.tag,'v0.3.0');
  assert.equal(chosen.assets.android.version,'0.2.0');
  assert.equal(chosen.assets.windows.version,'0.3.0');
});
test('missing, empty, unfinished, foreign and mismatched assets have no download link',()=>{
  const chosen=selectRelease([release('v0.3.0','2026-10-02',{assets:[
    asset('v0.3.0','KOLO-0.3.0-win-x64-setup.exe',{size:0}),
    asset('v0.3.0','KOLO-0.3.0-linux-x86_64.AppImage',{state:'new'}),
    asset('v0.3.0','KOLO-0.2.0-android-universal.apk',{browser_download_url:'https://evil.example/app.apk'}),
    asset('v0.2.0','KOLO-0.3.0-win-x64-portable.exe'),
    asset('v0.3.0','KOLO-0.2.0-android-arm64-v8a.apk',{browser_download_url:'https://github.com/vanillaiice/kolo/releases/download/v0.3.0/different.apk'}),
  ]})]);
  assert.deepEqual(chosen.assets,{});
});
test('no releases produces the release-page fallback',()=>{
  assert.equal(selectRelease([]),null);
  assert.equal(selectRelease([release('v0.3.0',null),release('v0.4.0','bad date')]),null);
});
