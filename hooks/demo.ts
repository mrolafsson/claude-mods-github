// The demo org: Halcyon, a made-up notes-app company (the Linear mod's demo
// workspace is the same company), answering the pane's queries from memory
// as GitHub's API would. Everything works (drafts flip, PRs merge,
// auto-merge turns on) and nothing is real: it never runs gh or git, and
// starts no session. It's also how the README's screenshots are made.

type DemoPR = {
  number: number
  repo: string
  title: string
  author: string
  head: string
  base: string
  isDraft: boolean
  review: string | null
  mergeable: string
  checks: string | null
  additions: number
  deletions: number
  labels: [string, string][]
  hoursAgo: number
  requested: string[]
  reviewers: [string, string][]
  checkList: [string, string, boolean][]
  body: string
  threads: { path: string; line: number; comments: [string, string][] }[]
  conversation: [string, string, number][]
  mergeState: string
  changedFiles: number
}

const NOW = Date.parse('2026-10-31T12:00:00Z')
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

const PRS: DemoPR[] = [
  {
    number: 482, repo: 'halcyon/notes-app', title: 'Offline edits survive a sync conflict', author: 'sam',
    head: 'sam/hal-212-offline-conflicts', base: 'main', isDraft: false, review: 'APPROVED', mergeable: 'MERGEABLE',
    checks: 'SUCCESS', additions: 318, deletions: 74, labels: [['sync', '1a7f37'], ['bug', 'd73a4a']], hoursAgo: 0.5,
    requested: ['jonas'], reviewers: [['priya', 'APPROVED']],
    checkList: [['build', 'pass', true], ['test (ubuntu)', 'pass', true], ['test (macos)', 'pass', false], ['lint', 'pass', true]],
    body: "When two devices edit the same note offline, the second sync used to drop the first device's edits.\n\nThis keeps both: the server now returns a merge proposal and the client applies it as a three-way merge.\n\n## Changes\n\n- `SyncEngine` asks for a proposal instead of overwriting\n- New `ThreeWay.merge(base:ours:theirs:)`\n- Conflicting blocks are kept side by side, marked for the user\n\nFixes HAL-212.",
    threads: [], conversation: [['priya', 'Lovely. The conflict markers read well on iPad too.', 20], ['sam', 'Thanks! Merging once Jonas has had a look.', 2]],
    mergeState: 'CLEAN', changedFiles: 9,
  },
  {
    number: 479, repo: 'halcyon/notes-app', title: 'Search index drops accents', author: 'sam',
    head: 'sam/hal-231-search-accents', base: 'main', isDraft: false, review: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE',
    checks: 'FAILURE', additions: 41, deletions: 12, labels: [['search', '0969da']], hoursAgo: 26,
    requested: ['priya'], reviewers: [],
    checkList: [['build', 'pass', true], ['test (ubuntu)', 'fail', true], ['lint', 'pass', true]],
    body: 'Fold titles to ASCII at index time, as bodies already are, so `cafe` finds *Café notes*.\n\nFixes HAL-231.',
    threads: [{ path: 'src/search/index.ts', line: 88, comments: [['priya', 'Does this fold `ß` too? German titles will want it.']] }],
    conversation: [], mergeState: 'BLOCKED', changedFiles: 3,
  },
  {
    number: 118, repo: 'halcyon/sync-server', title: 'Return merge proposals for concurrent edits', author: 'sam',
    head: 'sam/merge-proposals', base: 'main', isDraft: false, review: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE',
    checks: 'SUCCESS', additions: 202, deletions: 19, labels: [['sync', '1a7f37']], hoursAgo: 5,
    requested: [], reviewers: [['jonas', 'CHANGES_REQUESTED']],
    checkList: [['build', 'pass', true], ['test', 'pass', true]],
    body: "The server's half of #482: when two writes race, answer with both versions and their common ancestor.",
    threads: [{ path: 'internal/sync/merge.go', line: 42, comments: [['jonas', 'This holds the lock across the database call: can we copy first?']] }],
    conversation: [['jonas', 'Close: one locking question inline.', 6]], mergeState: 'BLOCKED', changedFiles: 4,
  },
  {
    number: 476, repo: 'halcyon/notes-app', title: 'Spike: CRDT-backed notes', author: 'sam',
    head: 'sam/crdt-spike', base: 'main', isDraft: true, review: null, mergeable: 'MERGEABLE',
    checks: 'PENDING', additions: 1204, deletions: 88, labels: [], hoursAgo: 48,
    requested: [], reviewers: [],
    checkList: [['build', 'pass', true], ['test (ubuntu)', 'pending', true]],
    body: 'An experiment: notes as CRDTs, so sync never conflicts at all. Not for merging.',
    threads: [], conversation: [], mergeState: 'DRAFT', changedFiles: 21,
  },
  {
    number: 485, repo: 'halcyon/notes-app', title: 'Rate-limit the public share endpoint', author: 'priya',
    head: 'priya/hal-247-share-rate-limit', base: 'main', isDraft: false, review: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE',
    checks: 'SUCCESS', additions: 96, deletions: 8, labels: [['security', 'e99695']], hoursAgo: 3,
    requested: ['sam'], reviewers: [],
    checkList: [['build', 'pass', true], ['test (ubuntu)', 'pass', true], ['lint', 'pass', true]],
    body: 'A per-IP limit on `/s/:id`, with a friendly page past it.\n\nFixes HAL-247.',
    threads: [], conversation: [], mergeState: 'BLOCKED', changedFiles: 5,
  },
  {
    number: 471, repo: 'halcyon/notes-app', title: 'Markdown export keeps inline images', author: 'jonas',
    head: 'jonas/hal-240-export-images', base: 'main', isDraft: false, review: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE',
    checks: 'PENDING', additions: 133, deletions: 27, labels: [['export', '8250df']], hoursAgo: 8,
    requested: ['sam'], reviewers: [],
    checkList: [['build', 'pass', true], ['test (ubuntu)', 'pending', true]],
    body: 'Copies images next to the exported Markdown and links them relatively.\n\nFixes HAL-240.',
    threads: [], conversation: [], mergeState: 'BLOCKED', changedFiles: 6,
  },
  {
    number: 77, repo: 'halcyon/web', title: 'Pricing page copy for the new plans', author: 'priya',
    head: 'priya/pricing-copy', base: 'main', isDraft: false, review: 'REVIEW_REQUIRED', mergeable: 'CONFLICTING',
    checks: 'SUCCESS', additions: 58, deletions: 31, labels: [], hoursAgo: 30,
    requested: ['sam'], reviewers: [],
    checkList: [['build', 'pass', true]],
    body: 'Copy for Plus and Teams.', threads: [], conversation: [], mergeState: 'DIRTY', changedFiles: 2,
  },
  {
    number: 468, repo: 'halcyon/notes-app', title: 'Bump the editor to 4.2', author: 'dependabot',
    head: 'dependabot/npm/editor-4.2', base: 'main', isDraft: false, review: null, mergeable: 'MERGEABLE',
    checks: 'SUCCESS', additions: 12, deletions: 12, labels: [['dependencies', '0366d6']], hoursAgo: 12,
    requested: [], reviewers: [],
    checkList: [['build', 'pass', true], ['test (ubuntu)', 'pass', true]],
    body: 'Bumps editor from 4.1.3 to 4.2.0.', threads: [], conversation: [], mergeState: 'CLEAN', changedFiles: 2,
  },
  {
    number: 463, repo: 'halcyon/notes-app', title: 'Sync status in the toolbar', author: 'priya',
    head: 'priya/hal-218-sync-status', base: 'main', isDraft: false, review: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE',
    checks: 'PENDING', additions: 77, deletions: 4, labels: [['sync', '1a7f37']], hoursAgo: 4,
    requested: ['jonas'], reviewers: [],
    checkList: [['build', 'pass', true], ['test (ubuntu)', 'pending', true]],
    body: 'Says when the last sync was, and whether one is running.\n\nFixes HAL-218.',
    threads: [], conversation: [], mergeState: 'BLOCKED', changedFiles: 3,
  },
]

