/**
 * The whole architecture in one grep: nothing outside a wire module names a
 * provider. A provider difference is a `Capabilities` value or a fixture-backed
 * middleware inside the wire that needs it, never a branch in the kernel.
 *
 * Exempt, with the reason:
 *   - src/wire/**         the wires are where providers are allowed to exist
 *   - src/credentials/**  the credential layer is provider-specific by design
 *                         (ChatGPT login, token endpoint, quota headers)
 *   - src/presets.json    the table of providers itself
 *   - src/main.ts         the CLI: help text names example presets, and the
 *                         login/logout/account commands name the credential kind
 *   - src/record.ts       development tooling behind --forward, not the product path
 *
 * Wire names (`openai-chat`, `openai-responses`, `anthropic`, `gemini`) are
 * not provider names and are allowed anywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPresets, WIRES } from "../src/config.ts";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const EXEMPT_DIRS = ["wire", "credentials"];
const EXEMPT_FILES = ["main.ts", "record.ts"];
const VENDORS = ["deepseek", "kimi", "moonshot", "qwen", "zhipu", "openai", "anthropic", "google", "xai", "chatgpt"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

/** Double-, single- and back-quoted literals; nested templates are rare enough for a grep. */
function stringLiterals(source: string): string[] {
  const out: string[] = [];
  const re = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) out.push(match[0].slice(1, -1));
  return out;
}

test("no provider name outside src/wire, src/credentials and the CLI", () => {
  const forbidden = new Set([...Object.keys(loadPresets()), ...VENDORS].map(n => n.toLowerCase()));
  const wireNames = new Set<string>(WIRES);
  const hyphenatedWires = [...wireNames].filter(w => w.includes("-"));
  const word = new RegExp(`\\b(${[...forbidden].join("|")})\\b`, "i");

  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file).split(sep).join("/");
    if (EXEMPT_DIRS.some(d => rel.startsWith(`${d}/`)) || EXEMPT_FILES.includes(rel)) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    for (const literal of stringLiterals(source)) {
      if (wireNames.has(literal)) continue;
      let text = literal;
      for (const wire of hyphenatedWires) text = text.split(wire).join(" ");
      const hit = word.exec(text);
      if (hit) offenders.push(`${rel}: "${literal.length > 80 ? `${literal.slice(0, 77)}...` : literal}" names ${hit[1]}`);
    }
  }
  assert.deepEqual(offenders, [], `provider names leaked outside the wires:\n  ${offenders.join("\n  ")}`);
});
