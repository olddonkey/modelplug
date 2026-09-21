/**
 * Turn `--record` captures into committable fixtures.
 *
 *   node scripts/sanitize-captures.ts <captures-dir> <out-dir> --workspace <abs path> [--home <abs path>]
 *
 * For every `<stem>.request.json` it writes `<n>-<dialect>.request.json`,
 * `.response.sse` and `.meta.json` into <out-dir>, with:
 *   - the workspace path replaced by /workspace, the home path by /home/user, the username by `user`
 *   - every UUID replaced by a stable placeholder (same UUID, same placeholder)
 *   - `instructions` and developer-message text truncated to their first 240 characters
 *   - `encrypted_content` replaced by a same-length placeholder
 *   - `usage.attribution` removed from responses (kept only with --keep-attribution)
 *   - the tool catalog the server echoes in every `response.*` envelope emptied (kept only with --keep-tools)
 * and prints an index so the caller can pick and rename the interesting ones.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { workspace: { type: "string" }, home: { type: "string" }, user: { type: "string" }, "keep-attribution": { type: "boolean" }, "keep-tools": { type: "boolean" } },
});
const [inDir, outDir] = positionals;
if (!inDir || !outDir || !values.workspace) {
  console.error("usage: sanitize-captures.ts <captures-dir> <out-dir> --workspace <abs path> [--home <abs path>]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const uuidMap = new Map<string, string>();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
function scrub(text: string): string {
  let out = text.split(values.workspace!).join("/workspace");
  if (values.home) out = out.split(values.home).join("/home/user");
  if (values.user) out = out.replace(new RegExp(`\\b${values.user}\\b`, "g"), "user");
  return out.replace(UUID, m => {
    const key = m.toLowerCase();
    if (!uuidMap.has(key)) uuidMap.set(key, `00000000-0000-4000-8000-${String(uuidMap.size + 1).padStart(12, "0")}`);
    return uuidMap.get(key)!;
  });
}
const TRUNCATE = 240;
function truncate(text: string): string {
  return text.length <= TRUNCATE ? text : `${text.slice(0, TRUNCATE)}…[truncated ${text.length - TRUNCATE} chars]`;
}
function placeholderBlob(length: number): string {
  return Buffer.from("fixture-encrypted-content-placeholder-".repeat(Math.ceil(length / 50))).toString("base64").slice(0, Math.max(16, length));
}
function scrubItem(item: Record<string, unknown>): void {
  if (item.type === "message" && item.role === "developer" && Array.isArray(item.content)) {
    for (const part of item.content as Array<Record<string, unknown>>) {
      if (typeof part.text === "string") part.text = truncate(part.text);
    }
  }
  if (item.type === "reasoning" && typeof item.encrypted_content === "string") {
    item.encrypted_content = placeholderBlob((item.encrypted_content as string).length);
  }
}

const stems = readdirSync(inDir).filter(f => f.endsWith(".request.json")).map(f => f.slice(0, -".request.json".length)).sort();
let n = 0;
for (const stem of stems) {
  const request = JSON.parse(readFileSync(join(inDir, `${stem}.request.json`), "utf8")) as Record<string, unknown>;
  const dialect = typeof request.instructions === "string" ? "classic" : "lite";
  if (typeof request.instructions === "string") request.instructions = truncate(request.instructions);
  for (const item of (request.input as Array<Record<string, unknown>>) ?? []) scrubItem(item);
  const meta = JSON.parse(readFileSync(join(inDir, `${stem}.meta.json`), "utf8")) as { request: { headers: Record<string, unknown> }; response?: { status?: number } };
  const status = meta.response?.status;

  const sseLines = readFileSync(join(inDir, `${stem}.response.sse`), "utf8").split("\n");
  const sseOut = sseLines.map(line => {
    if (!line.startsWith("data: ")) return line;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line.slice(6)) as Record<string, unknown>;
    } catch {
      return line;
    }
    const response = data.response as Record<string, unknown> | undefined;
    if (response?.usage && !values["keep-attribution"]) delete (response.usage as Record<string, unknown>).attribution;
    if (response && Array.isArray(response.tools) && response.tools.length > 0 && !values["keep-tools"]) response.tools = [];
    if (response && typeof response.instructions === "string") response.instructions = truncate(response.instructions);
    if (response && Array.isArray(response.output)) for (const item of response.output as Array<Record<string, unknown>>) scrubItem(item);
    if (data.item && typeof data.item === "object") scrubItem(data.item as Record<string, unknown>);
    return `data: ${JSON.stringify(data)}`;
  });

  n += 1;
  const out = `${String(n).padStart(3, "0")}-${dialect}`;
  writeFileSync(join(outDir, `${out}.request.json`), scrub(JSON.stringify(request, null, 2)) + "\n");
  writeFileSync(join(outDir, `${out}.response.sse`), scrub(sseOut.join("\n")));
  writeFileSync(join(outDir, `${out}.meta.json`), scrub(JSON.stringify(meta, null, 2)) + "\n");

  const items = (request.input as Array<{ type: string; name?: string }>) ?? [];
  const kinds = items.filter(i => i.type !== "message").map(i => i.type + (i.name ? `(${i.name})` : ""));
  console.log(`${out}  status=${status ?? "?"}  model=${request.model}  messages=${items.length - kinds.length}  ${kinds.join(" ")}`);
}
console.log(`\n${n} captures written to ${outDir}; ${uuidMap.size} distinct UUIDs replaced (source stems like ${basename(stems[0] ?? "")})`);
