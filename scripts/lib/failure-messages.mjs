export const failureMessages = Object.freeze({
  mapping_missing: ({ issue }) => ({
    cause: `${issue}의 Jira 연결을 찾지 못했습니다. 티켓이 아직 생성되지 않았을 수 있습니다.`,
    remedy: `${issue}의 동기화가 완료됐는지 확인해주세요. 아직 연결되지 않았다면 bareum-ops에서 해당 이슈를 수동 동기화한 뒤 실패한 워크플로를 재실행해주세요.`,
  }),
  mapping_pending: ({ issue }) => ({
    cause: `${issue}의 Jira 티켓 생성 결과를 아직 확인하지 못했습니다.`,
    remedy: 'Jira에 티켓이 이미 생성됐을 수 있습니다. 새 티켓을 직접 만들지 말고, 잠시 후 해당 이슈 동기화를 재실행해주세요. 반복되면 로그와 Jira 티켓을 확인해주세요.',
  }),
  assignee_missing: ({ issue, login }) => ({
    cause: `${issue}의 GitHub 담당자${login ? ` (${login})` : ''}에 대한 Jira 계정 매핑이 없습니다.`,
    remedy: '조직 Variable JIRA_ASSIGNEE_MAP에 해당 담당자의 Jira accountId를 등록한 뒤 재실행해주세요.',
  }),
  assignee_multiple: ({ issue }) => ({
    cause: `${issue}에 담당자가 여러 명 지정되어 있습니다. Jira는 담당자 한 명만 지원합니다.`,
    remedy: 'GitHub 이슈 담당자를 한 명으로 정한 뒤 다시 동기화해주세요.',
  }),
  authentication: ({ service }) => ({
    cause: `${service} 인증이 거부됐습니다.`,
    remedy: '인증 Secret의 등록·만료 여부와 해당 레포의 Secret 접근 범위를 확인한 뒤 재실행해주세요.',
  }),
  permission: ({ service }) => ({
    cause: `${service} 접근 권한이 부족합니다.`,
    remedy: 'GitHub App의 레포 접근 권한 또는 Jira 봇의 프로젝트 권한을 확인한 뒤 재실행해주세요.',
  }),
  configuration: () => ({
    cause: '동기화 설정이 누락되었거나 올바르지 않습니다.',
    remedy: '실행 로그에서 문제가 된 설정을 확인하고, 조직 Variables·Secrets 또는 Jira 작업 유형·상태 설정을 수정한 뒤 재실행해주세요.',
  }),
  temporary_api: ({ service, status, method }) => ({
    cause: `${service}가 일시적인 오류 또는 요청 제한을 반환했습니다${status ? ` (HTTP ${status})` : ''}.`,
    remedy: method === 'GET' ? '잠시 후 재실행해주세요. 반복되면 실행 로그를 확인해주세요.'
      : '변경이 일부 반영됐을 수 있으니 GitHub·Jira 상태를 먼저 확인한 뒤 재실행해주세요. 티켓 생성 결과가 불확실하면 새 티켓을 직접 만들지 마세요.',
  }),
  api: ({ service, status }) => ({
    cause: `${service} 요청이 거부됐습니다${status ? ` (HTTP ${status})` : ''}.`,
    remedy: '실행 로그에서 요청 실패 원인을 확인해주세요. 변경이 일부 반영됐을 수 있으니 현재 상태도 함께 확인해주세요.',
  }),
  unknown: () => ({
    cause: '실패 원인을 자동으로 분류하지 못했습니다.',
    remedy: '실행 로그를 확인해주세요. 변경이 일부 반영됐을 수 있으니 GitHub·Jira 상태도 함께 확인해주세요.',
  }),
});
