# Syncing this fork with upstream Dawarich

This fork (`vicquick/dawarich`) carries a large custom layer on top of
`Freika/dawarich` — Google-Maps-style search, Street View, live turn-by-turn
navigation, Interactive Stories, custom basemaps, semantic place search.

As of the 2026-08-20 sync that was **184 commits / ~53,900 insertions across 130
files**, diverged from merge-base `ecccc50d` (2026-06-11), replayed onto
upstream `97fad417` (4,423 commits ahead).

---

## Why not `git rebase upstream/master`

Tried and rejected 2026-08-20. Replaying 184 commits sequentially means
resolving the *same* hot files over and over — `maplibre_controller.js` alone is
touched by 29 of our commits and 92 of upstream's. The rebase conflicts on
commit 1 of 184 and every resolution changes what the next one conflicts
against. Hours of work, high risk of silently dropping a custom feature.

## The approach that works: squash-and-replay

Collapse the whole divergence into **one** patch and apply it to upstream's tip.
Conflicts get resolved **once per file** instead of once per commit.

Measured 2026-08-20: **100 of 130 files applied cleanly**, including every large
net-new file (Street View, Stories, custom layers) — ~50k of the ~53.9k
insertions. 30 files conflicted, 17 of them under 30 lines.

Our edits to shared files are overwhelmingly **additive**, which is why the
conflict surface stays small even though upstream rewrote a lot underneath.

---

## Procedure

### 0. Safety net

```bash
cd /root/dawarich-fork
git fetch origin && git fetch upstream
git branch backup-before-sync-$(date +%Y%m%d)
```

### 1. Capture the divergence, replay onto upstream

```bash
MB=$(git merge-base origin/master upstream/master)
git diff "$MB"..origin/master > /tmp/fork_custom.patch

git checkout -b sync-$(date +%Y%m%d) upstream/master

# See what will conflict BEFORE committing to the work. git apply is
# all-or-nothing — it exits 1 and rolls back — but stderr still enumerates
# every conflicting file, which is the point of this step.
git apply --3way /tmp/fork_custom.patch 2>/tmp/apply_err.txt
grep "with conflicts" /tmp/apply_err.txt \
  | sed "s/Applied patch to '//;s/' with conflicts.//" | sort
```

### 2. Resolve, one file at a time

For each conflicting path, `git log "$MB"..origin/master --oneline -- <path>`
shows what our change was *for*. Resolve by hand — never bulk `--ours`/`--theirs`
in `app/javascript/` or `app/views/`; that is hand-built UI with no test
coverage, and a wrong `--theirs` silently deletes a feature.

### 3. Run the doctor — before touching CI

```bash
bin/upstream-sync-doctor            # static, seconds, no database
bin/upstream-sync-doctor --rails    # + route checks, inside the app container
```

Every check exists because the 2026-08-20 sync broke in exactly that way and CI
took ~16 minutes per round trip to say so. Against the raw merge commit the
doctor reports **35 failures in seconds** — the same defects that otherwise
surface one CI run at a time.

| check | catches |
|---|---|
| `fork-files` | a fork-authored file lost in the merge |
| `schema` | a fork migration missing from `schema.rb` (CI uses `db:schema:load`, so it simply does not exist for specs) |
| `partials` | a view rendering a partial upstream deleted → `ActionView::MissingTemplate` |
| `js-imports` | file A took upstream and imports a symbol file B (took ours) never exported |
| `dsl-dupes` | a union merge registering `retry_on`/`has_one`/… twice, where the second silently wins |
| `stimulus` | views binding Stimulus targets the controller no longer declares — renders fine, silently stops syncing |
| `lint-base` | biome/rubocop against **`origin/master`**, the base CI actually diffs against |
| `toolchain` | a Dockerfile pinning a ruby/bundler version the repo no longer declares, or an entrypoint sourcing a script the Dockerfile never COPYs |
| `routes` | a greedy unconstrained route shadowing another (needs `--rails`) |

### 4. Run the suite locally, not through CI

CI is ~16 minutes per round trip. The full suite locally is ~7, and you can run
one file in seconds. Build the environment once:

```bash
docker network create dw-test
docker run -d --name dw-pg --network dw-test \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=dawarich_test postgis/postgis:17-3.5
docker run -d --name dw-redis --network dw-test redis
docker volume create dw-gems
docker run -d --name dw-app --network dw-test \
  -v "$PWD":/app -w /app -v dw-gems:/usr/local/bundle \
  -e RAILS_ENV=test -e DATABASE_HOST=dw-pg -e DATABASE_PORT=5432 \
  -e DATABASE_USERNAME=postgres -e DATABASE_PASSWORD=postgres \
  -e DATABASE_NAME=dawarich_test -e REDIS_URL=redis://dw-redis:6379 \
  ruby:3.4.9 sleep infinity

docker exec dw-app sh -c "apt-get update -qq && \
  apt-get install -y -qq libpq-dev libvips shared-mime-info cmake build-essential"
docker exec dw-app sh -c "gem install bundler -v 2.5.21 && bundle install --jobs 8"
docker exec dw-app sh -c "bundle exec rails db:schema:load"
docker exec dw-app sh -c "bundle exec rspec"
```

