import test from "node:test";
import assert from "node:assert/strict";
import { CUSTOM_TYPE, archivesFromBranch, makeArchive, resultRef, sanitizeInput } from "../lib/archive.js";

test("archive preserves exact tool result content and details while sanitizing secret-shaped input keys", () => {
  const event = {
    toolCallId: "call-1",
    toolName: "mcp__security__discover_mdns_subnets",
    input: { interface: "wlp3s0", api_key: "secret", nested: { password: "nope", keep: 7 } },
    content: [{ type: "text", text: JSON.stringify({ status: "observed", hosts: [1, 2, 3] }) }],
    structuredContent: { machine: [1, 2] },
    details: { exact: { a: 1 } },
    isError: false,
  };
  const archive = makeArchive(event);
  assert.equal(archive.resultRef, resultRef("call-1"));
  assert.deepEqual(archive.content, event.content);
  assert.deepEqual(archive.details, event.details);
  assert.deepEqual(archive.structuredContent, event.structuredContent);
  assert.equal(archive.input.api_key, "[redacted]");
  assert.equal(archive.input.nested.password, "[redacted]");
  assert.equal(archive.input.nested.keep, 7);
  assert.ok(archive.sizeBytes > 0);
});

test("archivesFromBranch uses only Pi custom entries on the active branch", () => {
  const entry = {
    type: "custom",
    id: "entry-a",
    customType: CUSTOM_TYPE,
    data: { resultRef: "result:call-a", toolCallId: "call-a", toolName: "x", timestamp: 1 },
  };
  const map = archivesFromBranch([
    { type: "message", id: "msg", message: {} },
    entry,
    { type: "custom", id: "other", customType: "unrelated", data: { resultRef: "result:no" } },
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get("result:call-a").entryId, "entry-a");
});

test("sanitizeInput handles nested secret keys", () => {
  assert.deepEqual(sanitizeInput({ Authorization: "Bearer x", ok: [1, { token: "x", name: "n" }] }), {
    Authorization: "[redacted]",
    ok: [1, { token: "[redacted]", name: "n" }],
  });
});
