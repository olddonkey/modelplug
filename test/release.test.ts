import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("release: prepublishOnly runs check and propagates its failure without publishing", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const exitCode of [17, 0]) {
    const dir = mkdtempSync(join(tmpdir(), "modelplug-publish-gate-"));
    try {
      // Keep the real lifecycle hook; replace only the expensive check with a
      // deterministic failing/passing check. Never invoke npm publish.
      writeFileSync(join(dir, "package.json"), JSON.stringify({
        name: "modelplug-publish-gate-test", version: "0.0.0", private: true,
        scripts: { ...manifest.scripts, check: "node check.cjs" },
      }));
      writeFileSync(join(dir, "check.cjs"), `require("node:fs").writeFileSync("check-ran", "yes"); process.exit(${exitCode});`);
      const npmCli = process.env.npm_execpath;
      const args = ["run", "prepublishOnly", "--if-present"];
      const result = spawnSync(npmCli ? process.execPath : "npm", npmCli ? [npmCli, ...args] : args, {
        cwd: dir, encoding: "utf8", timeout: 30_000,
        shell: !npmCli && process.platform === "win32",
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, exitCode, result.stdout + result.stderr);
      assert.equal(readFileSync(join(dir, "check-ran"), "utf8"), "yes");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
