# catalog-mcp

[![CI](https://github.com/stevyf93II/catalog-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/stevyf93II/catalog-mcp/actions/workflows/ci.yml)

An MCP server that turns any JSON catalog into query tools for AI agents.

Point it at a catalog URL or file — an inventory feed, a product list, the
`catalog.json` that [feedmerge](https://github.com/stevyf93II/feedmerge)
publishes — and any MCP client (Claude Desktop, Claude Code, anything speaking
the protocol) gets structured filtering, grouping, ranking, and schema
discovery over your records.

Node 18+. Two runtime dependencies: the MCP SDK and zod.

## Why

Agents are bad at big JSON files and good at tools. Hand an agent a 2 MB
catalog and it will truncate, skim, or hallucinate records; hand it
`catalog_query` with a filter grammar and it answers "cheapest record under
$30k with these two features" correctly every time, reading only the records
that match.

This repo is the generalized version of an MCP server I run in production: a
sales-floor AI assistant queries a live inventory catalog through exactly
these tools (same filter semantics, same null-price rule, same TTL cache)
hundreds of times a day. The pipeline it belongs to:

```
vendor feed  ->  feedmerge  ->  catalog.json  ->  catalog-mcp  ->  any agent
             (guarded sync)   (versioned)      (query tools)
```

I run this against my own public inventory feed; the example below uses a
neutral catalog so the repo stands alone.

## Quickstart

```sh
git clone https://github.com/stevyf93II/catalog-mcp.git
cd catalog-mcp
npm install
npm test                                          # engine, loader, and stdio end-to-end tests

# serve the example catalog
node src/server.js --file examples/telescopes.json --key sku
```

Wire it into Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "my-catalog": {
      "command": "node",
      "args": ["/path/to/catalog-mcp/src/server.js"],
      "env": {
        "CATALOG_URL": "https://example.com/catalog.json",
        "CATALOG_KEY": "sku"
      }
    }
  }
}
```

Then ask the agent things like "what types are in the catalog and what does
each cost at the low end?" and watch it compose `catalog_schema`,
`catalog_count_by`, and `catalog_top` on its own.

## Tools

| Tool | What it does |
| --- | --- |
| `catalog_query` | Filter, sort, paginate, and project records |
| `catalog_get` | Fetch one record by its key field |
| `catalog_count_by` | Group by a field and count (array fields count each element) |
| `catalog_top` | Top-N records by a numeric field, with optional filter |
| `catalog_values` | Distinct values of a field with counts — learn a field's vocabulary before filtering on it |
| `catalog_schema` | Schema inferred from the records: types, coverage, numeric ranges, sample values |
| `catalog_stats` | Record count, source, cache age, optional numeric summaries |

All tools are read-only and idempotent, and say so in their MCP annotations.

## The filter grammar

One small spec, used by `query`, `count_by`, and `top`:

```json
{
  "eq":       { "type": "reflector", "goto": true },
  "min":      { "aperture_mm": 150 },
  "max":      { "price": 1000 },
  "has":      { "features": ["Parabolic Mirror", "Cooling Fan"] },
  "contains": { "name": "dobsonian" }
}
```

- `eq` — strict equality on any value, including booleans and `null`.
- `min` / `max` — numeric bounds. A record without a real number in a bounded
  field is excluded. This rule is load-bearing: in the production catalog a
  missing price means "call for price", and "show me units under $30k" must
  never surface a unit whose price is unknown.
- `has` — array membership; every listed value must be present.
- `contains` — case-insensitive substring on a string field; field `"*"`
  searches every string field in the record.

Conditions AND together. An unknown top-level key is an error that names the
valid keys, because a silently ignored filter is how an agent confidently
reports wrong answers.

Sorting pushes records that lack the sort field to the end, in both
directions — "sort by price" shows priced records first, not a wall of nulls.

## Configuration

| Env var | Flag | Meaning |
| --- | --- | --- |
| `CATALOG_URL` | `--url` | catalog over HTTP(S) (exactly one of url/file) |
| `CATALOG_FILE` | `--file` | catalog on disk |
| `CATALOG_RECORDS_PATH` | `--records-path` | dot-path to the record array, e.g. `data.items` |
| `CATALOG_KEY` | `--key` | record key field for `catalog_get` (default `id`) |
| `CATALOG_TTL_SEC` | `--ttl` | fetch cache TTL in seconds (default `300`) |

When `CATALOG_RECORDS_PATH` is not set, the loader uses the document root if
it is an array, or the single top-level array of objects if there is exactly
one (`{ "meta": ..., "items": [...] }` just works). If the document is
ambiguous it refuses and names the candidate keys.

On a failed refresh the server serves the last good data instead of erroring
— an agent mid-task is better off with five-minute-old records than an
exception — and `catalog_stats` reports the cache age so staleness is never
hidden.

## Non-goals

- Not a database. The catalog is read-only and lives in memory; if your data
  does not fit comfortably in a JSON file, you want a real store.
- No writes. Nothing here mutates the catalog — that is the sync pipeline's
  job (see feedmerge).
- No query language. Five filter keys cover what agents actually ask;
  anything fancier belongs in code, not in a tool schema.

## License

MIT
