// GitHub through gh: its sign-in, its host (Enterprise included), its API.
// The queries are herdr-github's. In the demo the same queries are answered
// from memory, by demo.ts.

import type { EngineInterface } from 'claude-code'

import type { Check, Comment, Detail, PR, Thread } from '../types'
import { demoGql } from './demo'

// Runs one GraphQL query or mutation with gh, or against the demo.
export async function gql($: EngineInterface, demo: boolean, query: string, vars: Record<string, string | number | null> = {}): Promise<any> {
  if (demo) return demoGql(query, vars)
  const argv = ['gh', 'api', 'graphql', '-f', `query=${query}`]
  for (const [k, v] of Object.entries(vars)) {
    if (v === null || v === undefined) continue
    // -F for numbers (sent typed), -f for strings (sent as they are).
    argv.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`)
  }
  const r = await $.process.run(argv, { timeoutMs: 60_000 })
  let out: any = null
  try {
    out = JSON.parse(r.stdout || '{}')
  } catch {
    out = null
  }
  if (out?.errors?.length) throw new Error(String(out.errors[0].message))
  if (r.exitCode !== 0 || !out) {
    const why = (r.stderr || r.stdout).trim().split('\n').pop() ?? ''
    if (/gh auth login|not logged in|authentication/i.test(why)) throw new Error('gh is not signed in here: run `gh auth login` in a terminal.')
    throw new Error(why || `gh exited ${r.exitCode}`)
  }
  return out.data
}

export const PR_FIELDS = `
fragment PR on PullRequest {
  id number title url isDraft state updatedAt
  author { login }
  repository { nameWithOwner }
  headRefName baseRefName isCrossRepository
  headRepositoryOwner { login }
  reviewDecision mergeable additions deletions
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  labels(first: 6) { nodes { name color } }
  autoMergeRequest { enabledAt mergeMethod }
  mergeQueueEntry { position state }
}`

export const SEARCH = `query($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ...PR }
  }
}${PR_FIELDS}`

// The searches behind the tabs, as herdr-github's.
export const TAB_QUERY = {
  mine: 'is:pr is:open archived:false author:@me sort:updated-desc',
  review: 'is:pr is:open archived:false review-requested:@me sort:updated-desc',
  repo: (repo: string) => `is:pr is:open repo:${repo} sort:updated-desc`,
}

export const DETAIL = `query($id: ID!, $n: Int!) {
  node(id: $id) {
    ... on PullRequest {
      ...PR
      body mergeStateStatus changedFiles headRefOid
      isMergeQueueEnabled
      mergeQueueEntry { estimatedTimeToMerge }
      headRef { id }
      viewerCanMergeAsAdmin
      repository {
        squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed autoMergeAllowed
        deleteBranchOnMerge viewerDefaultMergeMethod viewerPermission
      }
      last: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $n) }
        ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $n) }
      } } } } } }
      latestReviews(first: 30) { nodes { author { login } state } }
      reviewRequests(first: 30) { nodes { requestedReviewer {
        ... on User { login } ... on Team { name } ... on Mannequin { login }
      } } }
      reviews(last: 30) { nodes { author { login } body state createdAt: submittedAt } }
      comments(last: 50) { nodes { author { login } body createdAt } }
      reviewThreads(first: 60) { nodes {
        isResolved isOutdated path line
        comments(first: 4) { nodes { author { login } body createdAt } }
      } }
    }
  }
}${PR_FIELDS}`

// A PR by its repo and number, for opening one straight from elsewhere.
export const BY_NUMBER = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $n) { ...PR } }
}${PR_FIELDS}`

export const REPOS = `query($after: String) {
  viewer {
    repositories(first: 100, after: $after, isArchived: false,
      affiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR],
      ownerAffiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR],
      orderBy: {field: PUSHED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { nameWithOwner }
    }
  }
}`

