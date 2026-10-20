// Fixture for tests/l1-lint/onboard-option-wording.sh --self-test: no
// failures and exactly one length warning. A comment may say trajectory DB.

const BRANCHING_DESCRIPTIONS = {
  'github-flow': 'One main branch; every change is a short branch plus a pull request.',
  gitflow: 'Two long-lived branches; daily work lands on dev, releases go to main.',
};

interface QuestionOption {
  label: string;
  description: string;
  wire: string;
}

function options(authed: boolean): QuestionOption[] {
  return [
    { label: 'Off — issues stay on this computer', description: 'Nothing is posted to GitHub or GitLab.', wire: 'mirror' },
    {
      label: 'Auto — sync to the remote you picked',
      description: authed ? 'New issues also appear on GitHub or GitLab.' : 'Syncing starts once you sign in.',
      wire: 'auto',
    },
    {
      label: 'Yes',
      description:
        'Bash can only write inside this project and the model cache, and can only reach GitHub.' +
        (authed ? ' Signed in.' : ''),
      wire: 'yes',
    },
    { label: 'Keep "main"', description: 'No change.', wire: 'keep' },
  ];
}

export function onboardTools() {
  return { description: 'The model-facing tool text may name the trajectory DB and hooks.' };
}
