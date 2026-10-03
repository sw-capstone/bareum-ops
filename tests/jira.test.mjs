import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../config/jira.mjs';
import { Jira } from '../scripts/lib/jira.mjs';

function setup(types) {
  const requests = [];
  const jira = new Jira({ async request(path, options = {}) {
    requests.push({ path, method: options.method ?? 'GET' });
    if (path === '/project/BRM') return { key: 'BRM', issueTypes: [] };
    if (path === '/project/BRM/statuses') return types;
    if (path.startsWith('/mypermissions?')) {
      const names = new URLSearchParams(path.split('?')[1]).get('permissions').split(',');
      return { permissions: Object.fromEntries(names.map(name => [name, { havePermission: true }])) };
    }
    throw new Error(`Unexpected request: ${path}`);
  } }, config);
  return { jira, requests };
}

function workflows() {
  return [
    { id: '10037', name: '작업', subtask: false },
    { id: '10036', name: '버그', subtask: false },
    { id: '10034', name: 'Task', subtask: true },
  ].map(type => ({ ...type, statuses: Object.values(config.statuses).map(id => ({ id })) }));
}

test('BRM workflow IDs select Task and Bug despite localized names and empty project issueTypes', async () => {
  const { jira } = setup(workflows());
  assert.equal(await jira.verify(), 'BRM');
  const source = { repository: 'sw-capstone/bareum-web', number: 16 };
  const issue = { title: '[Chore] Jira sync', body: '',
    html_url: 'https://github.com/sw-capstone/bareum-web/issues/16', assignees: [], labels: [] };
  assert.deepEqual(jira.fields(issue, source).issuetype, { id: '10037' });
  issue.labels = [{ name: 'bug' }];
  assert.deepEqual(jira.fields(issue, source).issuetype, { id: '10036' });
});

test('missing or subtask-only configured types fail verification before any write', async () => {
  for (const id of ['10037', '10036']) {
    for (const subtaskOnly of [false, true]) {
      const types = workflows().flatMap(type => type.id !== id ? [type]
        : subtaskOnly ? [{ ...type, subtask: true }] : []);
      const { jira, requests } = setup(types);
      await assert.rejects(jira.verify(), new RegExp(`issue type ${id} is not available`));
      assert.ok(requests.every(request => request.method === 'GET'));
    }
  }
});