const REPOS = ['halcyon/notes-app', 'halcyon/sync-server', 'halcyon/web', 'halcyon/design', 'sam/dotfiles']

// Changes made in the demo, for this session.
const changed: Record<number, { isDraft?: boolean; state?: string; autoMerge?: string | null }> = {}

const idOf = (p: DemoPR) => `PR_${p.repo}#${p.number}`

function node(p: DemoPR) {
  const c = changed[p.number] ?? {}
  return {
    id: idOf(p),
    number: p.number,
    title: p.title,
    url: `https://github.com/${p.repo}/pull/${p.number}`,
    isDraft: c.isDraft ?? p.isDraft,
    state: c.state ?? 'OPEN',
    updatedAt: ago(p.hoursAgo),
    author: { login: p.author },
    repository: { nameWithOwner: p.repo },
    headRefName: p.head,
    baseRefName: p.base,
    isCrossRepository: false,
    headRepositoryOwner: { login: p.repo.split('/')[0] },
    reviewDecision: p.review,
    mergeable: p.mergeable,
    additions: p.additions,
    deletions: p.deletions,
    commits: { nodes: [{ commit: { statusCheckRollup: p.checks ? { state: p.checks } : null } }] },
    labels: { nodes: p.labels.map(([name, color]) => ({ name, color })) },
    autoMergeRequest: (c.autoMerge !== undefined ? c.autoMerge : null) ? { mergeMethod: c.autoMerge } : null,
  }
}

