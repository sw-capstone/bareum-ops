import { readFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/jira.mjs';
import { HttpClient, jiraClient } from './lib/http.mjs';
import { GitHub } from './lib/github.mjs';
import { Jira } from './lib/jira.mjs';
import { Sync } from './lib/sync.mjs';
import { SyncError, recordFailure } from './lib/failure.mjs';
import { assigneeWarning } from './lib/assignees.mjs';

export function eventTarget(eventName, event, environment) {
  const repository = event.repository?.full_name ?? environment.GITHUB_REPOSITORY;
  switch (eventName) {
    case 'issues':
      return { kind: 'issue', source: { repository, number: event.issue?.number }, reason: event.action };
    case 'pull_request':
    case 'pull_request_target':
      return { kind: 'pr', source: { repository, number: event.pull_request?.number },
        previousBody: event.changes?.body?.from };
    case 'workflow_dispatch':
      if (environment.SYNC_MODE === 'verify') return { kind: 'verify' };
      if (environment.SYNC_MODE !== 'issue') throw new Error('Choose verify or issue mode.');
      return { kind: 'issue', source: {
        repository: environment.SYNC_REPOSITORY, number: Number(environment.SYNC_ISSUE_NUMBER),
      }, reason: 'reconcile' };
    default:
      throw new Error(`Unsupported event: ${eventName}.`);
  }
}

function required(environment, name) {
  if (!environment[name]) throw new SyncError('configuration', `Missing ${name}.`);
  return environment[name];
}

export async function run(environment = process.env) {
  const config = loadConfig(environment);
  const event = JSON.parse(await readFile(required(environment, 'GITHUB_EVENT_PATH'), 'utf8'));
  const target = eventTarget(required(environment, 'GITHUB_EVENT_NAME'), event, environment);
  if (target.kind !== 'verify' && !Object.hasOwn(config.repositories, target.source.repository)) {
    throw new Error('The event repository is not in the configured allowlist.');
  }
  const github = new GitHub(new HttpClient({
    base: 'https://api.github.com', service: 'GitHub',
    token: required(environment, 'GH_TOKEN'),
  }), config);
  const jira = new Jira(await jiraClient({
    site: config.site,
    clientId: required(environment, 'JIRA_CLIENT_ID'),
    clientSecret: required(environment, 'JIRA_CLIENT_SECRET'),
  }), config);
  await jira.verify();
  if (target.kind === 'verify') {
    for (const repository of Object.keys(config.repositories)) {
      await github.client.request(`/repos/${repository}`);
    }
    await report('Jira OAuth, BRM permissions/statuses, and access to all four repositories verified.', environment);
    return;
  }
  const sync = new Sync({ github, jira, config });
  let results;
  switch (target.kind) {
    case 'issue':
      results = [await sync.issue(target.source, target.reason, await github.openPullRequests())];
      break;
    case 'pr':
      results = await sync.pullRequest(target.source, target.previousBody);
      break;
    default:
      throw new Error('Unexpected sync target.');
  }
  await report(results.length
    ? results.map(result => `${result.key}: status ${result.status}`).join('\n')
    : 'No linked GitHub issue or explicit Jira key. No ticket created or changed.', environment);
  for (const result of results) {
    for (const warning of result.warnings ?? []) {
      const message = `${result.key}: ${assigneeWarning(warning)} 티켓 정보와 상태는 동기화했습니다.`;
      if (environment.GITHUB_ACTIONS === 'true') process.stdout.write(`::warning::${message}\n`);
      await report(message, environment);
    }
  }
}

async function report(message, environment) {
  process.stdout.write(`${message}\n`);
  if (environment.GITHUB_STEP_SUMMARY) {
    await appendFile(environment.GITHUB_STEP_SUMMARY, `### Jira sync\n\n${message}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run();
  } catch (error) {
    try {
      await recordFailure(error, process.env);
    } catch {
      process.stderr.write('Could not record failure details for notification.\n');
    }
    // HTTP response bodies and raw network errors can contain credentials or issue text.
    const safeMessage = error instanceof Error && !['TypeError', 'SyntaxError'].includes(error.name)
      ? error.message : 'Sync failed while reading data or contacting an API.';
    process.stderr.write(`${safeMessage.replace(/[\r\n]/g, ' ')}\n`);
    process.exitCode = 1;
  }
}
