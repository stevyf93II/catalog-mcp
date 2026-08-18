import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

import { dotPath, extractRecords, makeCatalogSource } from "../src/load.js";

// ── extractRecords ──

test("root array is used directly", () => {
  assert.deepEqual(extractRecords([{ a: 1 }]), [{ a: 1 }]);
});

test("single top-level array of objects is auto-detected", () => {
  const doc = { generated_at: "x", items: [{ a: 1 }, { a: 2 }] };
  assert.equal(extractRecords(doc).length, 2);
});

test("explicit dot-path wins", () => {
  const doc = { data: { units: [{ a: 1 }] } };
  assert.deepEqual(extractRecords(doc, "data.units"), [{ a: 1 }]);
  assert.equal(dotPath(doc, "data.missing"), undefined);
});

test("ambiguous document refuses with the candidate keys named", () => {
  const doc = { units: [{ a: 1 }], sold: [{ b: 2 }] };
  assert.throws(() => extractRecords(doc), /units, sold|sold, units/);
});

test("no array anywhere refuses with guidance", () => {
  assert.throws(() => extractRecords({ meta: 1 }), /CATALOG_RECORDS_PATH/);
});

test("bad path refuses", () => {
  assert.throws(() => extractRecords({ items: [] }, "nope"), /did not resolve/);
});

// ── makeCatalogSource: file ──

test("file source loads, caches, and reports meta", async () => {
  const dir = await mkdtemp(join(tmpdir(), "catmcp-"));
  const file = join(dir, "cat.json");
  await writeFile(file, JSON.stringify({ items: [{ id: 1 }, { id: 2 }] }));
  const src = makeCatalogSource({ file, ttlSec: 60 });
  const records = await src.get();
  assert.equal(records.length, 2);
  const meta = src.meta();
  assert.equal(meta.record_count, 2);
  assert.deepEqual(meta.document_keys, ["items"]);
  assert.ok(meta.cache_age_sec >= 0);
});

test("config validation: needs exactly one of url/file", () => {
  assert.throws(() => makeCatalogSource({}), /url or a file/);
  assert.throws(() => makeCatalogSource({ url: "x", file: "y" }), /not both/);
});

// ── makeCatalogSource: url, TTL, stale-on-error ──

test("url source caches within TTL and serves stale on upstream failure", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    if (calls === 1) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ items: [{ id: "only" }] }));
    } else {
      res.statusCode = 500;
      res.end("boom");
    }
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/cat.json`;
  try {
    const src = makeCatalogSource({ url, ttlSec: 60 });
    const first = await src.get();
    assert.equal(first[0].id, "only");
    // within TTL: cached, no second request
    await src.get();
    assert.equal(calls, 1);
    // forced refresh fails upstream -> stale data returned, no throw
    const stale = await src.get(true);
    assert.equal(stale[0].id, "only");
    assert.equal(calls, 2);
  } finally {
    server.close();
  }
});

test("url source with no cache propagates the failure", async () => {
  const server = createServer((req, res) => {
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/cat.json`;
  try {
    const src = makeCatalogSource({ url });
    await assert.rejects(() => src.get(), /HTTP 404/);
  } finally {
    server.close();
  }
});
