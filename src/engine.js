/**
 * engine.js — pure query engine over an array of plain-object records.
 *
 * No I/O, no state. Everything here is testable with a fixture array.
 * The filter grammar is deliberately small: eq / min / max / has / contains.
 */

const FILTER_KEYS = ["eq", "min", "max", "has", "contains"];

/** True when v is a finite number. */
function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Apply a filter spec to records. Returns a new array.
 *
 * spec = {
 *   eq:       { field: value, ... }        strict equality (booleans, strings, numbers, null)
 *   min:      { field: n, ... }            numeric >= n; records without a numeric value are excluded
 *   max:      { field: n, ... }            numeric <= n; records without a numeric value are excluded
 *   has:      { field: [v, ...], ... }     array field must contain ALL listed values
 *   contains: { field: "needle", ... }     case-insensitive substring; field "*" searches every string field
 * }
 *
 * Note the min/max rule: a bound only ever matches records that carry a real
 * number in that field. A missing or non-numeric value (a price of "Call",
 * a null weight) is excluded once you bound that field. That is intentional —
 * "under $30k" should never surface a record whose price is unknown.
 */
export function applyFilter(records, spec) {
  spec = spec || {};
  const unknown = Object.keys(spec).filter((k) => !FILTER_KEYS.includes(k));
  if (unknown.length) {
    throw new Error(
      `Unknown filter key(s): ${unknown.join(", ")}. Valid keys: ${FILTER_KEYS.join(", ")}. ` +
        `Did you mean to nest the field under one of them, e.g. {"eq": {"${unknown[0]}": ...}}?`
    );
  }
  let out = records;

  if (spec.eq) {
    for (const [field, want] of Object.entries(spec.eq)) {
      out = out.filter((r) => r[field] === want || (want === null && r[field] == null));
    }
  }
  if (spec.min) {
    for (const [field, bound] of Object.entries(spec.min)) {
      if (!isNum(bound)) throw new Error(`min.${field} must be a number, got ${JSON.stringify(bound)}`);
      out = out.filter((r) => isNum(r[field]) && r[field] >= bound);
    }
  }
  if (spec.max) {
    for (const [field, bound] of Object.entries(spec.max)) {
      if (!isNum(bound)) throw new Error(`max.${field} must be a number, got ${JSON.stringify(bound)}`);
      out = out.filter((r) => isNum(r[field]) && r[field] <= bound);
    }
  }
  if (spec.has) {
    for (const [field, wanted] of Object.entries(spec.has)) {
      const list = Array.isArray(wanted) ? wanted : [wanted];
      out = out.filter((r) => Array.isArray(r[field]) && list.every((w) => r[field].includes(w)));
    }
  }
  if (spec.contains) {
    for (const [field, needle] of Object.entries(spec.contains)) {
      const n = String(needle).toLowerCase();
      if (field === "*") {
        out = out.filter((r) =>
          Object.values(r).some((v) => typeof v === "string" && v.toLowerCase().includes(n))
        );
      } else {
        out = out.filter((r) => typeof r[field] === "string" && r[field].toLowerCase().includes(n));
      }
    }
  }
  return out;
}

/**
 * Sort records by a field. Records missing the field (or holding a
 * non-comparable value) are pushed to the end regardless of direction —
 * "sort by price" should show priced records first, not a wall of nulls.
 */
export function applySort(records, sortBy, sortDir = "asc") {
  if (!sortBy) return records.slice();
  const rev = sortDir === "desc" ? -1 : 1;
  const present = [];
  const missing = [];
  for (const r of records) {
    const v = r[sortBy];
    if (v === null || v === undefined) missing.push(r);
    else present.push(r);
  }
  present.sort((a, b) => {
    const va = a[sortBy];
    const vb = b[sortBy];
    if (isNum(va) && isNum(vb)) return (va - vb) * rev;
    return String(va).localeCompare(String(vb)) * rev;
  });
  return present.concat(missing);
}

