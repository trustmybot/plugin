// server/change-impact-worker.ts
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

// ../mcp/trajectory-server/src/task-rework.ts
var SWE_SPAWN_SQL = "agent_type = 'swe' AND COALESCE(exit_reason, '') <> 'swept_orphan'";

// ../mcp/trajectory-server/src/change-impact/metrics.ts
var RUN_COLUMNS = "id, task_id, session_id, started_at, plugin_version, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, hook_block_tokens";
var DONE_TASK_SQL = "status = 'closed' AND commit_sha IS NOT NULL AND commit_sha <> '' AND completed_at IS NOT NULL";
function measured(r) {
  return r.tokens_in !== null;
}
function tokens(r) {
  return (r.tokens_in ?? 0) + (r.tokens_out ?? 0) + (r.cache_read_tokens ?? 0) + (r.cache_creation_tokens ?? 0);
}
function time(at) {
  return at === null ? Number.NaN : Date.parse(at);
}
function groupBy(rows, key) {
  const out = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}
function sweRunsByTask(reader) {
  const rows = reader.all(
    `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE ${SWE_SPAWN_SQL} AND task_id IS NOT NULL ORDER BY task_id, id`
  );
  return groupBy(rows, (r) => r.task_id);
}
function doneTaskIds(reader) {
  return new Set(reader.all(`SELECT id FROM tasks WHERE ${DONE_TASK_SQL}`).map((r) => r.id));
}
function latestRunAtOrBefore(runs, at) {
  const t = time(at);
  let best;
  for (const r of runs) {
    const rt = time(r.started_at);
    if (Number.isNaN(rt) || rt > t) continue;
    if (!best || rt >= time(best.started_at)) best = r;
  }
  return best;
}
var sweReworkRatio = {
  id: "swe_rework_ratio",
  label: "swe rework ratio",
  unit: "x first run tokens",
  direction: "lower",
  samples(reader) {
    const out = [];
    for (const runs of sweRunsByTask(reader).values()) {
      const first = runs[0];
      if (!measured(first)) continue;
      const base = tokens(first);
      if (base <= 0) continue;
      for (const r of runs.slice(1)) {
        if (!measured(r) || r.started_at === null) continue;
        out.push({ at: r.started_at, version: r.plugin_version, value: tokens(r) / base });
      }
    }
    return out;
  }
};
var tokensPerTask = {
  id: "tokens_per_task",
  label: "tokens per task",
  unit: "tokens",
  direction: "lower",
  samples(reader) {
    const done = doneTaskIds(reader);
    const swe = sweRunsByTask(reader);
    const all = groupBy(
      reader.all(
        `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE task_id IS NOT NULL AND COALESCE(exit_reason, '') <> 'swept_orphan'`
      ),
      (r) => r.task_id
    );
    const out = [];
    for (const [taskId, runs] of swe) {
      if (!done.has(taskId)) continue;
      const first = runs[0];
      if (first.started_at === null) continue;
      const taskRuns = (all.get(taskId) ?? []).filter(measured);
      if (taskRuns.length === 0) continue;
      out.push({ at: first.started_at, version: first.plugin_version, value: taskRuns.reduce((s, r) => s + tokens(r), 0) });
    }
    return out;
  }
};
var reworksPerTask = {
  id: "reworks_per_task",
  label: "reworks per task",
  unit: "swe spawns after the first",
  direction: "lower",
  samples(reader) {
    const done = doneTaskIds(reader);
    const out = [];
    for (const [taskId, runs] of sweRunsByTask(reader)) {
      if (!done.has(taskId)) continue;
      const first = runs[0];
      if (first.started_at === null) continue;
      out.push({ at: first.started_at, version: first.plugin_version, value: runs.length - 1 });
    }
    return out;
  }
};
var reviewFailRate = {
  id: "review_fail_rate",
  label: "review fail rate",
  unit: "share of verdicts",
  direction: "lower",
  samples(reader) {
    const reviewers = groupBy(
      reader.all(`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE agent_type = 'code-reviewer' AND task_id IS NOT NULL`),
      (r) => r.task_id
    );
    const attempts = reader.all(
      "SELECT task_id, verdict, created_at FROM validation_attempts ORDER BY id"
    );
    return attempts.map((a) => ({
      at: a.created_at,
      version: latestRunAtOrBefore(reviewers.get(a.task_id) ?? [], a.created_at)?.plugin_version ?? null,
      value: a.verdict === "fail" ? 1 : 0
    }));
  }
};
var verificationPassRate = {
  id: "verification_pass_rate",
  label: "verification pass rate",
  unit: "share of first gate runs",
  direction: "higher",
  samples(reader) {
    const swe = sweRunsByTask(reader);
    const firsts = reader.all(
      "SELECT v.task_id, v.started_at, v.exit_code, v.timed_out FROM verification_runs v WHERE v.source = 'gate' AND v.id = (SELECT w.id FROM verification_runs w WHERE w.task_id = v.task_id AND w.source = 'gate' ORDER BY w.started_at, w.id LIMIT 1)"
    );
    return firsts.map((v) => ({
      at: v.started_at,
      version: latestRunAtOrBefore(swe.get(v.task_id) ?? [], v.started_at)?.plugin_version ?? null,
      value: v.exit_code === 0 && v.timed_out === 0 ? 1 : 0
    }));
  }
};
var hookBlockTokensPerRun = {
  id: "hook_block_tokens_per_run",
  label: "hook-block tokens per swe run",
  unit: "tokens",
  direction: "lower",
  samples(reader) {
    return reader.all(`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE ${SWE_SPAWN_SQL} AND hook_block_tokens IS NOT NULL AND started_at IS NOT NULL`).map((r) => ({ at: r.started_at, version: r.plugin_version, value: r.hook_block_tokens }));
  }
};
var broTokensPerSession = {
  id: "bro_tokens_per_session",
  label: "bro tokens per session",
  unit: "tokens",
  direction: "lower",
  samples(reader) {
    const rows = reader.all(
      `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE agent_type = 'bro' AND session_id IS NOT NULL ORDER BY session_id, started_at, id`
    );
    const out = [];
    for (const runs of groupBy(rows, (r) => r.session_id).values()) {
      const first = runs[0];
      const counted = runs.filter(measured);
      if (first.started_at === null || counted.length === 0) continue;
      out.push({ at: first.started_at, version: first.plugin_version, value: counted.reduce((s, r) => s + tokens(r), 0) });
    }
    return out;
  }
};
var METRICS = [
  sweReworkRatio,
  tokensPerTask,
  reworksPerTask,
  reviewFailRate,
  verificationPassRate,
  hookBlockTokensPerRun,
  broTokensPerSession
];

