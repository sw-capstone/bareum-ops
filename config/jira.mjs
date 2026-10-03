const config = {
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
  // Runtime mappings come from the organization variable JIRA_ASSIGNEE_MAP.
  assignees: {},
};

export function loadConfig(environment = process.env) {
  const raw = environment.JIRA_ASSIGNEE_MAP;
  const assignees = Object.create(null);
  if (raw === undefined || raw.trim() === '') return { ...config, assignees };
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new Error('JIRA_ASSIGNEE_MAP must be a JSON object mapping GitHub logins to Jira accountIds.');
  }
  if (entries === null || Array.isArray(entries) || typeof entries !== 'object') {
    throw new Error('JIRA_ASSIGNEE_MAP must be a JSON object.');
  }
  for (const [login, accountId] of Object.entries(entries)) {
    if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login) ||
        typeof accountId !== 'string' || !/^[a-z\d:_-]+$/i.test(accountId)) {
      throw new Error('JIRA_ASSIGNEE_MAP contains an invalid GitHub login or Jira accountId.');
    }
    const normalizedLogin = login.toLowerCase();
    if (Object.hasOwn(assignees, normalizedLogin)) {
      throw new Error('JIRA_ASSIGNEE_MAP contains duplicate GitHub logins differing only in letter case.');
    }
    assignees[normalizedLogin] = accountId;
  }
  return { ...config, assignees };
}

export default config;
