import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../config/jira.mjs';
import { sourceLabel, issueReferences, desiredStatus, manualJiraKeys } from '../scripts/lib/policy.mjs';
import { eventTarget } from '../scripts/jira-sync.mjs';

const statuses = config.statuses;
const cases = [
  ['new issue remains To Do', 'open', null, false, statuses.todo, 'opened', statuses.todo],
  ['manual start survives title editing', 'open', null, false, statuses.progress, 'edited', statuses.progress],
  ['ready PR enters review', 'open', null, true, statuses.todo, 'pull_request', statuses.review],
  ['draft PR remains in progress', 'open', null, false, statuses.progress, 'pull_request', statuses.progress],
  ['merged PR cannot finish an open issue', 'open', null, false, statuses.review, 'pull_request', statuses.progress],
  ['another ready PR keeps review', 'open', null, true, statuses.review, 'pull_request', statuses.review],
  ['completed close wins over ready PR', 'closed', 'completed', true, statuses.review, 'closed', statuses.done],
  ['cancelled close wins over ready PR', 'closed', 'not_planned', true, statuses.review, 'closed', statuses.cancelled],
  ['legacy close without reason is completed', 'closed', null, false, statuses.progress, 'closed', statuses.done],
  ['reopen without PR returns to todo', 'open', null, false, statuses.done, 'reopened', statuses.todo],
  ['reopen with PR returns to review', 'open', null, true, statuses.cancelled, 'reopened', statuses.review],
  ['coalesced edit still notices reopened issue', 'open', null, false, statuses.done, 'edited', statuses.todo],
];
for (const [name, state, state_reason, readyPr, current, reason, expected] of cases) {
  test(name, () => {
    const input = { issue: { state, state_reason }, readyPr, current, reason };
    const result = desiredStatus(input, statuses);
    assert.equal(result, expected);
  });
}

test('repository identity separates identical local issue numbers', () => {
  const web = { repository: 'sw-capstone/bareum-web', number: 10 };
  const ai = { repository: 'sw-capstone/bareum-ai', number: 10 };
  assert.notEqual(sourceLabel(web), sourceLabel(ai));
});

test('closing links support local, cross-repo, URL and GitHub UI relations', () => {
  const pr = { repository: 'sw-capstone/bareum-web', body:
    'Closes #10\nFixes sw-capstone/bareum-ai#12\nRefs https://github.com/sw-capstone/bareum-server/issues/5',
  closingIssues: [{ repository: 'sw-capstone/bareum-ops', number: 2 }] };
  const refs = issueReferences(pr, config);
  assert.deepEqual(refs, [
    { repository: 'sw-capstone/bareum-web', number: 10 },
    { repository: 'sw-capstone/bareum-ai', number: 12 },
    { repository: 'sw-capstone/bareum-server', number: 5 },
    { repository: 'sw-capstone/bareum-ops', number: 2 },
  ]);
});

test('examples, unrelated numbers and foreign repositories do not link tickets', () => {
  const pr = { repository: 'sw-capstone/bareum-web', body:
    'Example:\n```\nCloses #10\n```\n`Fixes #12`\nDiscuss #13\nCloses stranger/repo#1' };
  assert.deepEqual(issueReferences(pr, config), []);
});

test('explicit Jira marker links only a key in the configured project', () => {
  const keys = manualJiraKeys({ body: 'Jira: BRM-12\nJira: OTHER-2\nMention BRM-99' }, 'BRM');
  assert.deepEqual(keys, ['BRM-12']);
});

test('manual verification mode does not invent an issue source', () => {
  assert.deepEqual(eventTarget('workflow_dispatch', {}, { SYNC_MODE: 'verify' }), { kind: 'verify' });
});