/** Project a record down to the requested fields (all fields when none given). */
export function project(record, fields) {
  if (!fields || !fields.length) return record;
  const out = {};
  for (const f of fields) {
    if (f in record) out[f] = record[f];
  }
  return out;
}

/**
 * Group records by a field and count. Array-valued fields count each element,
 * so a "features" array behaves the way you would hope. Null/missing groups
 * under "(null)".
 */
export function countBy(records, field) {
  const counts = new Map();
  const bump = (k) => counts.set(k, (counts.get(k) || 0) + 1);
  for (const r of records) {
    const v = r[field];
    if (Array.isArray(v)) {
      for (const x of v) bump(String(x));
    } else {
      bump(v === null || v === undefined ? "(null)" : String(v));
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return {
    field,
    total_counted: sorted.reduce((s, [, n]) => s + n, 0),
    distinct_values: sorted.length,
    counts: Object.fromEntries(sorted),
  };
}

/** Distinct values of a field with counts, most common first. */
export function distinctValues(records, field, limit = 100) {
  const { counts, distinct_values } = countBy(records, field);
  const entries = Object.entries(counts);
  return {
    field,
    distinct_values,
    truncated: limit > 0 && entries.length > limit,
    values: Object.fromEntries(limit > 0 ? entries.slice(0, limit) : entries),
  };
}

/**
 * Infer a schema from the records themselves: for each field, how often it
 * appears, what types it holds, numeric range, and sample values for
 * low-cardinality string fields. This is what lets an agent write correct
 * filters without anyone hand-maintaining a field list.
 */
export function inferSchema(records, { sampleLimit = 8 } = {}) {
  const total = records.length;
  const fields = new Map();
  for (const r of records) {
    for (const [k, v] of Object.entries(r)) {
      let f = fields.get(k);
      if (!f) {
        f = { types: {}, present: 0, min: null, max: null, samples: new Map() };
        fields.set(k, f);
      }
      const t =
        v === null || v === undefined
          ? "null"
          : Array.isArray(v)
            ? "array"
            : typeof v;
      f.types[t] = (f.types[t] || 0) + 1;
      if (t !== "null") f.present += 1;
      if (isNum(v)) {
        f.min = f.min === null ? v : Math.min(f.min, v);
        f.max = f.max === null ? v : Math.max(f.max, v);
      }
      if (typeof v === "string" && f.samples.size <= 40) {
        f.samples.set(v, (f.samples.get(v) || 0) + 1);
      }
      if (typeof v === "boolean") {
        f.samples.set(String(v), (f.samples.get(String(v)) || 0) + 1);
      }
    }
  }
  const out = [];
  for (const [name, f] of fields) {
    const primary = Object.entries(f.types)
      .filter(([t]) => t !== "null")
      .sort((a, b) => b[1] - a[1])[0];
    const entry = {
      name,
      type: primary ? primary[0] : "null",
      coverage: total ? Number((f.present / total).toFixed(3)) : 0,
      types: f.types,
    };
    if (f.min !== null) {
      entry.min = f.min;
      entry.max = f.max;
    }
    // Only report samples for fields that look categorical — a field with 40+
    // distinct strings is free text, and samples would just be noise.
    if (f.samples.size > 0 && f.samples.size <= 40) {
      entry.sample_values = [...f.samples.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, sampleLimit)
        .map(([v]) => v);
    }
    out.push(entry);
  }
  out.sort((a, b) => b.coverage - a.coverage || a.name.localeCompare(b.name));
  return { total_records: total, field_count: out.length, fields: out };
}

/** count / min / max / mean / median over the numeric values of a field. */
export function numericSummary(records, field) {
  const vals = records.map((r) => r[field]).filter(isNum).sort((a, b) => a - b);
  if (!vals.length) return { field, count: 0 };
  const sum = vals.reduce((s, v) => s + v, 0);
  return {
    field,
    count: vals.length,
    min: vals[0],
    max: vals[vals.length - 1],
    mean: Number((sum / vals.length).toFixed(2)),
    median: vals[Math.floor(vals.length / 2)],
  };
}
