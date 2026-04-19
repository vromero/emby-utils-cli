# Agent Guidelines — @emby-utils/cli

## What this repo is

Standalone npm package `@emby-utils/cli` (binary: `emby`). Semantic command-line interface for the Emby REST API. Depends on the separately-published `@emby-utils/client` (GitHub: `vromero/emby-utils-client`). A sibling MCP server ships from `vromero/emby-utils-mcp`.

## Setup & Environment

- ESM-only (`"type": "module"`). Use `.js` extensions in relative TypeScript imports (NodeNext resolution).
- Node >=22.13 (enforced in `engines`).
- The bin auto-loads `.env` from CWD if present; override path with `EMBY_ENV_FILE`. `emby` also accepts `--host` and `--api-key` flags.

## Commands

- `npm install` — deps.
- `npm run build` — `tsc -p tsconfig.build.json`.
- `npm start` — runs the compiled CLI.
- `npm test` — Vitest.
- `npm run lint` / `lint:fix`, `npm run format` / `format:check`.
- `npm run release:dry` — preview publish.

## Architecture

- `src/bin.ts` — entrypoint. Loads env, builds the program, parses argv.
- `src/index.ts` — exports `buildCli({ io, clientFactory })`. Tests inject a capturing IO.
- `src/format.ts` — `--format json|yaml|table` renderer. Table uses `cli-table3`; yaml uses `yaml`.
- `src/init.ts` — wizard-running orchestrator (`runInit`). Idempotent: wizard skipped when already done; libraries matched by name.
  - `InitLibraryDriftError`: existing library name + different path/collectionType. Thrown before any mutation.
  - `InitAuthMismatchError`: 401 on login after the wizard was already done (admin password differs from what was set).
- `src/init-config.ts` — JSON config loader with `${VAR}` / `${VAR:-default}` interpolation and zod validation. Missing `${VAR}` without a default is a hard error.

## Commands exposed

`system {info,public-info,ping}`, `users {list,get}`, `items {list,search,get}`, `sessions list`, `libraries list`, `plugins list`, `login`, `init --config <path>`.

`emby items get` requires `--user-id` because Emby only exposes item details via the user-scoped route.

## Quirks

- **CLI tests use `program.exitOverride()`** so commander doesn't terminate the test process. The capturing IO records stdout/stderr/exit code instead.
- **Docker integration test** (`tests/init.integration.test.ts`) is gated by `EMBY_DOCKER_TESTS=1`. CI runs it in a dedicated job; local runs skip it unless the env var is set.
- **Idempotency**: re-running `emby init` against a server whose libraries match the config is a no-op. Drift (same library name, different path or collection type) fails fast before any mutation.

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

## Publishing

- `publishConfig.access: "public"`. Versioning via **changesets**.
- Flow: `npx changeset` → describe → `npm run version` → `npm run release:dry` → `npm run release`.

## CI

`.github/workflows/ci.yml` runs lint, format check, build, and test on Node `22.13.x`, `22.x`, and `latest`. A follow-on `integration` job runs the Docker integration test on Node 22.
