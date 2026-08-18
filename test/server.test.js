/**
 * End-to-end: spawn the real server over stdio against the example catalog
 * and drive it with the real MCP client.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "src", "server.js")],
    env: {
      ...process.env,
      CATALOG_FILE: join(root, "examples", "telescopes.json"),
      CATALOG_KEY: "sku",
    },
  });
  const client = new Client({ name: "catalog-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

test("stdio end-to-end: tools list, schema, query, get, count_by, top, values, stats", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "catalog_count_by",
      "catalog_get",
      "catalog_query",
      "catalog_schema",
      "catalog_stats",
      "catalog_top",
      "catalog_values",
    ]);

    const parse = (res) => {
      assert.ok(!res.isError, res.content?.[0]?.text);
      return JSON.parse(res.content[0].text);
    };

    // schema discovers the fields
    const schema = parse(await client.callTool({ name: "catalog_schema", arguments: {} }));
    assert.equal(schema.total_records, 10);
    assert.ok(schema.fields.some((f) => f.name === "aperture_mm" && f.type === "number"));

    // query: reflectors under $600 with a parabolic mirror, cheapest first
    const q = parse(
      await client.callTool({
        name: "catalog_query",
        arguments: {
          filter: {
            eq: { type: "reflector" },
            max: { price: 600 },
            has: { features: ["Parabolic Mirror"] },
          },
          sort_by: "price",
          sort_dir: "asc",
          fields: ["sku", "name", "price"],
        },
      })
    );
    assert.deepEqual(
      q.records.map((r) => r.sku),
      ["T-1001", "T-1002"]
    );
    assert.equal(q.total_records, 10);

    // the null-priced record never passes a price cap
    const capped = parse(
      await client.callTool({
        name: "catalog_query",
        arguments: { filter: { max: { price: 100000 } } },
      })
    );
    assert.ok(!capped.records.some((r) => r.sku === "T-1008"));

    // get by configured key
    const got = parse(
      await client.callTool({ name: "catalog_get", arguments: { key: "T-1005" } })
    );
    assert.equal(got.found, true);
    assert.equal(got.record.name, "Nebular 8 SCT GoTo");
    const missing = parse(
      await client.callTool({ name: "catalog_get", arguments: { key: "NOPE" } })
    );
    assert.equal(missing.found, false);

    // count_by on scalar and array fields
    const byType = parse(
      await client.callTool({ name: "catalog_count_by", arguments: { field: "type" } })
    );
    assert.equal(byType.counts.reflector, 4);
    const byFeature = parse(
      await client.callTool({ name: "catalog_count_by", arguments: { field: "features" } })
    );
    assert.equal(byFeature.counts["Dual-Speed Focuser"], 4);

    // top: biggest aperture
    const top = parse(
      await client.callTool({
        name: "catalog_top",
        arguments: { sort_by: "aperture_mm", limit: 1, fields: ["sku", "aperture_mm"] },
      })
    );
    assert.deepEqual(top.records, [{ sku: "T-1010", aperture_mm: 254 }]);

    // values
    const brands = parse(
      await client.callTool({ name: "catalog_values", arguments: { field: "brand" } })
    );
    assert.deepEqual(Object.keys(brands.values).sort(), ["Meridian", "Nebular", "Starfield"]);

    // stats with a numeric summary
    const stats = parse(
      await client.callTool({
        name: "catalog_stats",
        arguments: { numeric_fields: ["price"] },
      })
    );
    assert.equal(stats.total_records, 10);
    assert.equal(stats.key_field, "sku");
    assert.equal(stats.numeric[0].count, 9); // null price excluded

    // bad filter comes back as an actionable tool error, not a crash
    const bad = await client.callTool({
      name: "catalog_query",
      arguments: { filter: { type: "reflector" } },
    });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /Unknown filter key/);
  } finally {
    await client.close();
  }
});
