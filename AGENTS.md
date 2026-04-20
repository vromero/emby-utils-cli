# Agent Guidelines — emby-utils-cli

## What this repo is

CLI tool `emby-utils-cli` (binary: `emby`), **not published to npm**. Consumers install it directly from GitHub:

```bash
npm install -g vromero/emby-utils-cli#v0.1.0
```

The `@emby-utils/client` dependency is also installed from GitHub (`github:vromero/emby-utils-client#v0.1.0`), pinned to a tag. Both repos build their `dist/` via a `prepare` script at install time.

A sibling MCP server ships from `vromero/emby-utils-mcp`.

## Setup & Environment

- ESM-only (`"type": "module"`). Use `.js` extensions in relative TypeScript imports (NodeNext resolution).
- Node >=22.13 (enforced in `engines`).
- The bin auto-loads `.env` from CWD if present; override path with `EMBY_ENV_FILE`. `emby` also accepts `--host` and `--api-key` flags.
- `package.json` is marked `"private": true` as a safeguard against accidental `npm publish`. Do not remove it without a deliberate decision to change distribution strategy.

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
- `src/init.ts` — wizard-running orchestrator (`runInit`). Idempotent: wizard skipped when already done; libraries matched by name; API keys matched by `App` label.
  - `InitLibraryDriftError`: existing library name + different path/collectionType. Thrown before any mutation.
  - `InitAuthMismatchError`: 401 on login after the wizard was already done (admin password differs from what was set).
- `src/init-config.ts` — JSON config loader with `${VAR}` / `${VAR:-default}` interpolation and zod validation. Missing `${VAR}` without a default is a hard error.

## Commands exposed

`system {info,public-info,ping}`, `users {list,get}`, `items {list,search,get}`, `sessions list`, `libraries list`, `plugins list`, `login`, `init --config <path>`.

`emby items get` requires `--user-id` because Emby only exposes item details via the user-scoped route.

## Quirks

- **CLI tests use `program.exitOverride()`** so commander doesn't terminate the test process. The capturing IO records stdout/stderr/exit code instead.
- **Docker integration test** (`tests/init.integration.test.ts`) is gated by `EMBY_DOCKER_TESTS=1`. CI runs it in a dedicated job; local runs skip it unless the env var is set.
- **Idempotency**:
  - Re-running `emby init` against a server whose libraries match the config is a no-op.
  - Library drift (same name, different path or collection type) fails fast with `InitLibraryDriftError` before any mutation.
  - API keys are matched by their `App` label. An existing label reuses its token; only new labels create new keys.

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

There is no npm publish. Releases are tag-only:

1. Bump the `version` field in `package.json` if desired (kept for `emby --version` output and discipline; no automation depends on it).
2. Commit.
3. Tag with `git tag -a vX.Y.Z -m "vX.Y.Z"` and push: `git push origin vX.Y.Z`.
4. Users install the tag via `npm i -g vromero/emby-utils-cli#vX.Y.Z`.

When cutting a release that depends on a new `@emby-utils/client`, bump the `github:vromero/emby-utils-client#vX.Y.Z` pin in `package.json` first and confirm a fresh `npm install` succeeds against the new pin.

## CI

`.github/workflows/ci.yml` runs lint, format check, build, and test on Node `22.13.x`, `22.x`, and `latest`. A follow-on `integration` job runs the Docker integration test on Node 22.
