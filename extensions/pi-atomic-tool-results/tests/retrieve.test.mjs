import test from "node:test";
import assert from "node:assert/strict";
import { boundValue, renderBoundedSelection, selectArchiveValue } from "../lib/retrieve.js";

const archive = {
  resultRef: "result:r1",
  toolName: "tool",
  content: [{ type: "text", text: JSON.stringify({ hosts: [{ ip: "1" }, { ip: "2" }, { ip: "3" }], status: "ok" }) }],
  structuredContent: { rows: [{ id: 1 }, { id: 2 }] },
  details: { nested: { count: 3 } },
  input: { target: "lan" },
};

test("selectors address parsed JSON, details, input and content", () => {
  assert.equal(selectArchiveValue(archive, "json.status"), "ok");
  assert.deepEqual(selectArchiveValue(archive, "json.hosts.1"), { ip: "2" });
  assert.equal(selectArchiveValue(archive, "details.nested.count"), 3);
  assert.equal(selectArchiveValue(archive, "structured.rows.1.id"), 2);
  assert.equal(selectArchiveValue(archive, "input.target"), "lan");
  assert.match(selectArchiveValue(archive, "content.0.text"), /hosts/);
});

test("array retrieval paginates rather than hydrating the complete payload", () => {
  const result = renderBoundedSelection(archive, "json.hosts", { offset: 1, limit: 1, maxChars: 1000 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [{ ip: "2" }]);
  assert.equal(result.truncated, true);
  assert.equal(result.nextOffset, 2);
  assert.equal(result.totalItems, 3);
});

test("string retrieval is bounded by maxChars", () => {
  const result = boundValue("abcdefghij", { offset: 2, maxChars: 4 });
  assert.equal(result.value, "cd");
  assert.equal(result.truncated, true);
  assert.equal(result.nextOffset, 4);
});
