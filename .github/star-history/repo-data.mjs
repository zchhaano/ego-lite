// Adapter for the pinned renderer. The aggregate history endpoint requires only
// metadata:read, unlike the restricted list of individual stargazers.
// https://docs.github.com/en/rest/activity/starring#get-repository-star-history
const DAY_SECONDS = 86400;

const dateString = (date) =>
  date.toISOString().slice(0, 10).replaceAll("-", "/");

export async function getRepoData(
  repos,
  token = "",
  maxRequests = 16,
  request = fetch,
  now = new Date(),
) {
  const result = [];
  for (const repo of repos) {
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new Error("Invalid repository name");
    }
    const weeks = [];
    const seen = new Set();
    for (let page = 1; ; page++) {
      if (page > maxRequests || page > 100)
        throw new Error("Star history request limit exceeded");
      const response = await request(
        `https://api.github.com/repos/${repo}/stargazers/history?per_page=30&page=${page}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok)
        throw Object.assign(
          new Error(`Star history request failed: HTTP ${response.status}`),
          { status: response.status },
        );
      const data = await response.json();
      if (!Array.isArray(data) || data.length > 30)
        throw new Error("Invalid star history response");
      for (const week of data) {
        if (
          !Number.isSafeInteger(week?.week) ||
          week.week < 0 ||
          seen.has(week.week) ||
          !Array.isArray(week.days) ||
          week.days.length !== 7 ||
          !week.days.every(
            (count) => Number.isSafeInteger(count) && count >= 0,
          ) ||
          !Number.isSafeInteger(week.total) ||
          week.total !== week.days.reduce((sum, count) => sum + count, 0)
        ) {
          throw new Error("Invalid star history week");
        }
        seen.add(week.week);
        weeks.push(week);
      }
      if (data.length < 30) break;
    }
    weeks.sort((a, b) => a.week - b.week);
    const today = dateString(now);
    const starRecords = [];
    let count = 0;
    for (const week of weeks) {
      for (let day = 0; day < 7; day++) {
        const date = dateString(
          new Date((week.week + day * DAY_SECONDS) * 1000),
        );
        if (date > today) continue;
        count += week.days[day];
        if (!Number.isSafeInteger(count))
          throw new Error("Star history count overflow");
        starRecords.push({ date, count });
      }
    }
    if (starRecords.at(-1)?.date !== today)
      starRecords.push({ date: today, count });
    // The published SVG strips avatars, so no identity or avatar request is needed.
    result.push({ repo, starRecords, logoUrl: "" });
  }
  return result;
}
