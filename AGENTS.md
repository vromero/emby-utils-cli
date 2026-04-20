# Agent Guidelines — @emby-utils/cli

## What this repo is

CLI tool published to npm as **`@emby-utils/cli`** (binary: `emby`). Consumers install it globally:

```bash
npm install -g @emby-utils/cli
```

The `@emby-utils/client` dependency is consumed from npm (`^0.1.0`). The repo's own `prepare` script builds `dist/` for local dev / git installs; `files` + `publishConfig.access: public` control what ships in the tarball.

A sibling MCP server lives at `vromero/emby-utils-mcp`.

## Setup & Environment

- ESM-only (`"type": "module"`). Use `.js` extensions in relative TypeScript imports (NodeNext resolution).
- Node >=22.13 (enforced in `engines`).
- The bin auto-loads `.env` from CWD if present; override path with `EMBY_ENV_FILE`. `emby` also accepts `--host` and `--api-key` flags.
- The published tarball contains only `dist/`, `README.md`, and `package.json` (see the `files` array). `npm pack --dry-run` is the canonical way to verify tarball contents before a release.

## Commands

- `npm install` — deps (also runs `prepare` which builds `dist/`).
- `npm run build` — `tsc -p tsconfig.build.json`.
- `npm start` — runs the compiled CLI.
- `npm test` — Vitest (unit tests only by default).
- `npm run lint` / `lint:fix`, `npm run format` / `format:check`.

## Architecture

- `src/bin.ts` — entrypoint. Loads env, builds the program, parses argv.
- `src/index.ts` — exports `buildCli({ io, clientFactory })`. Tests inject a capturing IO.
- `src/format.ts` — `--format json|yaml|table` renderer. Table uses `cli-table3`; yaml uses `yaml`.
- `src/init.ts` — wizard-running orchestrator (`runInit`). Idempotent: wizard skipped when already done; libraries matched by name; API keys matched by `App` label; premiere key matched against `ServerConfiguration.SupporterKey`; plugins matched by Name (version mismatch forces a re-install).
  - `InitLibraryDriftError`: existing library name + different path/collectionType. Thrown before any mutation.
  - `InitAuthMismatchError`: 401 on login after the wizard was already done (admin password differs from what was set).
  - `readSupporterKey(client)` / `registerPremiereKey(client, key)`: exported helpers reused by the `emby premiere` CLI commands.
- `src/plugins.ts` — plugin reconciliation helpers.
  - `reconcilePlugins(client, specs, { installTimeoutMs, installPollIntervalMs })`: for each spec, POST `/Packages/Installed/{Name}` when absent or when version differs, then poll `/Plugins` until it appears (or the requested Version is reflected). Returns `{ outcomes: PluginOutcome[], anyInstalled: boolean }`.
  - `resolvePluginId(client, idOrName)`: looks up an installed plugin by `Id` first, falls back to `Name`, raises `PluginNotFoundError` otherwise.
  - `uninstallPlugin(client, pluginId)`: thin wrapper over `DELETE /Plugins/{Id}`.
  - `PluginInstallTimeoutError`: thrown by `reconcilePlugins` when a plugin never appears within the timeout.
- `src/init-config.ts` — JSON config loader with `${VAR}` / `${VAR:-default}` interpolation and zod validation. Missing `${VAR}` without a default is a hard error.

## Commands exposed

`system {info,public-info,ping}`, `users {list,get}`, `items {list,search,get}`, `sessions list`, `libraries list`, `plugins {list,install,uninstall}`, `premiere {status,set}`, `login`, `init --config <path>`.

`emby items get` requires `--user-id` because Emby only exposes item details via the user-scoped route.

## Quirks

