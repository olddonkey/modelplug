#!/usr/bin/env node
// Published entry: runs the compiled tree. During development use `node src/main.ts`.
import("../dist/main.js").then(m => m.main(process.argv.slice(2))).catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
