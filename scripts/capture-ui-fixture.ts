// §11 Phase 5a — fixture capture for the UI browser smoke, with a MECHANICAL
// no-secrets gate (reviewer condition: the committed fixture must come from a
// controlled real TUI session with non-secret content — enforced here, not
// eyeballed).
//
// Reads a smoke daemon's store JSON, scans every byte for credential patterns,
// and REFUSES to write the fixture if anything matches. The store schema itself
// carries no auth material (frames hold message/system/tool content; headers
// live only in the wiretap, which is never captured as a fixture) — this scan
// is the belt to that suspenders. Conversation keys / anchorFps are content
// hashes, not secrets, and are allowed.
//
// Usage: bun run scripts/capture-ui-fixture.ts <store.json> [out.json]

const src = process.argv[2];
const out = process.argv[3] ?? "test/fixtures/ui-smoke-store.json";
if (!src) {
  console.error("usage: bun run scripts/capture-ui-fixture.ts <store.json> [out.json]");
  process.exit(2);
}

const text = await Bun.file(src).text();

// Credential shapes, not credential words: prose like "Add OAuth authentication"
// in tool-description text is fine; an actual token is not.
const CREDENTIAL_PATTERNS: [string, RegExp][] = [
  ["anthropic key", /sk-ant-[A-Za-z0-9_-]{10,}/],
  ["generic sk- key", /sk-[A-Za-z0-9]{20,}/],
  ["github token", /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/],
  ["github fine-grained PAT", /github_pat_[A-Za-z0-9_]{20,}/],
  ["slack token", /xox[abprs]-[A-Za-z0-9-]{10,}/],
  ["aws access key id", /AKIA[0-9A-Z]{16}/],
  ["jwt", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["bearer header value", /Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/],
  ["authorization header field", /"authorization"\s*:/i],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

const hits: string[] = [];
for (const [label, re] of CREDENTIAL_PATTERNS) {
  const m = text.match(re);
  if (m) hits.push(`${label}: …${m[0]!.slice(0, 12)}…`);
}
if (hits.length > 0) {
  console.error("REFUSING to write fixture — credential-shaped content found:");
  for (const h of hits) console.error(`  - ${h}`);
  process.exit(1);
}

// Validate it parses and looks like a registry snapshot before writing.
const parsed = JSON.parse(text) as Record<string, unknown>;
if (!parsed || typeof parsed !== "object" || !("conversations" in parsed)) {
  console.error("input does not look like a registry store snapshot");
  process.exit(1);
}

await Bun.write(out, text);
console.log(`fixture written: ${out} (${text.length} bytes, credential scan clean)`);