- **CLI tests use `program.exitOverride()`** so commander doesn't terminate the test process. The capturing IO records stdout/stderr/exit code instead.
- **Docker integration test** (`tests/init.integration.test.ts`) is gated by `EMBY_DOCKER_TESTS=1`. CI runs it in a dedicated job; local runs skip it unless the env var is set.
- **Idempotency**:
  - Re-running `emby init` against a server whose libraries match the config is a no-op.
  - Library drift (same name, different path or collection type) fails fast with `InitLibraryDriftError` before any mutation.
  - API keys are matched by their `App` label. An existing label reuses its token; only new labels create new keys.
  - Premiere key: `runInit` GETs `/System/Configuration` first and only POSTs `/Registrations/RegKey` when `SupporterKey` differs. `emby premiere set <key>` mirrors this logic. Emby's registration endpoint validates the key online and persists it back to `SupporterKey`, so read-after-write is consistent on subsequent runs. A 4xx from Emby (rejected key) propagates rather than being reported as success.
  - Plugins: `reconcilePlugins` identifies plugins by `Name`. Skipped when already installed at a matching (or unspecified) version; re-POSTed when `Version` differs; always POSTed when absent. Every mutation is followed by a `GET /Plugins` poll until the plugin (or the requested version) is reflected; `PluginInstallTimeoutError` is thrown on timeout. `restartAfterPlugins` only triggers `POST /System/Restart` when at least one plugin was actually installed or upgraded (a pure-skip run is a no-op).
- **`emby plugins install` option name**: the subcommand uses `--plugin-version`, not `--version`, because commander's top-level `--version` flag would otherwise shadow it and print `0.1.0` instead of taking a value. Any new subcommand that wants a "version" option should follow the same pattern.
- **Plugin repositories** (`ServerConfiguration.PluginRepositories`): out of scope. Add custom repos via Emby's UI.

## Cross-repo development

To test against an unreleased `@emby-utils/client`:

```bash
# In the emby-utils-client clone:
npm run build
npm link

# Here:
npm link @emby-utils/client
```

Unlink with `npm unlink --global @emby-utils/client`.

## Testing

- **Framework**: Vitest 4.x. MSW 2.x mocks Emby HTTP for unit tests.
- `tests/setup.ts`, `tests/msw-handlers.ts`, `tests/constants.ts`. Constants in a separate file to avoid circular imports.
- `onUnhandledRequest: "error"` — every outbound request must be handled.
- `tests/init.integration.test.ts` uses testcontainers to spin up a real `emby/embyserver:latest`. Gated by `EMBY_DOCKER_TESTS=1`.

## Releasing

Releases are tag-driven; a `v*` tag push triggers `.github/workflows/publish.yml` which runs the verify pipeline and then `npm publish --provenance`.

1. Bump `version` in `package.json` (e.g. `0.2.0`) and commit.
2. `git tag -a vX.Y.Z -m "vX.Y.Z"`, `git push origin main vX.Y.Z`.
3. The workflow enforces that the tag (minus the leading `v`) matches `package.json.version`; mismatch fails the publish fast. It runs lint, format check, build, and tests before publishing.
4. `npm publish` uses the `NPM_TOKEN` repo secret and `provenance: true` (requires `id-token: write`, already declared in the workflow).

When cutting a release that depends on a new `@emby-utils/client`, bump the `@emby-utils/client` semver range in `package.json` first and confirm `npm install` picks the correct tarball from `registry.npmjs.org`.

Local dry-run before tagging:

```bash
npm pack --dry-run   # verify tarball contents
npm publish --dry-run --provenance  # requires logged-in npm session
```

No changesets, no CHANGELOG automation. Write release notes in the git tag message if needed.

## CI

- `.github/workflows/ci.yml` — lint, format check, build, and test on Node `22.13.x`, `22.x`, and `latest`. A follow-on `integration` job runs the Docker integration test on Node 22.
- `.github/workflows/publish.yml` — triggered on `v*` tag push. Re-runs the full verify pipeline, then `npm publish --provenance --access public`. Needs the `NPM_TOKEN` repo secret.
- Neither workflow uses `npm ci` because `package-lock.json` is gitignored. This is a deliberate choice; if you add a lockfile to the repo, switch both workflows to `npm ci` for reproducible installs.
