#!/usr/bin/env node
import { buildCli } from "./index.js";
import { loadEnv } from "./env.js";

loadEnv();
const program = buildCli();
program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
