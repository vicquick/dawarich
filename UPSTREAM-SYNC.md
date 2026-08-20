# Syncing this fork with upstream Dawarich

This fork (`vicquick/dawarich`) carries a large custom layer on top of
`Freika/dawarich` — Google-Maps-style search, Street View, live turn-by-turn
navigation, Interactive Stories, custom basemaps, semantic place search.

As of 2026-08-20 that is **184 commits / ~53,900 insertions across 130 files**,
diverged from merge-base `ecccc50d` (2026-06-11).

## Why not just `git rebase upstream/master`

Tried and rejected 2026-08-20. Replaying 184 commits sequentially means
resolving the *same* hot files over and over — `maplibre_controller.js` alone is
touched by 29 of our commits and 92 of upstream's. The rebase conflicts on
commit 1 of 184 and every resolution changes what the next one conflicts
against. Hours of work, high risk of silently dropping a custom feature.

## The approach that works: squash-and-replay

Collapse our whole divergence into **one** patch and apply it to upstream's tip.
Conflicts then get resolved **once per file** instead of once per commit.

Measured on 2026-08-20 against upstream at `97fad417`:

- **100 of 130 files apply cleanly** — including every large net-new file
  (Street View, Stories, custom layers), ~50k of the ~53.9k insertions.
- **30 files conflict** and need manual resolution.
- 17 of those 30 are under 30 changed lines. Only three are substantial:
  - `app/javascript/controllers/maps/maplibre_controller.js` (+261 / −2)
  - `app/views/map/maplibre/_settings_panel.html.erb` (+72 / −337)
  - `app/views/shared/map/_date_navigation_v2.html.erb` (+104 / −32)

Our edits to shared files are overwhelmingly **additive** (we add routes and
handlers rather than rewriting upstream logic), which is why the conflict
surface stays small even though upstream rewrote a lot underneath.

## Procedure

```bash
cd /root/dawarich-fork
git fetch upstream

# 0. Safety net — never skip.
git branch backup-before-sync-$(date +%Y%m%d)

# 1. Capture the entire custom divergence as one patch.
MB=$(git merge-base master upstream/master)
git diff "$MB"..master > /tmp/fork_custom.patch

# 2. Start from upstream's tip.
git checkout -b sync-$(date +%Y%m%d) upstream/master

# 3. See which files will conflict BEFORE committing to the work.
#    (git apply is all-or-nothing: on conflicts it exits 1 and rolls back,
#     but stderr still enumerates every conflicting file — that list is the
#     point of this step.)
git apply --3way /tmp/fork_custom.patch 2>/tmp/apply_err.txt
grep "with conflicts" /tmp/apply_err.txt \
  | sed "s/Applied patch to '//;s/' with conflicts.//" | sort

# 4. Resolve. Apply per-file so clean files land and conflicts are isolated:
#    for each path from step 3, checkout ours/theirs and merge by hand.
#    Reference for what each custom change was for:
git log "$MB"..master --oneline -- <path>

# 5. Verify before trusting it.
bundle exec rspec           # or the container's test command
#    Then deploy to staging and click through: map, search, Street View,
#    directions, Stories. The custom layer is mostly frontend — tests will
#    NOT catch a dropped UI feature.

# 6. Once green, this becomes the new master.
git checkout master && git reset --hard sync-<date>
git push --force-with-lease origin master
```

## Making future syncs cheaper

The reason this is expensive is that the custom work is interleaved with
upstream history over months. Options, in order of payoff:

1. **Sync more often.** Quarterly, the divergence stays small enough that the
   30-file conflict set shrinks toward single digits.
2. **Push additive changes upstream.** Several of our fixes are generic
   (Null Island guards were already ported *from* upstream — `5a97a934`). Any
   we upstream successfully stops being a conflict forever.
3. **Isolate custom code into new files.** Conflicts happen almost entirely in
   *shared* files. The Street View / Stories code lives in its own files and
   caused zero conflicts. Where practical, prefer a new file plus a one-line
   hook in the shared file over editing shared logic inline.

## Do NOT

- Merge `upstream/master` into `master` directly — creates a merge commit whose
  conflict resolution is invisible in later diffs, making the *next* sync worse.
- Auto-resolve conflicts in `app/javascript/` or `app/views/map/` — that is
  hand-built UI work with no test coverage; a wrong `--theirs` silently deletes
  a feature.
- Cherry-pick upstream commits one at a time to catch up. 4423 commits behind as
  of 2026-08-20; the classification pass showed 3574 of them do not touch our
  files at all, so taking upstream wholesale (this procedure) is strictly less
  work than picking.