export const READY = `mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id } } }`
export const TO_DRAFT = `mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { id } } }`
export const MERGE = `mutation($id: ID!, $method: PullRequestMergeMethod!, $oid: GitObjectID!) {
  mergePullRequest(input: {pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $oid}) { pullRequest { id state } }
}`
export const AUTO_ON = `mutation($id: ID!, $method: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $method}) { pullRequest { id } }
}`
export const AUTO_OFF = `mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { pullRequest { id } } }`
// Through a merge queue, where the base branch has one: GitHub merges it
// when its turn comes, by the queue's own method.
export const ENQUEUE = `mutation($id: ID!, $oid: GitObjectID!) {
  enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $oid}) { mergeQueueEntry { position state } }
}`
export const DEQUEUE = `mutation($id: ID!) { dequeuePullRequest(input: {id: $id}) { mergeQueueEntry { id } } }`
export const DELETE_REF = `mutation($id: ID!) { deleteRef(input: {refId: $id}) { clientMutationId } }`

// A PR's key, as the pane names it: owner/repo#n.
export const keyOf = (pr: { repo: string; number: number }) => `${pr.repo}#${pr.number}`

export function toPR(n: any): PR {
  return {
    id: String(n.id),
    number: Number(n.number),
    title: String(n.title ?? ''),
    url: String(n.url ?? ''),
    isDraft: Boolean(n.isDraft),
    state: String(n.state ?? 'OPEN'),
    updatedAt: String(n.updatedAt ?? ''),
    author: String(n.author?.login ?? 'ghost'),
    repo: String(n.repository?.nameWithOwner ?? ''),
    head: String(n.headRefName ?? ''),
    base: String(n.baseRefName ?? ''),
    isCrossRepository: Boolean(n.isCrossRepository),
    headOwner: n.headRepositoryOwner?.login ?? null,
    reviewDecision: n.reviewDecision ?? null,
    mergeable: String(n.mergeable ?? 'UNKNOWN'),
    additions: Number(n.additions ?? 0),
    deletions: Number(n.deletions ?? 0),
    checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    labels: (n.labels?.nodes ?? []).map((l: any) => ({ name: String(l.name), color: String(l.color ?? '') })),
    autoMerge: n.autoMergeRequest?.mergeMethod ?? null,
    queue: n.mergeQueueEntry ? { position: Number(n.mergeQueueEntry.position ?? 0), state: String(n.mergeQueueEntry.state ?? 'QUEUED') } : null,
  }
}

function toCheck(c: any): Check {
  if (c.__typename === 'StatusContext') {
    const s = String(c.state ?? '')
    return {
      name: String(c.context ?? ''),
      outcome: s === 'SUCCESS' ? 'pass' : s === 'FAILURE' || s === 'ERROR' ? 'fail' : 'pending',
      isRequired: Boolean(c.isRequired),
      url: c.targetUrl ?? null,
    }
  }
  const done = c.status === 'COMPLETED'
  const con = String(c.conclusion ?? '')
  return {
    name: String(c.name ?? ''),
    outcome: !done ? 'pending' : con === 'SUCCESS' || con === 'NEUTRAL' ? 'pass' : con === 'SKIPPED' ? 'skipped' : 'fail',
    isRequired: Boolean(c.isRequired),
    url: c.detailsUrl ?? null,
  }
}

const toComment = (c: any): Comment => ({
  author: String(c.author?.login ?? 'ghost'),
  body: String(c.body ?? ''),
  createdAt: String(c.createdAt ?? ''),
  ...(c.state ? { state: String(c.state) } : {}),
})

