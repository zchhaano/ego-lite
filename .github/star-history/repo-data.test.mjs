import assert from "node:assert/strict";
import test from "node:test";
import { getRepoData } from "./repo-data.mjs";

test("aggregates oldest-first daily counts without fetching stargazer identities", async () => {
  const requests = [];
  const data = await getRepoData(
    ["owner/repo"],
    "read-only-token",
    16,
    async (url, options) => {
      requests.push({ url, options });
      return new Response(
        JSON.stringify([
          { week: 1755388800, total: 2, days: [0, 2, 0, 0, 0, 0, 0] },
          { week: 1754784000, total: 3, days: [1, 0, 2, 0, 0, 0, 0] },
        ]),
      );
    },
    new Date("2025-08-20T12:00:00Z"),
  );
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://api.github.com/repos/owner/repo/stargazers/history?per_page=30&page=1",
  );
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(data[0].logoUrl, "");
  assert.deepEqual(
    data[0].starRecords.filter(
      (r, i, all) => i === 0 || r.count !== all[i - 1].count,
    ),
    [
      { date: "2025/08/10", count: 1 },
      { date: "2025/08/12", count: 3 },
      { date: "2025/08/18", count: 5 },
    ],
  );
  assert.deepEqual(data[0].starRecords.at(-1), {
    date: "2025/08/20",
    count: 5,
  });
});

test("does not silently publish a truncated history", async () => {
  const fullPage = Array.from({ length: 30 }, (_, i) => ({
    week: 1754784000 - i * 604800,
    total: 0,
    days: [0, 0, 0, 0, 0, 0, 0],
  }));
  await assert.rejects(
    getRepoData(
      ["owner/repo"],
      "",
      1,
      async () => new Response(JSON.stringify(fullPage)),
    ),
    /request limit/i,
  );
});

test("rejects malformed counts and repository paths before publication", async () => {
  await assert.rejects(
    getRepoData(["owner/../../secret"], "", 16, () => {
      throw new Error("must not fetch");
    }),
    /repository/i,
  );
  await assert.rejects(
    getRepoData(
      ["owner/repo"],
      "",
      16,
      async () =>
        new Response(
          JSON.stringify([
            { week: 1754784000, total: 2, days: [-1, 3, 0, 0, 0, 0, 0] },
          ]),
        ),
    ),
    /history/i,
  );
});

test("preserves rate-limit status for the renderer fallback", async () => {
  await assert.rejects(
    getRepoData(
      ["owner/repo"],
      "",
      16,
      async () => new Response("", { status: 403 }),
    ),
    { status: 403 },
  );
});
