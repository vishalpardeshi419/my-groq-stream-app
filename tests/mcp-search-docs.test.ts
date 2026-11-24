import assert from "node:assert/strict";
import test from "node:test";
import { createSearchDocsServer, searchDocs } from "../mcp/search-docs";

test("searches repository docs and returns bounded matching excerpts", async () => {
  const results = await searchDocs("Streamable HTTP", 3);

  assert.ok(results.length > 0);
  assert.ok(results.length <= 3);
  assert.ok(results.every((result) => result.file.startsWith("docs/")));
  assert.ok(
    results.every((result) => {
      const text = result.text.toLowerCase();
      return text.includes("streamable") && text.includes("http");
    }),
  );
});

test("returns no results for unmatched queries", async () => {
  assert.deepEqual(await searchDocs("not-a-real-documentation-term-xyz"), []);
});

test("registers search_docs on an MCP server", () => {
  const server = createSearchDocsServer();
  assert.ok(server);
});
