// L1 lint: .github/workflows/release-payload.yml keeps the safety shape the release design requires (GH 1699). It parses the YAML with `ruby -ryaml` and checks: triggers are only tag pushes matching v[0-9]+.[0-9]+.[0-9]+ and v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+, and the first step refuses any other ref_name; top-level `permissions: {}`, `contents: write` only at job level; every `uses:` pinned by a full 40-hex commit SHA; concurrency group release-payload-${{ github.ref }}, cancel-in-progress false; every run block starts with `set -euo pipefail`; `runtime-payload.ts --check` runs before the first `git push`; payload/<tag> is pushed without force, after an ls-remote --exit-code check; every force push targets refs/heads/stable-build, and one exists; the step summary is written. Every run also lints fixtures/release-payload-workflow/bad.yml and fails unless that fixture parses and its misses are reported (ruby exit 3; 2 = unparsable).
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'release-payload.yml');
const BAD_FIXTURE = join(ROOT, 'tests', 'l1-lint', 'fixtures', 'release-payload-workflow', 'bad.yml');

const CHECK = String.raw`# encoding: utf-8
    path = ARGV[0]
    misses = []
    miss = ->(m) { misses << m }

    begin
      wf = YAML.safe_load(File.read(path, encoding: "UTF-8"), aliases: false)
    rescue StandardError => e
      warn "  ✗ #{path} does not parse as YAML: #{e.message}"
      exit 2
    end
    unless wf.is_a?(Hash)
      warn "  ✗ #{path} is not a YAML mapping"
      exit 2
    end

    on = wf.key?("on") ? wf["on"] : wf[true]
    tags = on.is_a?(Hash) && on.keys == ["push"] && on["push"].is_a?(Hash) && on["push"].keys == ["tags"] ? on["push"]["tags"] : nil
    want_tags = ["v[0-9]+.[0-9]+.[0-9]+", "v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+"]
    miss.("triggers must be only push.tags #{want_tags.inspect}") unless tags.is_a?(Array) && tags.sort == want_tags.sort

    miss.("top-level permissions must be {}") unless wf["permissions"] == {}

    conc = wf["concurrency"]
    unless conc.is_a?(Hash) && conc["group"] == "release-payload-${'$'}{{ github.ref }}" && conc["cancel-in-progress"] == false
      miss.("concurrency must be group release-payload-${'$'}{{ github.ref }} with cancel-in-progress: false")
    end

    jobs = wf["jobs"].is_a?(Hash) ? wf["jobs"] : {}
    miss.("no jobs") if jobs.empty?
    runs = []
    jobs.each do |name, job|
      perms = job["permissions"]
      miss.("job #{name}: permissions must be exactly contents: write") unless perms == { "contents" => "write" }
      if job.key?("uses") && job["uses"].to_s !~ /@[0-9a-f]{40}\z/
        miss.("job #{name}: uses #{job["uses"]} is not pinned by a 40-hex SHA")
      end
      steps = job["steps"].is_a?(Array) ? job["steps"] : []
      first = steps.first
      unless first.is_a?(Hash) && first["run"].to_s.include?(%q(^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$)) &&
             first["run"].to_s =~ /^\s*exit 1\s*$/ && first.dig("env", "TAG") == "${'$'}{{ github.ref_name }}"
        miss.("job #{name}: the first step must refuse a ref_name outside ^v[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?$ with exit 1")
      end
      steps.each_with_index do |step, i|
        next unless step.is_a?(Hash)
        if step.key?("uses") && step["uses"].to_s !~ /@[0-9a-f]{40}\z/
          miss.("job #{name} step #{i + 1}: uses #{step["uses"]} is not pinned by a 40-hex SHA")
        end
        next unless step.key?("run")
        script = step["run"].to_s
        miss.("job #{name} step #{i + 1}: run block must start with set -euo pipefail") unless script.lstrip.start_with?("set -euo pipefail")
        runs.concat(script.lines.map(&:strip))
      end
    end

    check_at = runs.index { |l| l.include?("runtime-payload.ts --check") }
    push_at = runs.index { |l| l =~ /\bgit push\b/ }
    miss.("runtime-payload.ts --check never runs") if check_at.nil?
    miss.("no git push") if push_at.nil?
    miss.("runtime-payload.ts --check must run before the first git push") if check_at && push_at && check_at > push_at
    miss.("payload/<tag> is never built by runtime-payload.ts") unless runs.any? { |l| l =~ /runtime-payload\.ts\s*$/ }

    pushes = runs.select { |l| l =~ /\bgit push\b/ }
    forced = pushes.select { |l| l =~ /(\s--force\b|\s--force-with-lease\b|\s-f\b|\s\+\S)/ || l =~ /\s--mirror\b/ }
    forced.each do |l|
      miss.("force push to something other than stable-build: #{l}") unless l == "git push --force origin HEAD:refs/heads/stable-build"
    end
    miss.("no git push --force origin HEAD:refs/heads/stable-build") if forced.empty?
    unless pushes.include?(%q(git push origin "refs/tags/payload/$TAG"))
      miss.("payload/<tag> must be pushed without force: git push origin \"refs/tags/payload/$TAG\"")
    end
    unless runs.any? { |l| l.include?(%q(git ls-remote --exit-code --tags origin "refs/tags/payload/$TAG")) }
      miss.("no git ls-remote --exit-code check for an existing payload/<tag>")
    end
    miss.("never writes GITHUB_STEP_SUMMARY") unless runs.any? { |l| l.include?("GITHUB_STEP_SUMMARY") }

    misses.each { |m| warn "  ✗ #{m}" }
    exit(misses.empty? ? 0 : 3)
  `;

function check(path) {
  const r = spawnSync('ruby', ['-EUTF-8:UTF-8', '-ryaml', '-e', CHECK, path], { cwd: ROOT, encoding: 'utf8' });
  if (r.error) throw new Error(`  ✗ ruby is required to parse the workflow YAML\nRelease-payload-workflow: FAIL`);
  return { status: r.status, stderr: r.stderr };
}

test('release-payload.yml keeps the release-payload safety shape', () => {
  assert.ok(existsSync(WORKFLOW), `  ✗ ${WORKFLOW} missing\nRelease-payload-workflow: FAIL`);
  const { status, stderr } = check(WORKFLOW);
  assert.equal(status, 0, `${stderr}Release-payload-workflow: FAIL`);
});

test("self-test: the bad fixture's misses are caught", () => {
  const { status } = check(BAD_FIXTURE);
  assert.equal(status, 3, `  ✗ self-test: tests/l1-lint/fixtures/release-payload-workflow/bad.yml gave exit ${status}, expected 3 (misses found)\nRelease-payload-workflow: FAIL`);
});
