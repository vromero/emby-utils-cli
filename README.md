# emby-utils-cli

Semantic command-line interface for the [Emby](https://emby.media/) REST API.
Built on [commander](https://github.com/tj/commander.js) on top of
[`@emby-utils/client`](https://github.com/vromero/emby-utils-client).

> This project is **not published to npm**. Install directly from GitHub.

## Install

Install globally from the GitHub repo, pinned to a released tag:

```bash
npm install -g vromero/emby-utils-cli#v0.1.0
```

Or, without a global install, use `npx` against a cloned checkout:

```bash
git clone https://github.com/vromero/emby-utils-cli.git
cd emby-utils-cli
npm install
npm run build
node dist/bin.js --help
```

`npm install` runs the `prepare` script which builds `dist/` automatically.
The `@emby-utils/client` dependency is also resolved straight from GitHub
(pinned to a tag in `package.json`), so there is no npm registry involved
at any point.

To upgrade, re-run the install command with a new tag (e.g. `#v0.2.0`).

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
  "requireFresh": false,
  "refreshLibraries": false
}
```

Each entry in `apiKeys` is the Emby "App" label used to identify the key.
On re-runs, keys with a matching label are reused (their existing token is
returned) rather than duplicated.

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
  "apiKeysSkipped": []
}
```

Capture the token into an env var:

```bash
export EMBY_API_KEY=$(emby init --config ./emby.init.json | jq -r .accessToken)
```

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