**Reload the schema before every full run** — not just after an interrupted one:

```bash
docker exec dw-app sh -c "bundle exec rails db:schema:load"
```

A full suite leaks ~12 users past transaction rollback, and
`spec/jobs/cache/preheating_job_spec.rb:60` asserts `Cache::PreheatingJob`
enqueues exactly 2 jobs while the job counts **every** user in the database. So
the second consecutive run reports a failure the first did not, on an
identically-ordered suite (`config.order = :random` is commented out, so
ordering is not the variable — accumulated rows are). Measured: 26 enqueued
after one interrupted run, 12 users still resident after a clean one.

That spec is byte-identical to upstream and passes on a fresh schema, so it is
upstream fragility surfaced by reusing a container, not fork damage and not
something to "fix" here — a divergence would just conflict at the next sync. CI
is immune because every run starts on a pristine database.

**The general rule:** a spec that fails in the full suite but passes alone is DB
residue until proven otherwise. Reload the schema and re-run before reading a
single line of the code it points at.

JS suite needs no container: `node --test spec/javascript/`. Run per-file — the
directory-mode aggregate under-reports.

### 5. Promote — and expect to deploy

Only once the doctor is clean, the suite is green locally, and CI agrees:

```bash
git checkout master && git reset --hard sync-<date>
git push --force-with-lease origin master
# or: gh pr merge <n> --merge   (keeps PR history; merge-base still lands on
# upstream's tip, so it costs the next sync nothing — verified 2026-08-22)
```

**Landing on `master` is a production deploy.** `dawarich-app` tracks `master`
behind a push webhook, so the merge itself ships. Budget for that before you
press the button:

```bash
# 1. Fresh dump FIRST. The nightly one can be hours old.
docker exec <db-container> pg_dump -U dawarich -d dawarich \
  | gzip > /mnt/storagebox/gex44/dawarich-pre-upstream-sync-$(date +%Y%m%d-%H%M%S).sql.gz

# 2. Baseline the counts, so you can prove afterwards what the migrations did.
psql -c "select 'points',count(*) from points
         union all select 'visits',count(*) from visits
         union all select 'tracks',count(*) from tracks
         union all select 'track_segments',count(*) from track_segments;"

# 3. Know what is about to run. docker/web-entrypoint.sh runs db:migrate on boot.
comm -13 <(git ls-tree <old-master> --name-only db/migrate/ | sed 's|db/migrate/||' | sort) \
         <(git ls-tree HEAD          --name-only db/migrate/ | sed 's|db/migrate/||' | sort)
```

**CI green does not mean deployable.** The 2026-08-22 deploy broke twice on
surfaces no test suite touches, both from the same blind spot — *upstream owns
the scripts, this fork owns the Dockerfile*:

- upstream bumped `.ruby-version` to 3.4.9 while our Dockerfile still pinned
  `ruby:3.4.6-slim`; the Gemfile reads `.ruby-version`, so `bundle install`
  exited 18 (`Bundler::RubyVersionMismatch`). The local test container happened
  to be on 3.4.9 already, which is exactly why the suite passed and the image
  could not build.
- upstream added `docker/entrypoint-env-guard.sh`, sourced by both web and
  sidekiq entrypoints; our Dockerfile had no `COPY` for it, so every boot died
  before `db:migrate`. **This one took production down** — the failed build had
  already retired the old container.

The `toolchain` check now covers both. Run the doctor before promoting, not
just before opening the PR.

**Redeploy the workers too.** `dawarich-sidekiq` is a *separate* Coolify app
(uuid `dhajiz6gsq75tjyl0co68in4`) and does not follow the web app's deploy. Left
alone it runs pre-sync job code against a post-migration schema. Confirm both
land on the same image:

```bash
docker inspect <web-container>     --format '{{.Config.Image}}'
docker inspect <sidekiq-container> --format '{{.Config.Image}}'
TOK=$(cat /root/.secrets/coolify-api-key)
curl -s -X POST "http://localhost:8000/api/v1/deploy?uuid=dhajiz6gsq75tjyl0co68in4" \
  -H "Authorization: Bearer $TOK"
```

---

## The Q&A pass — the part no script can do

