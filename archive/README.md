# Migration references

`legacy-mobile/package-lock.json` preserves the prior mobile dependency resolution;
active installs use only the root `package-lock.json`.

The previous Go server is no longer published here. Maintainers may keep a local
copy under `legacy-go/` (ignored by git) as a porting reference; it is also in the
repository history.
