import test from "node:test";
import assert from "node:assert/strict";

import {
  applyFilter,
  applySort,
  countBy,
  distinctValues,
  inferSchema,
  numericSummary,
  project,
} from "../src/engine.js";

const records = [
  { id: "a", type: "tent", price: 100, heated: false, tags: ["light", "solo"], name: "Alpine Solo" },
  { id: "b", type: "tent", price: 250, heated: true, tags: ["light"], name: "Alpine Duo" },
  { id: "c", type: "cabin", price: 900, heated: true, tags: ["family", "light"], name: "Big Pine" },
  { id: "d", type: "cabin", price: null, heated: true, tags: ["family"], name: "Call For Price Lodge" },
  { id: "e", type: "yurt", heated: false, tags: [], name: "Round House" },
];

// ── applyFilter ──

test("eq filters on strict equality including booleans", () => {
  assert.deepEqual(applyFilter(records, { eq: { type: "tent" } }).map((r) => r.id), ["a", "b"]);
  assert.deepEqual(applyFilter(records, { eq: { heated: true } }).map((r) => r.id), ["b", "c", "d"]);
});

test("eq with null matches null and missing", () => {
  assert.deepEqual(applyFilter(records, { eq: { price: null } }).map((r) => r.id), ["d", "e"]);
});

test("min/max are numeric-only: missing and null values are excluded when bounded", () => {
  assert.deepEqual(applyFilter(records, { min: { price: 200 } }).map((r) => r.id), ["b", "c"]);
  // d (null price) and e (no price) must NOT appear under a price cap
  assert.deepEqual(applyFilter(records, { max: { price: 500 } }).map((r) => r.id), ["a", "b"]);
});

test("min and max combine into a range", () => {
  assert.deepEqual(
    applyFilter(records, { min: { price: 150 }, max: { price: 800 } }).map((r) => r.id),
    ["b"]
  );
});

test("has requires ALL listed values in an array field", () => {
  assert.deepEqual(applyFilter(records, { has: { tags: ["light"] } }).map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual(applyFilter(records, { has: { tags: ["family", "light"] } }).map((r) => r.id), ["c"]);
});

test("contains is case-insensitive; '*' searches all string fields", () => {
  assert.deepEqual(applyFilter(records, { contains: { name: "alpine" } }).map((r) => r.id), ["a", "b"]);
  assert.deepEqual(applyFilter(records, { contains: { "*": "round" } }).map((r) => r.id), ["e"]);
});

test("filters compose with AND semantics", () => {
  assert.deepEqual(
    applyFilter(records, { eq: { heated: true }, has: { tags: ["light"] } }).map((r) => r.id),
    ["b", "c"]
  );
});

test("unknown filter key throws an actionable error", () => {
  assert.throws(() => applyFilter(records, { type: "tent" }), /Unknown filter key.*eq/);
});

test("non-numeric bound throws", () => {
  assert.throws(() => applyFilter(records, { min: { price: "cheap" } }), /must be a number/);
});

// ── applySort ──

test("sort pushes missing values to the end in both directions", () => {
  const asc = applySort(records, "price", "asc").map((r) => r.id);
  assert.deepEqual(asc, ["a", "b", "c", "d", "e"]);
  const desc = applySort(records, "price", "desc").map((r) => r.id);
  assert.deepEqual(desc, ["c", "b", "a", "d", "e"]);
});

test("sort on string fields uses locale compare", () => {
  assert.deepEqual(applySort(records, "type", "asc").map((r) => r.type), [
    "cabin", "cabin", "tent", "tent", "yurt",
  ]);
});

test("sort does not mutate its input", () => {
  const before = records.map((r) => r.id).join();
  applySort(records, "price", "desc");
  assert.equal(records.map((r) => r.id).join(), before);
});

// ── project ──

test("project keeps only requested fields and skips absent ones", () => {
  assert.deepEqual(project(records[0], ["id", "price", "nope"]), { id: "a", price: 100 });
  assert.equal(project(records[0]), records[0]);
});

// ── countBy / distinctValues ──

test("countBy counts scalars and groups null/missing as (null)", () => {
  const c = countBy(records, "type");
  assert.deepEqual(c.counts, { tent: 2, cabin: 2, yurt: 1 });
  const p = countBy(records, "price");
  assert.equal(p.counts["(null)"], 2);
});

test("countBy on array fields counts each element", () => {
  const c = countBy(records, "tags");
  assert.equal(c.counts.light, 3);
  assert.equal(c.counts.family, 2);
});

test("distinctValues respects limit and reports truncation", () => {
  const v = distinctValues(records, "tags", 1);
  assert.equal(Object.keys(v.values).length, 1);
  assert.equal(v.truncated, true);
  assert.equal(v.distinct_values, 3);
});

// ── inferSchema ──

test("inferSchema reports types, coverage, numeric ranges and samples", () => {
  const s = inferSchema(records);
  assert.equal(s.total_records, 5);
  const price = s.fields.find((f) => f.name === "price");
  assert.equal(price.type, "number");
  assert.equal(price.min, 100);
  assert.equal(price.max, 900);
  assert.equal(price.coverage, 0.6); // 3 numeric of 5 (null + missing don't count)
  const type = s.fields.find((f) => f.name === "type");
  assert.ok(type.sample_values.includes("tent"));
  const heated = s.fields.find((f) => f.name === "heated");
  assert.equal(heated.type, "boolean");
});

// ── numericSummary ──

test("numericSummary ignores null/missing and computes the spread", () => {
  const n = numericSummary(records, "price");
  assert.deepEqual(n, { field: "price", count: 3, min: 100, max: 900, mean: 416.67, median: 250 });
  assert.deepEqual(numericSummary(records, "absent"), { field: "absent", count: 0 });
});