The doctor proves *mechanical* integrity. It cannot tell you whether a
divergence is a bug or a deliberate fork choice. That judgement is the whole
job, and it reduces to **three classes**. Establish which by comparing the
artifact at three points:

```bash
MB=$(git merge-base origin/master upstream/master)
for ref in $MB origin/master upstream/master; do
  printf '%-16s ' "$(git rev-parse --short $ref)"
  git show $ref:<path> 2>/dev/null | grep -c '<the thing>'
done
```

**Class 1 — fork work lost in the merge.** On `origin/master`, absent at
merge-base, absent upstream, and now missing or degraded.
→ **Restore from `origin/master`.** No question needed.
*2026-08-20: 26 Stimulus targets + 3 handlers, dropped by the
`maplibre_controller.js` resolution while the view kept binding them.*

**Class 2 — inherited code upstream retired.** Present at merge-base, unchanged
by us, deleted or rewritten upstream.
→ **Follow upstream.** No question needed. Verify "unchanged by us" — identical
counts at merge-base and on `origin/master` — or it is really Class 3.
*2026-08-20: `_filter_count.html.erb` and its two render calls; upstream's spec
now asserts the response does **not** contain `filter-count-`.*

**Class 3 — deliberate fork behaviour vs upstream's new expectation.** Present
at merge-base, changed by **both** sides.
→ **ASK. This is the Q&A.** Both sides are intentional; only you know which the
fork should keep.

### What a Class 3 question looks like

Ask about **behaviour**, never about test mechanics. Each needs: what the fork
does, what upstream now does, what breaks either way.

> Upstream's new `spec/requests/map/routing_spec.rb` asserts `/map/v1` redirects
> to `/map/v2`. This fork made `/map` canonical and un-versioned (documented in
> `routes.rb`), so it redirects to `/map`.
> Keep the fork's canonical `/map`, or adopt upstream's versioned URL?

> Upstream drops video assets from photo results. This fork keeps them — the
> comment says dropping silently shrank a trip's gallery to 201 of 202 assets,
> and Immich serves a poster frame on the same thumbnail endpoint.
> Keep videos?

Both were answered "keep the fork's behaviour", so the *inherited specs* were
updated to match — with a comment naming the fork decision, so the next sync
classifies them instantly instead of re-litigating.

### The trap

A Class 3 divergence usually surfaces as a **failing inherited spec**, and the
tempting move is to edit the spec until it passes. That is only correct once you
have confirmed the fork's behaviour is deliberate. Otherwise you have just
deleted the test that caught a real regression.

Check before editing any spec:

```bash
# Did this spec pass on master, before the sync? If not, the fork's behaviour
# and the inherited expectation have disagreed for a while and the sync merely
# exposed it.
git show origin/master:<spec> | grep -n '<assertion>'
git show origin/master:<the code under test> | sed -n '/def method/,/^  end/p'
```

*2026-08-20: seven `/map/v\d` assertions and the changelog-widget specs had been
failing on master too. They were stale, not sync damage — but that only became
safe to conclude after checking.*

---

## Making future syncs cheaper

1. **Sync more often.** Quarterly, the divergence stays small enough that the
   30-file conflict set shrinks toward single digits.
2. **Push additive changes upstream.** Anything generic we upstream successfully
   stops being a conflict forever. The Null Island guards were already ported
   *from* upstream (`5a97a934`).
3. **Isolate custom code into new files.** Conflicts happen almost entirely in
   *shared* files. Street View and Stories live in their own files and caused
   zero conflicts. Prefer a new file plus a one-line hook over editing shared
   logic inline.
4. **Never squat an upstream name.** Our unnamed tile-proxy routes inside
   `namespace :map` claimed the bare `map` name, so `map_path` resolved to the
   tile proxy and `/map` had to be called `:map_v2`. Give fork routes explicit
   `as:` names.
5. **Keep fork behaviour documented in the code.** Every "vicquick fork:" comment
   turned a Class 3 question into a two-minute answer. The undocumented ones cost
   far more.

## Do NOT

- Merge `upstream/master` into `master` directly — creates a merge commit whose
  conflict resolution is invisible in later diffs, making the *next* sync worse.
- Bulk-resolve `app/javascript/` or `app/views/` with `--ours`/`--theirs`.
- Cherry-pick upstream commits to catch up. 4,423 commits behind as of
  2026-08-20; the classification pass showed 3,574 of them touch none of our
  files, so taking upstream wholesale is strictly less work.
- Verify lint against a local `master`. CI diffs against `origin/master`, and on
  a sync branch local `master` is stale by design — that gap let a formatting
  failure through a "green" local run.
- Trust a green doctor as "the sync is done". It cannot see stale expectations.
