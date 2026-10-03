export default {
  organization: 'sw-capstone',
  automationRepository: 'sw-capstone/bareum-ops',
  botLogin: 'team-ops-bot[bot]',
  site: 'https://bareum.atlassian.net',
  project: 'BRM',
  repositories: {
    'sw-capstone/bareum-web': 'web',
    'sw-capstone/bareum-server': 'server',
    'sw-capstone/bareum-ai': 'ai',
    'sw-capstone/bareum-ops': 'ops',
  },
  statuses: {
    todo: '10033',
    progress: '10034',
    review: '10035',
    done: '10036',
    cancelled: '10037',
  },
  issueTypes: { task: 'Task', bug: 'Bug' },
  // GitHub login -> Jira accountId. An unmapped assignee stops the update.
  assignees: {},
};