export function toDetail(n: any): Detail {
  const pr = toPR(n)
  const r = n.repository ?? {}
  const perm = String(r.viewerPermission ?? '')
  const threads: Thread[] = (n.reviewThreads?.nodes ?? [])
    .filter((t: any) => !t.isResolved)
    .map((t: any) => ({ path: String(t.path ?? ''), line: t.line ?? null, isOutdated: Boolean(t.isOutdated), comments: (t.comments?.nodes ?? []).map(toComment) }))
  // The conversation: comments and reviews with something to say, oldest first.
  const conversation = [
    ...(n.comments?.nodes ?? []).map(toComment),
    ...(n.reviews?.nodes ?? []).filter((x: any) => (x.body ?? '').trim()).map(toComment),
  ].sort((a: Comment, b: Comment) => a.createdAt.localeCompare(b.createdAt))
  const latest: { author: string; state: string }[] = (n.latestReviews?.nodes ?? []).map((x: any) => ({ author: String(x.author?.login ?? 'ghost'), state: String(x.state ?? '') }))
  return {
    ...pr,
    body: String(n.body ?? ''),
    mergeStateStatus: String(n.mergeStateStatus ?? 'UNKNOWN'),
    changedFiles: Number(n.changedFiles ?? 0),
    headOid: String(n.headRefOid ?? ''),
    headRefId: n.headRef?.id ?? null,
    queueEnabled: Boolean(n.isMergeQueueEnabled),
    queueEta: n.mergeQueueEntry?.estimatedTimeToMerge ?? null,
    checkList: (n.last?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []).map(toCheck),
    reviews: latest,
    requested: (n.reviewRequests?.nodes ?? [])
      .map((x: any) => x.requestedReviewer?.login ?? x.requestedReviewer?.name)
      .filter((x: any) => x && !latest.some(l => l.author === x)),
    conversation,
    threads,
    settings: {
      squash: Boolean(r.squashMergeAllowed),
      merge: Boolean(r.mergeCommitAllowed),
      rebase: Boolean(r.rebaseMergeAllowed),
      autoMerge: Boolean(r.autoMergeAllowed),
      deleteBranchOnMerge: Boolean(r.deleteBranchOnMerge),
      defaultMethod: r.viewerDefaultMergeMethod ?? null,
      canMerge: Boolean(n.viewerCanMergeAsAdmin) || ['ADMIN', 'MAINTAIN', 'WRITE'].includes(perm),
    },
  }
}

// ── Where a PR has got to, as herdr-github's groupOf ─────────────────────────

export type Group = 'review' | 'fixing' | 'ready' | 'waiting' | 'drafts' | 'done'

export const GROUPS: { id: Group; label: string; color: string }[] = [
  { id: 'review', label: 'To review', color: 'suggestion' },
  { id: 'fixing', label: 'Needs fixing', color: 'error' },
  { id: 'ready', label: 'Ready to merge', color: 'success' },
  { id: 'waiting', label: 'Waiting', color: 'warning' },
  { id: 'drafts', label: 'Drafts', color: 'claude' },
  { id: 'done', label: 'Done', color: 'merged' },
]

// The checks' rollup as a mark: ✓ passed, ✗ failed, ● running, '' none.
export function checkMark(rollup: string | null): string {
  if (rollup === 'SUCCESS') return '✓'
  if (rollup === 'FAILURE' || rollup === 'ERROR') return '✗'
  if (rollup === 'PENDING' || rollup === 'EXPECTED') return '●'
  return ''
}

export function groupOf(pr: PR, inReview: boolean): Group {
  const mark = checkMark(pr.checks)
  if (pr.state === 'MERGED' || pr.state === 'CLOSED') return 'done'
  if (pr.isDraft) return 'drafts'
  if (pr.queue) return 'waiting'
  if (mark === '✗' || pr.mergeable === 'CONFLICTING' || pr.reviewDecision === 'CHANGES_REQUESTED') return 'fixing'
  if (inReview) return 'review'
  if (mark === '●') return 'waiting'
  if (pr.reviewDecision === 'APPROVED' || (!pr.reviewDecision && pr.checks === 'SUCCESS')) return 'ready'
  return 'waiting'
}

