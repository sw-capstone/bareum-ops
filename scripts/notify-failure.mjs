import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { safeFailure } from './lib/failure.mjs';
import { failureMessages } from './lib/failure-messages.mjs';

const aliases = { 'bareum-web': 'web', 'bareum-server': 'server', 'bareum-ai': 'ai', 'bareum-ops': 'ops' };

function sourceName(source) {
  return source ? `${aliases[source.repository.split('/')[1]]} 이슈 #${source.number}` : '관련 이슈';
}

function advice(failure) {
  const message = Object.hasOwn(failureMessages, failure.code)
    ? failureMessages[failure.code] : failureMessages.unknown;
  return message({ ...failure, issue: sourceName(failure.source), service: failure.service ?? '외부 API' });
}

export function failureMessage(environment, event) {
  let failure;
  try {
    failure = safeFailure(JSON.parse(environment.SYNC_FAILURE ?? '{}'));
  } catch {
    failure = safeFailure(null);
  }
  const stages = {
    checkout: '공통 자동화 코드 준비', node: '실행 환경 준비',
    tests: '자동화 자체 테스트', bot: 'GitHub App 인증',
  };
  const stage = stages[environment.FAILURE_STAGE];
  if (stage) failure = safeFailure(null);
  const manualSource = safeFailure({ source: {
    repository: environment.SYNC_REPOSITORY, number: Number(environment.SYNC_ISSUE_NUMBER),
  } }).source;
  const repository = environment.GITHUB_REPOSITORY;
  const alias = aliases[repository.split('/')[1]] ?? repository;
  const item = event.issue ?? event.pull_request;
  const number = Number.isSafeInteger(item?.number) && item.number > 0 ? item.number : null;
  const scheduled = environment.GITHUB_EVENT_NAME === 'schedule' || typeof event.schedule === 'string';
  const hierarchy = scheduled || environment.SYNC_MODE === 'hierarchy';
  const target = hierarchy ? '연결된 GitHub 이슈의 부모·자식 관계'
    : number ? `${alias} · ${event.pull_request ? 'PR' : '이슈'} #${number}`
    : manualSource ? `${sourceName(manualSource)} · 수동 동기화` : `${alias} · 수동 실행`;
  const merged = event.action === 'closed' && event.pull_request?.merged === true;
  const issueActions = { opened: '이슈 생성', edited: '이슈 수정', assigned: '담당자 지정',
    unassigned: '담당자 해제', labeled: '라벨 추가', unlabeled: '라벨 제거',
    closed: '이슈 종료', reopened: '이슈 재오픈' };
  const prActions = { opened: 'PR 생성', edited: 'PR 수정', reopened: 'PR 재오픈',
    synchronize: 'PR 커밋 갱신', closed: 'PR 종료', ready_for_review: 'PR 리뷰 준비',
    converted_to_draft: 'PR Draft 전환' };
  const action = event.pull_request ? prActions[event.action] : issueActions[event.action];
  const situation = stage ? `${stage} 중` : merged ? 'PR 병합 후 Jira 연결 정보 반영 중'
    : hierarchy ? `${scheduled ? '정기' : '수동'} 부모·자식 관계 동기화 중`
      : action ? `${action} 후 Jira 동기화 중` : '수동 검증 또는 동기화 중';
  const { cause, remedy } = stage
    ? { cause: `${stage} 단계에서 실패했습니다. Jira 동기화 단계는 실행되지 않았습니다.`,
      remedy: '실행 로그에서 해당 단계의 오류를 확인하고 해결한 뒤 재실행해주세요.' }
    : advice(failure);
  const impact = merged
    ? `PR 병합은 정상 완료됐습니다. ${stage ? '동기화 준비 단계에서 실패해 Jira 반영을 진행하지 못했습니다.' : 'Jira 반영 과정에서 실패했으며 일부 정보는 반영됐을 수 있습니다.'}`
    : stage ? 'Jira 동기화 단계는 실행되지 않았습니다.'
      : 'GitHub 작업 결과와 별도로 Jira 정보가 일부 반영되지 않았을 수 있습니다.';
  return [
    '**GitHub → Jira 동기화 실패**', '', `**대상:** ${target}`,
    `**발생 상황:** ${situation}`, `**원인:** ${cause}`, '',
    `**영향:** ${impact}`, `**조치:** ${remedy}`, '',
    `[실행 로그 보기](https://github.com/${repository}/actions/runs/${environment.GITHUB_RUN_ID})`,
  ].join('\n');
}

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
  const content = failureMessage(environment, event);
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
