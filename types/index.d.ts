// What the GitHub pane keeps for the session.

// A pull request as the lists show it.
export type PR = {
  id: string
  number: number
  title: string
  url: string
  isDraft: boolean
  // OPEN, MERGED or CLOSED.
  state: string
  updatedAt: string
  author: string
  repo: string
  head: string
  base: string
  isCrossRepository: boolean
  headOwner: string | null
  // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null.
  reviewDecision: string | null
  // MERGEABLE, CONFLICTING or UNKNOWN.
  mergeable: string
  additions: number
  deletions: number
  // The checks' rollup: SUCCESS, FAILURE, ERROR, PENDING, EXPECTED, or null.
  checks: string | null
  labels: { name: string; color: string }[]
  autoMerge: string | null
}

export type Check = {
  name: string
  // pass, fail, pending, skipped.
  outcome: string
  isRequired: boolean
  url: string | null
}

export type Comment = { author: string; body: string; createdAt: string; state?: string }

export type Thread = { path: string; line: number | null; isOutdated: boolean; comments: Comment[] }

export type RepoSettings = {
  squash: boolean
  merge: boolean
  rebase: boolean
  autoMerge: boolean
  deleteBranchOnMerge: boolean
  defaultMethod: string | null
  canMerge: boolean
}

// Everything the PR screen shows.
export type Detail = PR & {
  body: string
  mergeStateStatus: string
  changedFiles: number
  headOid: string
  headRefId: string | null
  checkList: Check[]
  // Each reviewer's latest word, and those asked who haven't answered.
  reviews: { author: string; state: string }[]
  requested: string[]
  conversation: Comment[]
  threads: Thread[]
  settings: RepoSettings
}

// A Claude Code session that has to do with a PR.
export type Agent = {
  session: string
  name: string
  // opened it, on its branch, worked on it.
  how: 'opened' | 'branch' | 'worked' | 'cloud'
  // running, idle, busy, or gone (not running).
  status: string
  cwd: string | null
  // The id `claude attach` takes, for a background session.
  bg: string | null
  // A cloud session's link on claude.ai.
  link?: string | null
}

export type Tab = 'mine' | 'review' | 'repo'

export type Loaded = { prs: PR[]; at: number; error: string | null; isLoading: boolean }

// Where the pane is: the lists, the repo picker, or a PR (with a menu open).
export type Menu = null | 'merge' | 'confirm' | 'after' | 'agents' | 'clone'
export type View =
  | { screen: 'list' }
  | { screen: 'repos' }
  | { screen: 'pr'; key: string; menu: Menu; pick: string | null }

export type Notice = { text: string; link: string | null; isError: boolean; copy: string | null }

declare module 'claude-code' {
  interface PluginState {
    github: {
      view: Shaped<View>
      tab: Tab
      // The repo tab's repo, owner/name.
      repo: string | null
      loaded: Shaped<Record<string, Loaded>>
      details: Shaped<Record<string, Detail>>
      agents: Shaped<Record<string, Agent[]>>
      worktrees: Shaped<Record<string, string>>
      repos: Shaped<string[]>
      filter: string
      selected: number
      notice: Shaped<Notice | null>
      // Where the pane was opened from, to go back to with Esc.
      from: string | null
      demo: boolean
      // The ⇄ beside the repo tab is where ↑ stopped: Enter picks a repo.
      armed: boolean
    }
  }
}
