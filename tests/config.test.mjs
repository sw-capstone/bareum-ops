import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config/jira.mjs';
import { Jira } from '../scripts/lib/jira.mjs';

test('organization mapping is loaded afresh and GitHub logins are case insensitive', () => {
  const first = loadConfig({ JIRA_ASSIGNEE_MAP: '{"SeaMooll":"712020:account-1"}' });
  const second = loadConfig({ JIRA_ASSIGNEE_MAP: '{"seamooll":"712020:account-2"}' });
  const jira = new Jira({}, second);
  jira.types = [{ id: '1', name: 'Task', subtask: false }];
  const fields = jira.fields({ title: 'Task', body: '', html_url: 'https://github.com/example',
    assignees: [{ login: 'SeaMooll' }], labels: [] }, { repository: 'sw-capstone/bareum-web', number: 1 });
  assert.equal(first.assignees.seamooll, '712020:account-1');
  assert.deepEqual(fields.assignee, { accountId: '712020:account-2' });
});

test('absent mapping permits unassigned issues but never guesses an assigned account', () => {
  for (const raw of [undefined, '', '  ', '{}']) {
    const config = loadConfig({ JIRA_ASSIGNEE_MAP: raw });
    const jira = new Jira({}, config);
    jira.types = [{ id: '1', name: 'Task', subtask: false }];
    const issue = { title: 'Task', body: '', html_url: 'https://github.com/example', assignees: [], labels: [] };
    const source = { repository: 'sw-capstone/bareum-web', number: 1 };
    assert.equal(jira.fields(issue, source).assignee, null);
    issue.assignees = [{ login: 'constructor' }];
    assert.throws(() => jira.fields(issue, source), /organization variable JIRA_ASSIGNEE_MAP/);
  }
});

test('invalid mapping fails without printing its contents', () => {
  for (const raw of ['bad-secret-value', 'null', '[]', '12', '"text"',
    '{"seamooll":null}', '{"seamooll":12}', '{"seamooll":""}',
    '{"seamooll":" account "}', '{"bad_login":"id"}',
    '{"seamooll":"a","SeaMooll":"b"}', '{"__proto__":"id"}']) {
    assert.throws(() => loadConfig({ JIRA_ASSIGNEE_MAP: raw }), error =>
      error.message.includes('JIRA_ASSIGNEE_MAP') && !error.message.includes(raw));
  }
});
