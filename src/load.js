/**
 * load.js — fetch a catalog from a URL or file, find the record array inside
 * it, and cache it with a TTL.
 *
 * Serving stale data on a fetch failure is deliberate: an agent mid-task is
 * better served by five-minute-old records than by an exception, and the
 * cache age is reported so nothing is silently wrong.
 */

import { readFile } from "node:fs/promises";

/** Follow a dot-path ("data.items") into a parsed document. */
export function dotPath(doc, path) {
  let cur = doc;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Find the array of records in a parsed document.
 *
 * - If `path` is given, it must resolve to an array.
 * - If the document root is an array, use it.
 * - If exactly one top-level value is an array of objects, use that
 *   (covers the common `{ "meta": ..., "items": [...] }` shape).
 * - Otherwise refuse, listing the array-valued keys so the fix is obvious.
 */
export function extractRecords(doc, path) {
  if (path) {
    const v = dotPath(doc, path);
    if (!Array.isArray(v)) {
      throw new Error(`Path "${path}" did not resolve to an array in the catalog document.`);
    }
    return v;
  }
  if (Array.isArray(doc)) return doc;
  if (doc && typeof doc === "object") {
    const arrayKeys = Object.keys(doc).filter(
      (k) => Array.isArray(doc[k]) && doc[k].every((x) => x && typeof x === "object" && !Array.isArray(x))
    );
    if (arrayKeys.length === 1) return doc[arrayKeys[0]];
    throw new Error(
      arrayKeys.length === 0
        ? "No array of records found at the document root. Set CATALOG_RECORDS_PATH (or --records-path) to the dot-path of the record array."
        : `Multiple candidate record arrays found (${arrayKeys.join(", ")}). Set CATALOG_RECORDS_PATH (or --records-path) to pick one.`
    );
  }
  throw new Error("Catalog document is not an object or array.");
}

async function fetchUrl(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "catalog-mcp/0.1", accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Catalog fetch failed: HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a catalog source. Exactly one of url/file is required.
 *
 * Returns { get(force), meta() }:
 *   get(force)  -> Promise<records[]>, cached for ttlSec, stale-on-error
 *   meta()      -> { source, fetched_at, cache_age_sec, record_count, document_keys }
 */
export function makeCatalogSource({ url, file, recordsPath, ttlSec = 300, timeoutMs = 15000 }) {
  if (!url && !file) throw new Error("catalog source needs a url or a file");
  if (url && file) throw new Error("catalog source takes a url or a file, not both");

  const cache = { at: 0, records: null, documentKeys: null };

  async function get(force = false) {
    const now = Date.now();
    if (!force && cache.records && now - cache.at < ttlSec * 1000) return cache.records;
    let doc;
    try {
      doc = url ? await fetchUrl(url, timeoutMs) : JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      if (cache.records) return cache.records; // stale beats broken
      throw err;
    }
    cache.records = extractRecords(doc, recordsPath);
    cache.documentKeys = Array.isArray(doc) ? null : Object.keys(doc);
    cache.at = now;
    return cache.records;
  }

  function meta() {
    return {
      source: url || file,
      fetched_at: cache.at ? new Date(cache.at).toISOString() : null,
      cache_age_sec: cache.at ? Math.round((Date.now() - cache.at) / 1000) : null,
      record_count: cache.records ? cache.records.length : null,
      document_keys: cache.documentKeys,
    };
  }

  return { get, meta };
}
