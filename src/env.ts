/**
 * Loads a `.env` file into `process.env` without overriding values that
 * are already set. Resolution order:
 *   1. `EMBY_ENV_FILE` (explicit path)
 *   2. `./.env` in the current working directory
 *
 * Uses Node's built-in `process.loadEnvFile` (Node 20.6+), so no runtime
 * dependency is required.
 */
import { existsSync } from "node:fs";

export function loadEnv(): void {
  const explicit = process.env.EMBY_ENV_FILE;
  const candidate = explicit ?? ".env";
  if (!existsSync(candidate)) return;
  try {
    (process as unknown as { loadEnvFile: (path: string) => void }).loadEnvFile(candidate);
  } catch (err) {
    console.error(`[emby] failed to load env file '${candidate}':`, err);
  }
}
