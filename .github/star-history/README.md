# Star history workflow security

The renderer runs with `contents: read` and checkouts do not persist credentials.
Its patched data adapter uses GitHub's public [aggregate star history API](https://docs.github.com/en/rest/activity/starring#get-repository-star-history), which requires only metadata read permission. It converts weekly daily counts to the cumulative daily series expected by the renderer, without fetching stargazer identities. This replaces the restricted individual-stargazers API; it also removes the old need to grant the renderer a write token. The adapter fails rather than publishing a history truncated at its request limit.

Publication runs in a separate job, only on the default branch. That job never runs the renderer or installs its dependencies. It accepts exactly two SVGs, one PNG and one signature, rejects links/non-regular/oversized files, then publishes only these files and the repository-owned branch README. The SVG format check is a file-type sanity check, not an SVG sanitizer. The pinned renderer remains responsible for chart content.

External actions are pinned to full commits. On 2026-10-27, GitHub's commit API resolved these existing version references:

| Action reference | Commit |
| --- | --- |
| `actions/checkout@v4` | `11d5960a326750d5838078e36cf38b85af677262` |
| `actions/checkout@v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node@v4` | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `actions/setup-node@v7.1.0` | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
| `actions/upload-artifact@v4` | `ea165f8d65b6e75b540449e92b4886f43607fa02` |
| `actions/download-artifact@v4` | `d3f86a106a0bac45b974a628896c90dbdf5c8093` |

The renderer remains at the peeled `narayann7/star-history-action@v1.0.5` commit `a68d8f9d67ca20d55b682a264e69152dcf326e9c`. When updating it, verify all three patches still apply, review its dependency lockfile, and recheck nested Action references.

Local checks from the repository root:

```sh
node --test .github/star-history/repo-data.test.mjs
python3 .github/star-history/test_stage_chart.py
actionlint .github/workflows/*.yml
```

The CI test job runs the two behavioral test suites. These local checks do not exercise GitHub-hosted artifact transfer or perform a publication.
