#!/usr/bin/env node
/**
 * catalog-mcp — MCP server over any JSON catalog.
 *
 * Point it at a catalog URL or file; it exposes query / get / count_by /
 * top / values / schema / stats tools over stdio. Configuration comes from
 * environment variables or flags:
 *
 *   CATALOG_URL           --url <url>            catalog over HTTP(S)
 *   CATALOG_FILE          --file <path>          catalog on disk
 *   CATALOG_RECORDS_PATH  --records-path <p>     dot-path to the record array (auto-detected when omitted)
 *   CATALOG_KEY           --key <field>          record key field (default "id")
 *   CATALOG_TTL_SEC       --ttl <seconds>        cache TTL (default 300)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { makeCatalogSource } from "./load.js";
import {
  applyFilter,
  applySort,
  countBy,
  distinctValues,
  inferSchema,
  numericSummary,
  project,
} from "./engine.js";

const CHARACTER_LIMIT = 25000;

// ───────── Config ─────────

export function parseConfig(env = process.env, argv = process.argv.slice(2)) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z-]+)$/);
    if (m) flags[m[1]] = argv[i + 1];
  }
  const cfg = {
    url: flags.url ?? env.CATALOG_URL,
    file: flags.file ?? env.CATALOG_FILE,
    recordsPath: flags["records-path"] ?? env.CATALOG_RECORDS_PATH,
    key: flags.key ?? env.CATALOG_KEY ?? "id",
    ttlSec: Number(flags.ttl ?? env.CATALOG_TTL_SEC ?? 300),
  };
  if (!cfg.url && !cfg.file) {
    throw new Error(
      "catalog-mcp needs a catalog: set CATALOG_URL or CATALOG_FILE (or pass --url / --file)."
    );
  }
  return cfg;
}

// ───────── Shared helpers ─────────

const filterSchema = z
  .record(z.unknown())
  .optional()
  .describe(
    'Filter spec. Keys: eq (equality: {"type":"tent","heated":true}), ' +
      'min / max (numeric bounds: {"price":100}; records without a number in a bounded field are excluded), ' +
      'has (array membership, all required: {"tags":["a","b"]}), ' +
      'contains (case-insensitive substring: {"name":"alpine"}; use field "*" to search all string fields).'
  );

function toResult(output) {
  let text = JSON.stringify(output, null, 2);
  if (text.length > CHARACTER_LIMIT && Array.isArray(output.records)) {
    const keep = Math.max(1, Math.floor(output.records.length / 2));
    output = {
      ...output,
      records: output.records.slice(0, keep),
      truncated: true,
      truncation_message: `Response exceeded ${CHARACTER_LIMIT} chars; showing ${keep} of ${output.records.length} records. Narrow the filter, lower the limit, or select fewer fields.`,
    };
    text = JSON.stringify(output, null, 2);
  }
  return { content: [{ type: "text", text }], structuredContent: output };
}

function toError(err) {
  return {
    content: [{ type: "text", text: `Error: ${err.message}` }],
    isError: true,
  };
}

// ───────── Server ─────────

export function buildServer(source, cfg) {
  const server = new McpServer({ name: "catalog-mcp", version: "0.1.0" });
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: Boolean(cfg.url),
  };

  server.registerTool(
    "catalog_query",
    {
      title: "Query the catalog",
      description:
        "Filter, sort, and page through catalog records. " +
        "Returns { count, total_matching, total_records, records }. " +
        "Use catalog_schema first if you are unsure which fields exist. " +
        'Example: filter {"eq":{"condition":"used"},"max":{"price":30000},"has":{"features":["Solar"]}}, sort_by "price".',
      inputSchema: {
        filter: filterSchema,
        sort_by: z.string().optional().describe("Field to sort by. Records missing the field sort last."),
        sort_dir: z.enum(["asc", "desc"]).default("asc"),
        limit: z.number().int().min(1).max(500).default(25),
        offset: z.number().int().min(0).default(0),
        fields: z.array(z.string()).optional().describe("Project each record down to these fields."),
      },
      annotations: readOnly,
    },
    async ({ filter, sort_by, sort_dir, limit, offset, fields }) => {
      try {
        const records = await source.get();
        const filtered = applyFilter(records, filter);
        const sorted = applySort(filtered, sort_by, sort_dir);
        const page = sorted.slice(offset, offset + limit);
        return toResult({
          count: page.length,
          total_matching: filtered.length,
          total_records: records.length,
          offset,
          has_more: offset + page.length < filtered.length,
          records: page.map((r) => project(r, fields)),
        });
      } catch (err) {
        return toError(err);
      }
    }
  );

  server.registerTool(
    "catalog_get",
    {
      title: "Get one record by key",
      description: `Fetch a single record by its key field ("${cfg.key}"). Returns { found, record }.`,
      inputSchema: {
        key: z.string().describe(`Value of the record's "${cfg.key}" field. Numbers are matched loosely.`),
        fields: z.array(z.string()).optional(),
      },
      annotations: readOnly,
    },
    async ({ key, fields }) => {
      try {
        const records = await source.get();
        const hit = records.find((r) => String(r[cfg.key]) === String(key));
        return toResult(
          hit
            ? { found: true, record: project(hit, fields) }
            : { found: false, key_field: cfg.key, key }
        );
      } catch (err) {
        return toError(err);
      }
    }
  );

  server.registerTool(
    "catalog_count_by",
    {
      title: "Count records by field",
      description:
        "Group records by a field and count each value, most common first. " +
        "Array fields count each element. Optional filter applies first.",
      inputSchema: { field: z.string(), filter: filterSchema },
      annotations: readOnly,
    },
    async ({ field, filter }) => {
      try {
        const records = applyFilter(await source.get(), filter);
        return toResult(countBy(records, field));
      } catch (err) {
        return toError(err);
      }
    }
  );

  server.registerTool(
    "catalog_top",
    {
      title: "Top N records by a numeric field",
      description:
        'Rank records by a numeric field with an optional filter. Example: sort_by "price", sort_dir "asc", filter {"has":{"features":["Bunkhouse"]}} = cheapest records with that feature.',
      inputSchema: {
        sort_by: z.string(),
        sort_dir: z.enum(["asc", "desc"]).default("desc"),
        limit: z.number().int().min(1).max(100).default(5),
        filter: filterSchema,
        fields: z.array(z.string()).optional(),
      },
      annotations: readOnly,
    },
    async ({ sort_by, sort_dir, limit, filter, fields }) => {
      try {
        const records = applySort(applyFilter(await source.get(), filter), sort_by, sort_dir);
        const page = records.slice(0, limit);
        return toResult({
          sort_by,
          sort_dir,
          count: page.length,
          records: page.map((r) => project(r, fields)),
        });
      } catch (err) {
        return toError(err);
      }
    }
  );

  server.registerTool(
    "catalog_values",
    {
      title: "Distinct values of a field",
      description:
        "All distinct values of a field with occurrence counts, most common first. " +
        "The reliable way to learn a categorical field's vocabulary before filtering on it.",
      inputSchema: {
        field: z.string(),
        limit: z.number().int().min(0).max(1000).default(100).describe("0 = unlimited"),
      },
      annotations: readOnly,
    },
    async ({ field, limit }) => {
      try {
        return toResult(distinctValues(await source.get(), field, limit));
      } catch (err) {
        return toError(err);
      }
    }
  );

  server.registerTool(
    "catalog_schema",
    {
      title: "Inferred catalog schema",
      description:
        "Field inventory inferred from the records themselves: type, coverage, numeric min/max, " +
        "and sample values for categorical fields. Call this first when exploring an unfamiliar catalog.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      try {
        return toResult(inferSchema(await source.get()));
      } catch (err) {
        return toError(err);
      }
    }
  );

  server.registerTool(
    "catalog_stats",
    {
      title: "Catalog totals and freshness",
      description:
        "Record count, source, cache age, and optional numeric summaries " +
        "(count/min/max/mean/median) for the fields you name.",
      inputSchema: {
        numeric_fields: z.array(z.string()).optional(),
        refresh: z.boolean().default(false).describe("Force a fresh fetch, bypassing the cache."),
      },
      annotations: readOnly,
    },
    async ({ numeric_fields, refresh }) => {
      try {
        const records = await source.get(refresh);
        return toResult({
          total_records: records.length,
          key_field: cfg.key,
          ...source.meta(),
          ...(numeric_fields?.length
            ? { numeric: numeric_fields.map((f) => numericSummary(records, f)) }
            : {}),
        });
      } catch (err) {
        return toError(err);
      }
    }
  );

  return server;
}

// ───────── Entry point ─────────

const isMain = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("server.js") ||
  process.argv[1]?.endsWith("catalog-mcp");

if (isMain) {
  let cfg;
  try {
    cfg = parseConfig();
  } catch (err) {
    console.error(err.message);
    console.error(
      "Usage: catalog-mcp --url https://example.com/catalog.json [--records-path items] [--key id] [--ttl 300]"
    );
    process.exit(1);
  }
  const source = makeCatalogSource(cfg);
  const server = buildServer(source, cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`catalog-mcp serving ${cfg.url || cfg.file} (key: ${cfg.key})`);
}