function detail(p: DemoPR) {
  const c = changed[p.number] ?? {}
  return {
    ...node(p),
    body: p.body,
    mergeStateStatus: c.isDraft ?? p.isDraft ? 'DRAFT' : p.mergeState,
    changedFiles: p.changedFiles,
    headRefOid: `0${p.number}abc`,
    headRef: { id: `REF_${p.number}` },
    viewerCanMergeAsAdmin: false,
    repository: {
      nameWithOwner: p.repo,
      squashMergeAllowed: true,
      mergeCommitAllowed: true,
      rebaseMergeAllowed: false,
      autoMergeAllowed: true,
      deleteBranchOnMerge: false,
      viewerDefaultMergeMethod: 'SQUASH',
      viewerPermission: 'WRITE',
    },
    last: {
      nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: p.checkList.map(([name, outcome, isRequired]) => ({
        __typename: 'CheckRun',
        name,
        status: outcome === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
        conclusion: outcome === 'pass' ? 'SUCCESS' : outcome === 'fail' ? 'FAILURE' : null,
        detailsUrl: `https://github.com/${p.repo}/actions`,
        isRequired,
      })) } } } }],
    },
    latestReviews: { nodes: p.reviewers.map(([login, state]) => ({ author: { login }, state })) },
    reviewRequests: { nodes: p.requested.map(login => ({ requestedReviewer: { login } })) },
    reviews: { nodes: [] },
    comments: { nodes: p.conversation.map(([login, body, h]) => ({ author: { login }, body, createdAt: ago(h) })) },
    reviewThreads: {
      nodes: p.threads.map(t => ({
        isResolved: false, isOutdated: false, path: t.path, line: t.line,
        comments: { nodes: t.comments.map(([login, body]) => ({ author: { login }, body, createdAt: ago(6) })) },
      })),
    },
  }
}

const isOpen = (p: DemoPR) => (changed[p.number]?.state ?? 'OPEN') === 'OPEN'

// Answers a query the pane sends GitHub, as GitHub would.
export function demoGql(query: string, vars: Record<string, string | number | null>): any {
  const byId = (id: unknown) => PRS.find(p => idOf(p) === id)
  if (query.includes('search(')) {
    const q = String(vars.q ?? '')
    const repo = /repo:(\S+)/.exec(q)?.[1]
    const list = PRS.filter(isOpen).filter(p =>
      q.includes('author:@me') ? p.author === 'sam' : q.includes('review-requested:@me') ? p.requested.includes('sam') : repo ? p.repo === repo : true,
    )
    return { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: list.sort((a, b) => a.hoursAgo - b.hoursAgo).map(node) } }
  }
  if (query.includes('node(id')) {
    const p = byId(vars.id)
    return { node: p ? detail(p) : null }
  }
  if (query.includes('pullRequest(number')) {
    const p = PRS.find(x => x.repo === `${vars.owner}/${vars.name}` && x.number === Number(vars.n))
    return { repository: { pullRequest: p ? node(p) : null } }
  }
  if (query.includes('repositories(')) {
    return { viewer: { repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: REPOS.map(nameWithOwner => ({ nameWithOwner })) } } }
  }
  const p = byId(vars.id)
  if (p) {
    const c = (changed[p.number] ??= {})
    if (query.includes('markPullRequestReadyForReview')) c.isDraft = false
    else if (query.includes('convertPullRequestToDraft')) c.isDraft = true
    else if (query.includes('mergePullRequest')) c.state = 'MERGED'
    else if (query.includes('enablePullRequestAutoMerge')) c.autoMerge = String(vars.method)
    else if (query.includes('disablePullRequestAutoMerge')) c.autoMerge = null
    return { ok: true }
  }
  if (query.includes('deleteRef')) return { deleteRef: { clientMutationId: null } }
  return {}
}

// The demo's own time, so ages read as they do in the screenshots.
export const DEMO_NOW = NOW
