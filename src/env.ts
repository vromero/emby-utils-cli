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

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface Process {
      loadEnvFile(path: string): void;
    }
  }
}

export function loadEnv(): void {
  const explicit = process.env.EMBY_ENV_FILE;
  const candidate = explicit ?? ".env";
  if (!existsSync(candidate)) return;
  try {
    process.loadEnvFile(candidate);
  } catch (err) {
    console.error(`[emby] failed to load env file '${candidate}':`, err);
  }
}
