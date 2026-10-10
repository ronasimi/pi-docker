import test from "node:test";
import assert from "node:assert/strict";
import { searchArchives } from "../lib/search.js";

const archives = new Map([
  ["result:a", { resultRef: "result:a", entryId: "e1", toolName: "mdns", isError: false, timestamp: 2, sizeBytes: 10, content: [{ type: "text", text: "outside subnet advertisement 192.168.20.2" }] }],
  ["result:b", { resultRef: "result:b", entryId: "e2", toolName: "dns", isError: false, timestamp: 1, sizeBytes: 10, content: [{ type: "text", text: "CAA record example.org" }] }],
]);

test("search returns bounded refs and snippets without hydrating all results", () => {
  const out = searchArchives(archives, { query: "outside subnet", limit: 5 });
  assert.equal(out.length, 1);
  assert.equal(out[0].resultRef, "result:a");
  assert.match(out[0].snippet, /outside subnet/);
});

test("search can filter by exact tool name", () => {
  assert.equal(searchArchives(archives, { query: "record", tool: "mdns" }).length, 0);
  assert.equal(searchArchives(archives, { query: "record", tool: "dns" }).length, 1);
});
