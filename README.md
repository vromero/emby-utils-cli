# @emby-utils/cli

Semantic command-line interface for the [Emby](https://emby.media/) REST API.
Built on [commander](https://github.com/tj/commander.js) on top of
[`@emby-utils/client`](https://www.npmjs.com/package/@emby-utils/client).

## Install

Install globally from npm:

```bash
npm install -g @emby-utils/cli
```

The binary is named `emby`. Run `emby --help` to confirm the install:

```bash
emby --version
emby --help
```

Or, without a global install, run ad-hoc via `npx`:

```bash
npx -p @emby-utils/cli emby --help
```

### From source

For local development or to try an unreleased build:

```bash
git clone https://github.com/vromero/emby-utils-cli.git
cd emby-utils-cli
npm install
npm run build
node dist/bin.js --help
```

`npm install` runs the `prepare` script which builds `dist/` automatically.

## Configure

Set credentials via env vars or flags:

```bash
export EMBY_HOST=http://emby.local:8096
export EMBY_API_KEY=your-api-key
```

A local `.env` file in the working directory is auto-loaded if present.
Set `EMBY_ENV_FILE=/custom/path/.env` to point elsewhere.

## Usage

```bash
emby --help

# System
emby system info
emby system public-info
emby system ping

# Users
emby users list
emby users get <userId>

# Items
emby items list --user-id <id> --limit 20
emby items search "matrix"
emby items get <itemId> --user-id <userId>

# Sessions / libraries / plugins
emby sessions list
emby libraries list
emby plugins list
emby plugins install Trakt --plugin-version 1.2.3 --update-class Beta
emby plugins uninstall Trakt

# Emby Premiere (supporter) key
emby premiere status
emby premiere set MB-XXXX-XXXX-XXXX

# Login (prints an access token)
export EMBY_API_KEY=$(emby login --username alice --password ...)
```

### Initialize a fresh Emby server

`emby init` walks a just-installed Emby through its first-run wizard and
adds the libraries you specify. It reads its inputs from a **JSON config
file** (via `--config`) rather than per-flag options so that the full
desired state of your server lives in one reviewable artefact.

### Idempotency

Re-running `emby init` against an already-initialized server is safe:

- The first-run wizard is skipped (detected via `/Startup/Configuration`
  returning 401 to unauthenticated requests).
- Libraries already present with a **matching name, path, and collection
  type** are left untouched and reported under `librariesSkipped`.
- Only libraries missing from Emby are created.

If the wizard was completed earlier but the admin password in your config
does not match what was set then, `init` fails fast with
`InitAuthMismatchError` (HTTP 401 on the login step) rather than silently
half-applying state.

If a library in your config shares its **name** with an existing library
but has a **different path or collection type**, `init` refuses to
reconcile automatically and raises `InitLibraryDriftError` before any
mutation. Rename the library in your config or delete the drifted one in
Emby's UI, then rerun. Updating paths or collection types of existing
libraries is out of scope for `init`.

```bash
emby init --host http://emby.local:8096 --config ./emby.init.json
```

Example `emby.init.json`:

```json
{
  "adminUsername": "admin",
  "adminPassword": "${EMBY_ADMIN_PW}",
  "uiCulture": "en-US",
  "metadataCountry": "US",
  "metadataLanguage": "en",
  "libraries": [
    { "name": "Movies", "path": "/data/movies", "collectionType": "movies" },
    { "name": "TV Shows", "path": "/data/tv", "collectionType": "tvshows" },
    { "name": "Music", "path": "/data/music", "collectionType": "music" }
  ],
  "apiKeys": ["home-assistant", "mcp-server"],
  "premiereKey": "${EMBY_PREMIERE_KEY}",
  "plugins": [
    { "name": "Trakt" },
    { "name": "TVHeadEnd", "version": "1.2.3", "updateClass": "Release" }
  ],
  "restartAfterPlugins": true,
  "requireFresh": false,
  "refreshLibraries": false
}
```

Each entry in `apiKeys` is the Emby "App" label used to identify the key.
On re-runs, keys with a matching label are reused (their existing token is
returned) rather than duplicated.

`premiereKey` is optional. When present, `init` registers the key via
`POST /Registrations/RegKey`. It is idempotent: the current
`ServerConfiguration.SupporterKey` is read first and the registration
request is skipped when the server already reports the same value. An
invalid key causes the Emby registration endpoint to return 4xx and the
error propagates — `init` does not silently treat a rejected key as
success.

`plugins` is optional. Each entry names an Emby catalog package; `init`
calls `POST /Packages/Installed/{Name}` and then polls `/Plugins` until
the plugin appears (or, for an upgrade, until the installed `Version`
matches the requested one). Idempotency rules:

- If no plugin with that `name` is installed, it is installed fresh
  (`status: "installed"`).
- If a plugin with that `name` is installed and either `version` is
  omitted or matches, it is left alone (`status: "skipped"`).
- If a plugin with that `name` is installed but its version differs from
  the requested one, `init` re-POSTs to `/Packages/Installed/{Name}`
  with the new version and waits for the upgrade to be reflected in
  `/Plugins` (`status: "upgraded"`).

The optional `version`, `updateClass` (`Release`, `Beta`, `Dev`), and
`assemblyGuid` fields are forwarded to Emby's package endpoint as-is.
Polling defaults can be tuned via `pluginInstallTimeoutMs` (default
120 000) and `pluginInstallPollIntervalMs` (default 2 000); a plugin that
never appears within the timeout raises `PluginInstallTimeoutError`.

Most plugins require a server restart to become active. Set
`"restartAfterPlugins": true` to have `init` issue `POST /System/Restart`
at the end of a run — but only when at least one plugin was newly
installed or upgraded. A pure-skip run is a no-op and never restarts.
Plugin-repository configuration (`ServerConfiguration.PluginRepositories`)
is out of scope; use Emby's UI to add custom repos.

Environment-variable placeholders are expanded at load time:

- `${VAR}` — expands to the value of `VAR`; **errors** if unset or empty.
- `${VAR:-default}` — expands to the default when `VAR` is unset or empty.
- `$$` — escape for a literal `$`.

Missing variables fail the run rather than silently using an empty string,
so an unset `${EMBY_ADMIN_PW}` won't quietly provision a blank password.

The config schema is validated before any network calls are made. Unknown
top-level fields and malformed library entries produce precise errors
(e.g. `libraries.0.path: library path must not be empty`).

Output (JSON):

```json
{
  "wizardRan": true,
  "accessToken": "abc123...",
  "librariesCreated": ["Movies", "TV Shows", "Music"],
  "librariesSkipped": [],
  "apiKeysCreated": [
    { "app": "home-assistant", "token": "..." },
    { "app": "mcp-server", "token": "..." }
  ],
  "apiKeysSkipped": [],
  "premiereKey": { "requested": true, "updated": true, "skipped": false },
  "plugins": [
    { "name": "Trakt", "version": "1.0.0", "id": "plugin-1", "status": "installed" },
    { "name": "TVHeadEnd", "version": "1.2.3", "id": "plugin-2", "status": "installed" }
  ],
  "serverRestarted": true
}
```

When no `premiereKey` is configured, the field is `{ "requested": false }`.
On a re-run where the key is already registered, it reads
`{ "requested": true, "updated": false, "skipped": true }`.

Capture the token into an env var:

```bash
export EMBY_API_KEY=$(emby init --config ./emby.init.json | jq -r .accessToken)
```

### Install and uninstall plugins directly

For already-initialized servers, plugins can be installed one at a time
without running `emby init`:

```bash
# Install latest release. Waits for the plugin to show up in /Plugins.
emby plugins install Trakt

# Install an exact version from the Beta channel.
emby plugins install Trakt --plugin-version 1.2.3 --update-class Beta

# Skip the wait after POSTing to /Packages/Installed/{Name}.
emby plugins install Trakt --no-wait

# Tune the wait loop.
emby plugins install Trakt --timeout-ms 60000 --poll-interval-ms 1000

# Remove a plugin by Name or Id.
emby plugins uninstall Trakt
emby plugins uninstall 00000000-0000-0000-0000-000000000001

# A missing plugin is an error by default; --if-present makes it a no-op.
emby plugins uninstall Trakt --if-present
```

`install` is idempotent: `status` in the output is `installed` on a fresh
install, `upgraded` when the installed `Version` didn't match `--plugin-version`,
or `skipped` when the plugin was already present at an acceptable version.
The option is spelled `--plugin-version` rather than `--version` to avoid
colliding with the program's top-level `--version` flag. `uninstall`
accepts either an Emby plugin `Id` or the plugin `Name`; Names are
resolved against `GET /Plugins` before deletion.

Plugin installs are asynchronous on Emby's side and most plugins require
a server restart to be picked up. `emby plugins install` never restarts
the server — restart it yourself via the Emby UI when you're ready.
`emby init` can optionally restart once at the end of a run via
`"restartAfterPlugins": true`.

### Manage the Emby Premiere key directly

For already-initialized servers, the key can be installed or rotated
without running `emby init`:

```bash
emby premiere status
# { "supporterKey": "MB-...", "registered": true }

emby premiere set MB-XXXX-XXXX-XXXX
# { "supporterKey": "MB-XXXX-XXXX-XXXX", "updated": true, "skipped": false }

# A second call with the same key short-circuits without hitting
# /Registrations/RegKey:
emby premiere set MB-XXXX-XXXX-XXXX
# { "supporterKey": "MB-XXXX-XXXX-XXXX", "updated": false, "skipped": true }
```

Both subcommands need the usual admin credentials (`--api-key` or
`EMBY_API_KEY`) because the underlying `/System/Configuration` and
`/Registrations/RegKey` endpoints are admin-only.

### Output formats

```bash
emby users list --format json          # default
emby users list --format yaml
emby users list --format table
emby users list --format table --columns Id,Name
```

### Host / key overrides

```bash
emby --host http://other:8096 --api-key ABC users list
```

## License

MIT