// ../mcp/trajectory-server/src/change-impact/attribution.ts
import { execFileSync } from "node:child_process";
var PR_SUBJECT = /\(#(\d+)\)\s*$/;
var DEV_VERSION = /^\d+\.\d+\.\d+-dev\.\d+\.gh(\d+)$/;
var RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/;
var BuildHistory = class {
  constructor(git) {
    this.git = git;
    this.commits = git.commits();
    this.times = this.commits.map((c) => Date.parse(c.at));
    this.commits.forEach((c, i) => {
      this.shaIndex.set(c.sha, i);
      const m = PR_SUBJECT.exec(c.subject);
      if (m) this.prIndex.set(Number(m[1]), i);
    });
  }
  git;
  commits;
  times;
  shaIndex = /* @__PURE__ */ new Map();
  prIndex = /* @__PURE__ */ new Map();
  tagIndex = /* @__PURE__ */ new Map();
  get target() {
    return this.git.target;
  }
  indexOfPr(pr) {
    return this.prIndex.get(pr);
  }
  /** Every PR on the target with its first-parent index, oldest first. */
  prs() {
    return [...this.prIndex.entries()].map(([pr, idx]) => ({ pr, idx })).sort((a, b) => a.idx - b.idx);
  }
  attribute(version, at) {
    if (version === null) {
      const idx = this.newestAtOrBefore(Date.parse(at));
      return idx === null ? null : { idx, estimated: true };
    }
    const dev = DEV_VERSION.exec(version);
    if (dev) {
      const idx = this.prIndex.get(Number(dev[1]));
      return idx === void 0 ? null : { idx, estimated: false };
    }
    if (RELEASE_VERSION.test(version)) {
      const idx = this.tagIdx(`v${version}`);
      return idx === null ? null : { idx, estimated: false };
    }
    return null;
  }
  tagIdx(tag) {
    if (!this.tagIndex.has(tag)) {
      const sha = this.git.mergeBase(tag);
      this.tagIndex.set(tag, sha === null ? null : this.shaIndex.get(sha) ?? null);
    }
    return this.tagIndex.get(tag) ?? null;
  }
  newestAtOrBefore(t) {
    if (Number.isNaN(t)) return null;
    let found = null;
    for (let i = 0; i < this.times.length; i++) {
      if (this.times[i] <= t) found = i;
    }
    return found;
  }
};
var defaultGit = (path, args) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
function succeeds(git, path, args) {
  try {
    git(path, args);
    return true;
  } catch {
    return false;
  }
}
function refExists(git, path, ref) {
  return succeeds(git, path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}
function hasOriginRemote(git, path) {
  return succeeds(git, path, ["remote", "get-url", "origin"]);
}
function baseRef(git, path, targetBranch) {
  if (targetBranch) {
    if (refExists(git, path, `origin/${targetBranch}`)) return `origin/${targetBranch}`;
    if (refExists(git, path, targetBranch)) return targetBranch;
  }
  try {
    const head = git(path, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).trim();
    if (head) return head.replace(/^refs\/remotes\//, "");
  } catch {
  }
  return "HEAD";
}
function gitSourceFor(git, path, target) {
  return {
    target,
    commits() {
      return git(path, ["log", "--first-parent", target, "--format=%H%x09%cI%x09%s"]).split("\n").filter((l) => l.length > 0).map((l) => {
        const [sha, at, ...rest] = l.split("	");
        return { sha, at, subject: rest.join("	") };
      }).reverse();
    },
    mergeBase(ref) {
      try {
        return git(path, ["merge-base", target, ref]).trim() || null;
      } catch {
        return null;
      }
    }
  };
}

// ../mcp/trajectory-server/src/change-impact/providers.ts
var CHANGE_SOURCES = ["plugin_version", "agent_surface", "tmb_events"];
var AGENT_SURFACE_KEY = "change_impact_agent_surface";
var DEFAULT_AGENT_SURFACE = ["CLAUDE.md", ".claude/agents/**", ".claude/skills/**", ".claude/settings*.json"];
function providerContext(reader, git = defaultGit) {
  const repos = reader.all("SELECT name, path, target_branch FROM repos ORDER BY name");
  return { reader, repos, git };
}
var caches = /* @__PURE__ */ new WeakMap();
function memo(ctx, key, fn) {
  let cache2 = caches.get(ctx);
  if (!cache2) {
    cache2 = /* @__PURE__ */ new Map();
    caches.set(ctx, cache2);
  }
  if (!cache2.has(key)) cache2.set(key, fn());
  return cache2.get(key);
}
function samplesOf(ctx, metric) {
  return memo(ctx, `samples:${metric.id}`, () => metric.samples(ctx.reader).filter((s) => !Number.isNaN(Date.parse(s.at))));
}
function iso(at) {
  return new Date(Date.parse(at)).toISOString();
}
var SQUASH_SUFFIX = /\(#(\d+)\)\s*$/;
var MERGE_REQUEST = /See merge request \S+!(\d+)/;
function changeIdOf(hasRemote, subject, body, sha) {
  if (hasRemote) {
    const m = SQUASH_SUFFIX.exec(subject) ?? MERGE_REQUEST.exec(body);
    if (m) return m[1];
  }
  return sha.slice(0, 12);
}
function versionState(ctx) {
  return memo(ctx, "plugin_version", () => {
    const firstSeen = /* @__PURE__ */ new Map();
    for (const metric of METRICS) {
      for (const s of samplesOf(ctx, metric)) {
        if (s.version === null) continue;
        const t = Date.parse(s.at);
        if (!firstSeen.has(s.version) || t < firstSeen.get(s.version)) firstSeen.set(s.version, t);
      }
    }
    const versions = [...firstSeen.entries()].map(([version, at]) => ({ version, at })).sort((a, b) => a.at - b.at || a.version.localeCompare(b.version));
    const devPrs = versions.flatMap((v) => {
      const m = DEV_VERSION.exec(v.version);
      return m ? [Number(m[1])] : [];
    });
    return { resolver: devPrs.length > 0 ? resolveDevBuilds(ctx, devPrs) : null, versions };
  });
}
function resolveDevBuilds(ctx, prs) {
  let best = null;
  for (const row of ctx.repos) {
    let history;
    try {
      history = new BuildHistory(gitSourceFor(ctx.git, row.path, baseRef(ctx.git, row.path, row.target_branch)));
    } catch {
      continue;
    }
    const hits = prs.filter((pr) => history.indexOfPr(pr) !== void 0).length;
    if (hits > 0 && (best === null || hits > best.hits)) best = { repo: row.name, path: row.path, history, hits };
  }
  return best && { repo: best.repo, path: best.path, history: best.history };
}
function devResolver(ctx) {
  return versionState(ctx).resolver;
}
function attributed(ctx, resolver, metric) {
  return memo(
    ctx,
    `build:${metric.id}`,
    () => samplesOf(ctx, metric).map((s) => {
      const a = resolver.history.attribute(s.version, s.at);
      return { t: Date.parse(s.at), value: s.value, idx: a?.idx ?? null, estimated: a?.estimated ?? false };
    })
  );
}
function plain(s) {
  return { t: Date.parse(s.at), value: s.value, estimated: false };
}
var pluginVersionProvider = {
  source: "plugin_version",
  list(ctx) {
    const { resolver, versions } = versionState(ctx);
    if (resolver) {
      const { history, repo } = resolver;
      return history.prs().map(({ pr, idx }) => ({
        source: "plugin_version",
        id: String(pr),
        label: history.commits[idx].subject,
        at: iso(history.commits[idx].at),
        kind: "build",
        repo
      }));
    }
    return versions.slice(1).map((v) => ({
      source: "plugin_version",
      id: v.version,
      label: v.version,
      at: new Date(v.at).toISOString(),
      kind: "version",
      repo: null
    }));
  },
  split(event, ctx, metric) {
    const { resolver, versions } = versionState(ctx);
    if (resolver && event.kind === "build") {
      const idxC = resolver.history.indexOfPr(Number(event.id));
      const samples2 = attributed(ctx, resolver, metric);
      return {
        before: samples2.filter((s) => s.idx !== null && s.idx < idxC),
        after: samples2.filter((s) => s.idx !== null && s.idx >= idxC),
        unattributed: samples2.filter((s) => s.idx === null)
      };
    }
    const i = versions.findIndex((v) => v.version === event.id);
    const previous = versions[i - 1]?.version;
    const samples = samplesOf(ctx, metric);
    return {
      before: samples.filter((s) => s.version === previous).map(plain),
      after: samples.filter((s) => s.version === event.id).map(plain),
      unattributed: samples.filter((s) => s.version === null).map(plain)
    };
  },
  measuredWith(event, ctx) {
    const { resolver } = versionState(ctx);
    if (!resolver || event.kind !== "build") return [];
    const idxC = resolver.history.indexOfPr(Number(event.id));
    let lo = -1;
    let hi = Number.POSITIVE_INFINITY;
    for (const metric of METRICS) {
      for (const s of attributed(ctx, resolver, metric)) {
        if (s.idx === null) continue;
        if (s.idx < idxC) lo = Math.max(lo, s.idx);
        else hi = Math.min(hi, s.idx);
      }
    }
    return resolver.history.prs().filter((p) => p.idx > lo && p.idx < hi && String(p.pr) !== event.id).map((p) => ({ source: "plugin_version", id: String(p.pr), repo: event.repo }));
  }
};
function agentSurfaceGlobs(reader, repo) {
  const row = reader.get("SELECT value_json FROM plugin_config WHERE key = ?", [AGENT_SURFACE_KEY]);
  let entries = DEFAULT_AGENT_SURFACE;
  if (row) {
    try {
      const value = JSON.parse(row.value_json);
      if (Array.isArray(value) && value.every((el) => typeof el === "string")) entries = value;
    } catch {
    }
  }
  return entries.flatMap((entry) => {
    const scoped = /^([^:*?[\]/]+):(.+)$/.exec(entry);
    if (!scoped) return [entry];
    return scoped[1] === repo ? [scoped[2]] : [];
  });
}
function surfaceCommits(ctx, row) {
  const globs = agentSurfaceGlobs(ctx.reader, row.name);
  if (globs.length === 0) return [];
  const base = baseRef(ctx.git, row.path, row.target_branch);
  const remote = hasOriginRemote(ctx.git, row.path);
  const out = ctx.git(row.path, [
    "log",
    "--first-parent",
    "--format=%x1e%H%x09%cI%x09%s%x09%b",
    base,
    "--",
    ...globs.map((g) => `:(glob)${g}`)
  ]);
  return out.split("").filter((r) => r.trim().length > 0).map((record) => {
    const [sha, at, subject, ...body] = record.split("	");
    return {
      source: "agent_surface",
      id: changeIdOf(remote, subject, body.join("	"), sha),
      label: subject,
      at: iso(at),
      kind: "commit",
      repo: row.name
    };
  });
}
function surfaceEvents(ctx) {
  return memo(
    ctx,
    "agent_surface",
    () => ctx.repos.flatMap((row) => {
      try {
        return surfaceCommits(ctx, row);
      } catch {
        return [];
      }
    })
  );
}
function timeSplit(event, ctx, metric) {
  const at = Date.parse(event.at);
  const samples = samplesOf(ctx, metric).map(plain);
  return { before: samples.filter((s) => s.t < at), after: samples.filter((s) => s.t >= at), unattributed: [] };
}
function timeMeasuredWith(events, event, windowMs) {
  const at = Date.parse(event.at);
  return events.filter((e) => e !== event && !(e.id === event.id && e.repo === event.repo)).filter((e) => {
    const t = Date.parse(e.at);
    return t >= at && t <= at + windowMs;
  }).map((e) => ({ source: e.source, id: e.id, repo: e.repo }));
}
var agentSurfaceProvider = {
  source: "agent_surface",
  list: surfaceEvents,
  split: timeSplit,
  measuredWith(event, ctx, windowMs) {
    return timeMeasuredWith(surfaceEvents(ctx), event, windowMs);
  }
};
var QUOTED_NAME = /'([^']+)'/;
function rowsOrNone(ctx, sql) {
  try {
    return ctx.reader.all(sql);
  } catch {
    return [];
  }
}
function objectOf(json) {
  if (json === null) return null;
  try {
    const value = JSON.parse(json);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
function tmbEvent(id, kind, label, at) {
  if (Number.isNaN(Date.parse(at))) return [];
  return [{ source: "tmb_events", id, label, at: iso(at), kind, repo: null }];
}
function auditEvent(row) {
  const content = objectOf(row.content_json);
  if (content === null) return [];
  const id = `audit-${row.id}`;
  if (row.event_type === "config_changed") {
    return typeof content["key"] === "string" ? tmbEvent(id, "config", `config changed: ${content["key"]}`, row.created_at) : [];
  }
  const fromContent = typeof content["name"] === "string" && content["name"].length > 0 ? content["name"] : void 0;
  const name = fromContent ?? QUOTED_NAME.exec(row.summary ?? "")?.[1] ?? "cheatcode";
  return tmbEvent(id, "cheatcode_uninstall", `cheatcode uninstalled: ${name}`, row.created_at);
}
function tmbEvents(ctx) {
  return memo(ctx, "tmb_events", () => [
    ...rowsOrNone(
      ctx,
      "SELECT id, name, installed_at FROM cheatcodes WHERE installed_at IS NOT NULL AND status IN ('active', 'installed') AND origin != 'builtin' ORDER BY id"
    ).flatMap((r) => tmbEvent(`cheatcode-${r.id}`, "cheatcode_install", `cheatcode installed: ${r.name}`, r.installed_at)),
    ...rowsOrNone(
      ctx,
      "SELECT id, event_type, summary, content_json, created_at FROM audit WHERE event_type IN ('cheatcode_uninstalled', 'config_changed') ORDER BY id"
    ).flatMap(auditEvent)
  ]);
}
var tmbEventsProvider = {
  source: "tmb_events",
  list: tmbEvents,
  split: timeSplit,
  measuredWith(event, ctx, windowMs) {
    return timeMeasuredWith(tmbEvents(ctx), event, windowMs);
  }
};
var PROVIDERS = [pluginVersionProvider, agentSurfaceProvider, tmbEventsProvider];

// ../mcp/trajectory-server/src/change-impact/stats.ts
var BOOTSTRAP_RESAMPLES = 2e3;
function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}
function ratioOfMedians(before, after) {
  const b = median(before);
  const a = median(after);
  if (a === null || b === null || b === 0) return null;
  return a / b;
}
function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function resampleMedian(sorted, counts, rand) {
  const n = sorted.length;
  counts.fill(0);
  for (let i = 0; i < n; i++) counts[Math.floor(rand() * n)]++;
  const lo = n - 1 >> 1;
  const hi = n >> 1;
  let seen = 0;
  let loVal = null;
  for (let i = 0; i < n; i++) {
    seen += counts[i];
    if (loVal === null && seen > lo) loVal = sorted[i];
    if (seen > hi) return (loVal + sorted[i]) / 2;
  }
  return sorted[n - 1];
}
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function bootstrapRatioCi(before, after, seed, resamples = BOOTSTRAP_RESAMPLES) {
  if (before.length === 0 || after.length === 0) return null;
  const rand = mulberry32(seed);
  const b = [...before].sort((x, y) => x - y);
  const a = [...after].sort((x, y) => x - y);
  const bCounts = new Uint32Array(b.length);
  const aCounts = new Uint32Array(a.length);
  const ratios = [];
  for (let i = 0; i < resamples; i++) {
    const bm = resampleMedian(b, bCounts, rand);
    const am = resampleMedian(a, aCounts, rand);
    if (bm !== 0) ratios.push(am / bm);
  }
  if (ratios.length === 0) return null;
  ratios.sort((x, y) => x - y);
  return [quantile(ratios, 0.025), quantile(ratios, 0.975)];
}
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(
    -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
  );
  return x >= 0 ? r : 2 - r;
}
function mannWhitneyU(x, y) {
  const n1 = x.length;
  const n2 = y.length;
  const all = [...x.map((v) => ({ v, g: 0 })), ...y.map((v) => ({ v, g: 1 }))].sort((a, b) => a.v - b.v);
  const n = all.length;
  let r1 = 0;
  let tieSum = 0;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && all[j + 1].v === all[i].v) j++;
    const rank = (i + j + 2) / 2;
    const t = j - i + 1;
    tieSum += t * t * t - t;
    for (let k = i; k <= j; k++) if (all[k].g === 0) r1 += rank;
    i = j + 1;
  }
  const u = r1 - n1 * (n1 + 1) / 2;
  const mu = n1 * n2 / 2;
  const variance = n1 * n2 / 12 * (n + 1 - tieSum / (n * (n - 1)));
  if (!(variance > 0)) return { u, z: 0, p: 1 };
  const diff = Math.abs(u - mu);
  const z = Math.max(0, diff - 0.5) / Math.sqrt(variance);
  return { u, z: u >= mu ? z : -z, p: Math.min(1, erfc(z / Math.SQRT2)) };
}
function holm(ps) {
  const m = ps.length;
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const out = new Array(m);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    out[i] = running;
  });
  return out;
}

