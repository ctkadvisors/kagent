# npm installs go through the homelab Verdaccio

Every `npm`/`pnpm`/corepack install in kagent CI and image builds uses the in-cluster Verdaccio
(`verdaccio.verdaccio.svc.cluster.local:4873`, UI/browse at `verdaccio.knuteson.io`), not npmjs directly.

- **Cooldown:** versions younger than 3 days are hidden (metadata and tarball 404). Pin or wait.
- **Logging:** every request is shipped to OpenSearch (`verdaccio-*`); a daily scan checks the cached
  tarballs against OSV `MAL-*` advisories and flags install scripts.
- **Dockerfiles:** each install stage declares `ARG npm_config_registry` and `ARG COREPACK_NPM_REGISTRY`
  (defaults to the public registry so local builds still work). Workflows pass the Verdaccio URL as `build-args`.
- **pnpm:** `packageManager` in `package.json` carries a sha512 pin; do not also set `version:` on `pnpm/action-setup`.
- **Runners:** the homelab runner sets alias `registry.npmjs.org` and `registry.yarnpkg.com` to loopback. That is a
  guardrail, not a sandbox.
