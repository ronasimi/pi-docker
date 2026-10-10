import test from "node:test";
import assert from "node:assert/strict";
import { compactHistoricalToolResults } from "../lib/context.js";
import { compactEnvelope } from "../lib/compact.js";

const config = { previewChars: 1200, historicalEnvelopeChars: 400 };
const archive = {
  resultRef: "result:c1",
  toolCallId: "c1",
  toolName: "big_tool",
  isError: false,
  sizeBytes: 10000,
  content: [{ type: "text", text: "x".repeat(5000) }],
};
const archives = new Map([[archive.resultRef, archive]]);

test("already-atomic normal results remain byte-stable across every context construction", () => {
  const stableContent = compactEnvelope(archive, { previewChars: config.previewChars });
  const persisted = [{
    role: "toolResult",
    toolCallId: "c1",
    toolName: "big_tool",
    content: stableContent,
    details: { atomic: true, resultRef: "result:c1", archivedBytes: 10000 },
    isError: false,
    timestamp: 1,
  }];
  const first = compactHistoricalToolResults(persisted, archives, new Map(), new Map(), new Set(), config);
  const second = compactHistoricalToolResults(persisted, archives, new Map(), new Map(), new Set(), config);
  assert.strictEqual(first, persisted);
  assert.strictEqual(second, persisted);
  assert.equal(first[0].content[0].text, stableContent[0].text);
});

test("legacy raw transcript result with an archive is compacted to the normal stable envelope", () => {
  const raw = [{ role: "toolResult", toolCallId: "c1", toolName: "big_tool", content: archive.content, details: {}, isError: false, timestamp: 1 }];
  const out = compactHistoricalToolResults(raw, archives, new Map(), new Map(), new Set(), config);
  assert.notStrictEqual(out, raw);
  assert.match(out[0].content[0].text, /result:c1/);
  assert.equal(out[0].details.atomic, true);
  assert.equal(out[0].details.resultRef, "result:c1");
});

test("result_get slice is visible for repeated requests without expiring", () => {
  const persisted = [{
    role: "toolResult",
    toolCallId: "g1",
    toolName: "result_get",
    content: [{ type: "text", text: '{"atomic_result_lease":{"status":"leased"}}' }],
    details: { atomicSourceRef: "result:c1", atomicLease: true },
    isError: false,
    timestamp: 1,
  }];
  const leases = new Map([["g1", 1]]);
  const ephemeral = new Map([["g1", { content: [{ type: "text", text: "hydrated slice" }], details: { atomicSourceRef: "result:c1" }, isError: false }]]);
  const first = compactHistoricalToolResults(persisted, archives, leases, ephemeral, new Set(), config);
  assert.equal(first[0].content[0].text, "hydrated slice");
  assert.equal(leases.get("g1"), 1);
  assert.equal(ephemeral.has("g1"), true);
  const second = compactHistoricalToolResults(persisted, archives, leases, ephemeral, new Set(), config);
  assert.equal(second[0].content[0].text, "hydrated slice");
  assert.equal(second[0].details.atomicSourceRef, "result:c1");
});

test("result_search and result_list remain stable because their outputs are already bounded", () => {
  const messages = [
    { role: "toolResult", toolCallId: "s1", toolName: "result_search", content: [{ type: "text", text: "bounded search" }], details: {}, isError: false },
    { role: "toolResult", toolCallId: "l1", toolName: "result_list", content: [{ type: "text", text: "bounded list" }], details: {}, isError: false },
  ];
  const out = compactHistoricalToolResults(messages, archives, new Map(), new Map(), new Set(), config);
  assert.strictEqual(out, messages);
});

test("archive persistence failure fails open and leaves raw evidence unchanged", () => {
  const raw = [{ role: "toolResult", toolCallId: "failed-archive", toolName: "tool", content: [{ type: "text", text: "R".repeat(5000) }], details: {}, isError: false, timestamp: 1 }];
  const out = compactHistoricalToolResults(raw, new Map(), new Map(), new Map(), new Set(["failed-archive"]), config);
  assert.strictEqual(out, raw);
  assert.equal(out[0].content[0].text.length, 5000);
});
