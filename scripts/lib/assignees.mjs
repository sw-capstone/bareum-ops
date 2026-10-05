export function assigneePlan(users, mapping, currentAccountId) {
  const warnings = [];
  const candidates = [];
  for (const { login } of users) {
    const normalized = login.toLowerCase();
    const accountId = Object.hasOwn(mapping, normalized) ? mapping[normalized] : null;
    if (!accountId) {
      warnings.push({ code: 'assignee_missing', login });
    } else if (!candidates.some(candidate => candidate.accountId === accountId)) {
      candidates.push({ login, accountId });
    }
  }
  const retained = candidates.findIndex(candidate => candidate.accountId === currentAccountId);
  if (retained > 0) candidates.unshift(...candidates.splice(retained, 1));
  return { candidates, warnings };
}

export function assigneeWarning(warning) {
  const messages = {
    assignee_missing: `${warning.login}: Jira 계정 매핑이 없어 대표 담당자 후보에서 제외했습니다.`,
    assignee_rejected: `${warning.login}: Jira 담당자로 지정할 수 없어 다음 후보를 확인했습니다.`,
    assignee_clear_rejected: 'Jira 담당자를 비우지 못했습니다. 담당자 지정 권한과 기본 담당자 설정을 확인해주세요.',
  };
  return messages[warning.code];
}
