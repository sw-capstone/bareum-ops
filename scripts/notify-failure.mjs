import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function notifyFailure(environment, event, fetcher = fetch) {
  if (!environment.DISCORD_WEBHOOK_URL) {
    process.stdout.write('::warning::DISCORD_WEBHOOK_URL is not configured; failure notification was not sent.\n');
    return false;
  }
  const webhook = new URL(environment.DISCORD_WEBHOOK_URL);
  if (webhook.origin !== 'https://discord.com' ||
      !/^\/api\/webhooks\/\d+\/[^/]+$/.test(webhook.pathname)) {
    throw new Error('Invalid Discord webhook URL.');
  }
  const repository = environment.GITHUB_REPOSITORY;
  if (!/^sw-capstone\/[\w.-]+$/.test(repository ?? '')) {
    throw new Error('Invalid notification repository.');
  }
  const runId = environment.GITHUB_RUN_ID;
  if (!/^\d+$/.test(runId ?? '')) throw new Error('Invalid Actions run ID.');
  const item = event.issue ?? event.pull_request;
  const target = item ? `${event.pull_request ? 'PR' : 'Issue'} #${item.number}` : 'Manual verification/sync';
  const content = [
    'Jira sync failed', repository,
    `${environment.GITHUB_EVENT_NAME}: ${event.action ?? 'manual'} / ${target}`,
    `https://github.com/${repository}/actions/runs/${runId}`,
  ].join('\n');
  const response = await fetcher(webhook, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Discord notification failed (HTTP ${response.status}).`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    await notifyFailure(process.env, event);
  } catch {
    process.stderr.write('Discord failure notification could not be sent. Check the webhook secret and Actions logs.\n');
    process.exitCode = 1;
  }
}
