import { buildCli, CliIO } from "../src/index.js";
import { EMBY_API_KEY, EMBY_HOST } from "./setup.js";

export interface CapturedIO {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  io: CliIO;
}

export function makeIO(): CapturedIO {
  const state: CapturedIO = {
    stdout: [],
    stderr: [],
    exitCode: null,
    io: {
      stdout: (l) => state.stdout.push(l),
      stderr: (l) => state.stderr.push(l),
      exit: (code) => {
        state.exitCode = code;
      },
    },
  };
  return state;
}

/** Run the CLI with the given arguments. Always provides credentials. */
export async function runCli(args: string[]): Promise<CapturedIO> {
  const capture = makeIO();
  const program = buildCli({ io: capture.io });
  program.exitOverride();
  try {
    await program.parseAsync(["--host", EMBY_HOST, "--api-key", EMBY_API_KEY, ...args], {
      from: "user",
    });
  } catch {
    // commander throws on exitOverride; capture.exitCode holds the final code
  }
  return capture;
}