// ── Whether it can merge, and if not why, as herdr-github's readiness ───────

export const METHOD_NAMES: Record<string, string> = { MERGE: 'Create a merge commit', SQUASH: 'Squash and merge', REBASE: 'Rebase and merge' }
export const METHOD_VERBS: Record<string, string> = { MERGE: 'Merge', SQUASH: 'Squash-merge', REBASE: 'Rebase-merge' }

export function mergeableNow(d: Detail): boolean {
  return ['CLEAN', 'UNSTABLE', 'HAS_HOOKS'].includes(d.mergeStateStatus) && d.mergeable !== 'CONFLICTING'
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function readiness(d: Detail): { text: string; color: string } {
  if (d.state === 'MERGED') return { text: 'Merged', color: 'merged' }
  if (d.state === 'CLOSED') return { text: 'Closed without merging', color: 'error' }
  if (d.isDraft) return { text: 'Draft: mark it ready for review (d) before it can merge', color: 'subtle' }
  if (d.mergeable === 'CONFLICTING' || d.mergeStateStatus === 'DIRTY') return { text: `Conflicts with ${d.base}: resolve them before merging`, color: 'error' }
  if (d.queue) return queued(d)
  const failing = d.checkList.filter(c => c.isRequired && c.outcome === 'fail').length
  const pending = d.checkList.filter(c => c.isRequired && c.outcome === 'pending').length
  let text = ''
  let color = 'subtle'
  switch (d.mergeStateStatus) {
    case 'CLEAN':
      ;[text, color] = ['Ready to merge', 'success']
      break
    case 'HAS_HOOKS':
      ;[text, color] = ['Ready to merge (the server runs pre-receive hooks)', 'success']
      break
    case 'UNSTABLE':
      ;[text, color] = ["Can merge, but checks that aren't required are failing", 'warning']
      break
    case 'BEHIND':
      ;[text, color] = [`Behind ${d.base}: it must be brought up to date first`, 'warning']
      break
    case 'BLOCKED':
      color = 'error'
      if (failing > 0) text = `Blocked: ${plural(failing, 'required check', 'required checks')} failing`
      else if (d.reviewDecision === 'CHANGES_REQUESTED') text = 'Blocked: changes requested'
      else if (d.reviewDecision === 'REVIEW_REQUIRED') text = 'Blocked: needs an approving review'
      else if (pending > 0) [text, color] = [`Waiting on ${plural(pending, 'required check', 'required checks')}`, 'warning']
      else text = "Blocked by the branch's rules"
      break
    default:
      text = 'GitHub is still working out whether it can merge (r to reload)'
  }
  if (d.queueEnabled && color === 'success') text = `${text}: through the merge queue`
  if (!d.settings.canMerge) text += " · you can't merge in this repo"
  return { text, color }
}

// How long ago, as a short age: 30m, 5h, 2d.
export function age(iso: string, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (!Number.isFinite(m)) return ''
  if (m < 60) return `${m}m`
  if (m < 48 * 60) return `${Math.round(m / 60)}h`
  return `${Math.round(m / 1440)}d`
}

// Where it is in the merge queue, in words.
export const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
const QUEUE_STATES: Record<string, string> = {
  QUEUED: 'waiting its turn',
  AWAITING_CHECKS: 'its checks are running',
  MERGEABLE: 'about to merge',
  UNMERGEABLE: "it can't merge, and will be taken out",
  LOCKED: 'merging now',
}

export function queued(d: Detail): { text: string; color: string } {
  const q = d.queue!
  const eta = d.queueEta ? ` · about ${Math.max(1, Math.round(d.queueEta / 60))} min` : ''
  return {
    text: `In the merge queue, ${ordinal(q.position)} in line: ${QUEUE_STATES[q.state] ?? q.state.toLowerCase()}${eta}`,
    color: q.state === 'UNMERGEABLE' ? 'error' : 'suggestion',
  }
}
