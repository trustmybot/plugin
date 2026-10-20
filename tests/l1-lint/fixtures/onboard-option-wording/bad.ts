// Fixture for tests/l1-lint/onboard-option-wording.sh --self-test: one
// failure per marked line.

const BRANCHING_DESCRIPTIONS = {
  'github-flow': 'Each task is recorded in the trajectory before a PR.', // VIOLATION
  gitflow: 'Two long-lived branches; daily work lands on dev.',
};

function options(authed: boolean) {
  return [
    { label: 'Off — local DB only', description: 'Nothing is posted.', wire: 'off' }, // VIOLATION
    { label: 'Auto', description: 'Issues mirror to GitHub.', wire: 'auto' }, // VIOLATION
    {
      label: 'No',
      description: authed
        ? 'Signed in.'
        : "TMB's containment hooks still guard.", // VIOLATION
      wire: 'no',
    },
    { label: `Keep "${authed}"`, description: 'Writes PreToolUse entries.', wire: 'keep' }, // VIOLATION
  ];
}

export function onboardTools() {
  return { description: 'The model-facing tool text may name the trajectory DB and hooks.' };
}