// ../mcp/trajectory-server/src/change-impact/declared.ts
var METRIC_LINE = /^Metric: ([a-z][a-z0-9_]{0,47}) (lower|higher)$/;
var FRAGMENT_PATH = /^changelog\.d\/(?!README\.md$)[^/]+\.md$/;
var BLANK = /^[ \t\n\v\f\r]*$/;
function declarationOf(fragment) {
  let last = fragment.length - 1;
  while (last > 0 && BLANK.test(fragment[last] ?? "")) last--;
  if (last < 1) return null;
  const m = METRIC_LINE.exec(fragment[last] ?? "");
  if (!m || !METRICS.some((metric) => metric.id === m[1])) return null;
  return { metric: m[1], direction: m[2] };
}
function parseDeclaredLog(out) {
  const byPr = /* @__PURE__ */ new Map();
  for (const record of out.split("")) {
    const [subject = "", ...patch] = record.split("\n");
    const pr = PR_SUBJECT.exec(subject);
    if (!pr) continue;
    const files = [];
    let current = null;
    let inHunk = false;
    for (const line of patch) {
      if (line.startsWith("diff --git ")) {
        current = null;
        inHunk = false;
      } else if (!inHunk && line.startsWith("+++ ")) {
        const path = line.slice(4).replace(/^b\//, "");
        current = FRAGMENT_PATH.test(path) ? [] : null;
        if (current) files.push(current);
      } else if (line.startsWith("@@")) {
        inHunk = true;
      } else if (inHunk && current && line.startsWith("+")) {
        current.push(line.slice(1));
      }
    }
    const declared = files.flatMap((f) => declarationOf(f) ?? []);
    if (declared.length > 0) byPr.set(Number(pr[1]), [...byPr.get(Number(pr[1])) ?? [], ...declared]);
  }
  return byPr;
}
var cache = /* @__PURE__ */ new WeakMap();
function declaredByPr(ctx) {
  let byPr = cache.get(ctx);
  if (byPr) return byPr;
  byPr = /* @__PURE__ */ new Map();
  const resolver = devResolver(ctx);
  if (resolver) {
    try {
      byPr = parseDeclaredLog(
        ctx.git(resolver.path, [
          "log",
          "--first-parent",
          "--diff-filter=A",
          "--no-renames",
          "--no-color",
          "--no-ext-diff",
          "-p",
          "--format=%x1e%s",
          resolver.history.target,
          "--",
          "changelog.d/"
        ])
      );
    } catch {
      byPr = /* @__PURE__ */ new Map();
    }
  }
  cache.set(ctx, byPr);
  return byPr;
}
var MOVED = {
  improved: "better",
  regressed: "worse",
  no_change: "not_moved",
  not_enough_data: "not_enough_data"
};
function outcomeOf(declared, better, measured2) {
  const moved = MOVED[measured2];
  if (moved !== "better" && moved !== "worse") return moved;
  const way = moved === "better" ? better : better === "lower" ? "higher" : "lower";
  return way === declared ? "as_declared" : "wrong_way";
}

// ../mcp/trajectory-server/src/change-impact/index.ts
var DEFAULT_WINDOW_DAYS = 14;
var DEFAULT_MAX_SAMPLES = 200;
var DEFAULT_LIMIT = 20;
var MIN_SAMPLES = 20;
var ALPHA = 0.05;
var DAY_MS = 864e5;
function positiveInt(v, fallback, name) {
  if (v === void 0) return fallback;
  if (!Number.isInteger(v) || v <= 0) throw new Error(`${name} must be a positive integer`);
  return v;
}
function checkSource(source) {
  if (!CHANGE_SOURCES.includes(source)) throw new Error(`source must be one of ${CHANGE_SOURCES.join(", ")}`);
  return source;
}
function side(samples, unattributed) {
  const values = samples.map((s) => s.value);
  return {
    values,
    stats: {
      n: values.length,
      median: median(values),
      mean: mean(values),
      estimated_n: samples.filter((s) => s.estimated).length,
      unattributed_n: unattributed
    }
  };
}
function daily(samples) {
  const byDay = /* @__PURE__ */ new Map();
  for (const s of samples) {
    const day = new Date(s.t).toISOString().slice(0, 10);
    const values = byDay.get(day);
    if (values) values.push(s.value);
    else byDay.set(day, [s.value]);
  }
  return [...byDay.keys()].sort().map((day) => {
    const values = byDay.get(day);
    return { day, n: values.length, median: median(values) };
  });
}
function verdictOf(direction, before, after, pHolm) {
  if (pHolm >= ALPHA) return "no_change";
  let shift = (after.median ?? 0) - (before.median ?? 0);
  if (shift === 0) shift = (after.mean ?? 0) - (before.mean ?? 0);
  if (shift === 0) return "no_change";
  return shift < 0 === (direction === "lower") ? "improved" : "regressed";
}
function impactOf(ctx, provider, event, windowDays, maxSamples, metricFilter, series) {
  const at = Date.parse(event.at);
  const windowMs = windowDays * DAY_MS;
  const inWindow = (s) => Math.abs(s.t - at) <= windowMs;
  const nearest = (a, b) => Math.abs(a.t - at) - Math.abs(b.t - at);
  const partial = METRICS.map((metric) => {
    const split = provider.split(event, ctx, metric);
    const unattributed = split.unattributed.filter(inWindow);
    const kept = (samples) => samples.filter(inWindow).sort(nearest).slice(0, maxSamples);
    const beforeSamples = kept(split.before);
    const afterSamples = kept(split.after);
    const b = side(beforeSamples, unattributed.filter((s) => s.t < at).length);
    const a = side(afterSamples, unattributed.filter((s) => s.t >= at).length);
    const enough = b.stats.n >= MIN_SAMPLES && a.stats.n >= MIN_SAMPLES;
    return {
      metric,
      series: series ? { before: daily(beforeSamples), after: daily(afterSamples) } : void 0,
      before: b.stats,
      after: a.stats,
      ratio_of_medians: ratioOfMedians(b.values, a.values),
      ratio_ci: enough && b.stats.median !== 0 ? bootstrapRatioCi(b.values, a.values, hashSeed(`${event.id}:${metric.id}`)) : null,
      p: enough ? mannWhitneyU(a.values, b.values).p : null
    };
  });
  const tested = partial.filter((m) => m.p !== null);
  const adjusted = holm(tested.map((m) => m.p));
  const pHolm = new Map(tested.map((m, i) => [m.metric.id, adjusted[i]]));
  const all = partial.map((m) => {
    const ph = pHolm.get(m.metric.id) ?? null;
    return {
      id: m.metric.id,
      label: m.metric.label,
      unit: m.metric.unit,
      direction: m.metric.direction,
      before: m.before,
      after: m.after,
      ratio_of_medians: m.ratio_of_medians,
      ratio_ci: m.ratio_ci,
      p: m.p,
      p_holm: ph,
      verdict: ph === null ? "not_enough_data" : verdictOf(m.metric.direction, m.before, m.after, ph),
      ...m.series ? { series: m.series } : {}
    };
  });
  const metrics = all.filter((m) => metricFilter === void 0 || m.id === metricFilter);
  const declared = declaredOf(ctx, event, all);
  return {
    source: event.source,
    id: event.id,
    label: event.label,
    at: event.at,
    kind: event.kind,
    repo: event.repo,
    measured_with: provider.measuredWith(event, ctx, windowMs),
    metrics,
    ...declared.length > 0 ? { declared } : {}
  };
}
function declaredOf(ctx, event, metrics) {
  if (event.source !== "plugin_version" || event.kind !== "build") return [];
  return (declaredByPr(ctx).get(Number(event.id)) ?? []).flatMap((d) => {
    const m = metrics.find((x) => x.id === d.metric);
    return m ? [{ metric: d.metric, direction: d.direction, outcome: outcomeOf(d.direction, m.direction, m.verdict) }] : [];
  });
}
function computeChangeImpact(reader, ctx = providerContext(reader), opts = {}) {
  const windowDays = positiveInt(opts.window_days, DEFAULT_WINDOW_DAYS, "window_days");
  const maxSamples = positiveInt(opts.max_samples, DEFAULT_MAX_SAMPLES, "max_samples");
  const limit = positiveInt(opts.limit, DEFAULT_LIMIT, "limit");
  if (opts.metric !== void 0 && !METRICS.some((m) => m.id === opts.metric)) {
    throw new Error(`unknown metric ${opts.metric}; one of ${METRICS.map((m) => m.id).join(", ")}`);
  }
  if (opts.change !== void 0) {
    const source = checkSource(opts.change.source);
    const id = opts.change.id;
    if (typeof id !== "string" || id.length === 0) throw new Error("change.id must be a non-empty string");
    const repo = opts.change.repo ?? void 0;
    if (repo !== void 0 && (typeof repo !== "string" || repo.length === 0)) throw new Error("change.repo must be a non-empty string");
    const provider = PROVIDERS.find((p) => p.source === source);
    const matches = provider.list(ctx).filter((e) => e.id === id && (repo === void 0 || e.repo === repo));
    if (matches.length === 0) throw new Error(`unknown change ${source}:${id}${repo === void 0 ? "" : ` in repo ${repo}`}`);
    if (matches.length > 1) {
      const repos = [...new Set(matches.map((e) => e.repo ?? "(none)"))].join(", ");
      throw new Error(`ambiguous change ${source}:${id} matches repos ${repos}; pass change.repo`);
    }
    const event = matches[0];
    return impactOf(ctx, provider, event, windowDays, maxSamples, opts.metric, opts.series === true);
  }
  const filter = opts.source === void 0 ? void 0 : checkSource(opts.source);
  const listed = PROVIDERS.map((provider) => ({ provider, events: provider.list(ctx) }));
  const sources = listed.filter((l) => l.events.length > 0).map((l) => l.provider.source);
  const recent = listed.filter((l) => filter === void 0 || l.provider.source === filter).flatMap((l) => l.events.map((event) => ({ provider: l.provider, event }))).sort((a, b) => Date.parse(b.event.at) - Date.parse(a.event.at)).slice(0, limit);
  return { sources, changes: recent.map((r) => impactOf(ctx, r.provider, r.event, windowDays, maxSamples, opts.metric, opts.series === true)) };
}

// server/change-impact-worker.ts
function statsReader(db) {
  return {
    get(sql, params = []) {
      return db.prepare(sql).get(...params);
    },
    all(sql, params = []) {
      return db.prepare(sql).all(...params);
    }
  };
}
function run({ dbPath, opts }) {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return { result: computeChangeImpact(statsReader(db), void 0, opts) };
    } finally {
      db.close();
    }
  } catch (err) {
    if (!(err instanceof Error)) return { error: String(err) };
    return err.stack === void 0 ? { error: err.message } : { error: err.message, stack: err.stack };
  }
}
parentPort?.postMessage(run(workerData));
//# sourceMappingURL=change-impact-worker.mjs.map
