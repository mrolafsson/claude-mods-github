// What's on this computer: the repo's checkout, a PR's worktree, Start, and
// the Claude Code sessions that have to do with a PR. herdr-github's ideas,
// for Claude Code: a worktree is a git worktree, an agent a Claude session,
// Start a background session (`claude --bg`), and going to an agent the
// command that reattaches or resumes it.

import type { EngineInterface } from 'claude-code'

import type { Agent, PR } from '../types'

async function run($: EngineInterface, argv: string[], cwd?: string, timeoutMs = 60_000) {
  try {
    return await $.process.run(argv, { ...(cwd ? { cwd } : {}), timeoutMs })
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
}

function sh($: EngineInterface, script: string, cwd?: string, timeoutMs?: number) {
  return run($, ['sh', '-c', script], cwd, timeoutMs)
}
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

// owner/name from a remote's URL (https or ssh), or null.
export function repoOfRemote(url: string): string | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

async function home($: EngineInterface): Promise<string> {
  return (await sh($, 'printf %s "$HOME"')).stdout || '~'
}

// Every repo a folder's remotes point at (a fork's clone with an upstream
// remote counts for the upstream too).
async function remotesOf($: EngineInterface, dir: string): Promise<string[]> {
  const r = await run($, ['git', '-C', dir, 'remote', '-v'])
  if (r.exitCode !== 0) return []
  return [...new Set(r.stdout.split('\n').map(l => repoOfRemote(l.split(/\s+/)[1] ?? '')).filter((x): x is string => Boolean(x)))]
}

async function rootOf($: EngineInterface, dir: string): Promise<string | null> {
  const r = await run($, ['git', '-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (r.exitCode !== 0) return null
  // The main checkout, not a worktree of it: the common git dir's parent.
  return r.stdout.trim().replace(/\/\.git\/?$/, '')
}

// The Claude Code sessions running here, as `claude agents` lists them.
export type Running = { sessionId: string; name: string; status: string; cwd: string; kind: string; pid: number }

export async function running($: EngineInterface): Promise<Running[]> {
  const r = await run($, ['claude', 'agents', '--json'])
  try {
    return (JSON.parse(r.stdout || '[]') as any[]).map(a => ({
      sessionId: String(a.sessionId ?? ''),
      name: String(a.name ?? ''),
      status: String(a.status ?? ''),
      cwd: String(a.cwd ?? ''),
      kind: String(a.kind ?? ''),
      pid: Number(a.pid ?? 0),
    }))
  } catch {
    return []
  }
}

// A checkout of the repo, as herdr-github finds one: one picked before, this
// session's repository, the folders Claude sessions run in (by their remotes),
// then ~/code/owner/repo. null when there's none.
export async function findCheckout($: EngineInterface, repo: string): Promise<string | null> {
  const kept = (await $.store.get(`checkout:${repo}`)) as string | undefined
  const seen = new Set<string>()
  const candidates: string[] = []
  if (kept) candidates.push(kept)
  const own = await $.session.repo()
  if (own?.root) candidates.push(own.root)
  for (const a of await running($)) if (a.cwd) candidates.push(a.cwd)
  candidates.push(`${await home($)}/code/${repo}`)
  for (const dir of candidates) {
    const root = await rootOf($, dir)
    if (!root || seen.has(root)) continue
    seen.add(root)
    if ((await remotesOf($, root)).includes(repo)) {
      await $.store.set(`checkout:${repo}`, root)
      return root
    }
  }
  return null
}

// Where a clone of the repo would go: ~/code/owner/repo.
export async function clonePath($: EngineInterface, repo: string) {
  return `${await home($)}/code/${repo}`
}

export async function clone($: EngineInterface, repo: string): Promise<string> {
  const dir = await clonePath($, repo)
  const r = await run($, ['gh', 'repo', 'clone', repo, dir], undefined, 600_000)
  if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || 'gh repo clone failed')
  await $.store.set(`checkout:${repo}`, dir)
  return dir
}

// The local branch a PR's worktree is on: its own branch, or for a fork's PR
// <fork owner>/<branch>, so it can't collide with one of yours.
export const localBranch = (pr: PR) => (pr.isCrossRepository && pr.headOwner ? `${pr.headOwner}/${pr.head}` : pr.head)

// The worktree on the PR's branch in a checkout, or null.
export async function existingWorktree($: EngineInterface, root: string, pr: PR): Promise<string | null> {
  const r = await run($, ['git', '-C', root, 'worktree', 'list', '--porcelain'])
  if (r.exitCode !== 0) return null
  const want = `branch refs/heads/${localBranch(pr)}`
  for (const block of r.stdout.split('\n\n')) {
    const lines = block.split('\n')
    if (lines.includes(want)) return lines.find(l => l.startsWith('worktree '))?.slice(9) ?? null
  }
  return null
}

// Makes the PR's worktree beside the checkout (<repo>.worktrees/<branch>):
// its own branch fetched fresh and tracking the remote; a fork's from
// refs/pull/N/head with gh, which sets it to pull from and push to the fork.
// A local branch of that name already there is checked out as it is.
export async function createWorktree($: EngineInterface, root: string, pr: PR): Promise<string> {
  const branch = localBranch(pr)
  const parent = root.replace(/\/[^/]+$/, '')
  const name = root.split('/').pop()
  const path = `${parent}/${name}.worktrees/${branch.replace(/[^A-Za-z0-9._-]+/g, '-')}`
  const has = (await run($, ['git', '-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).exitCode === 0
  let r
  if (has) {
    r = await run($, ['git', '-C', root, 'worktree', 'add', path, branch])
  } else if (pr.isCrossRepository) {
    r = await sh($, `git -C ${q(root)} worktree add --detach ${q(path)} && cd ${q(path)} && gh pr checkout ${pr.number} --repo ${q(pr.repo)} --branch ${q(branch)}`, undefined, 180_000)
  } else {
    const remote = (await remotesOf($, root)).length ? await originFor($, root, pr.repo) : 'origin'
    r = await sh(
      $,
      `git -C ${q(root)} fetch ${q(remote)} ${q(pr.head)} && git -C ${q(root)} worktree add -b ${q(branch)} ${q(path)} ${q(`${remote}/${pr.head}`)} && git -C ${q(path)} branch --set-upstream-to=${q(`${remote}/${pr.head}`)}`,
      undefined,
      180_000,
    )
  }
  if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || 'git worktree add failed')
  return path
}

// The remote of a checkout that points at the repo.
async function originFor($: EngineInterface, root: string, repo: string): Promise<string> {
  const r = await run($, ['git', '-C', root, 'remote', '-v'])
  for (const l of r.stdout.split('\n')) {
    const [remote, url] = l.split(/\s+/)
    if (remote && url && repoOfRemote(url) === repo) return remote
  }
  return 'origin'
}

// Removes a worktree, unless it holds changes not committed (then why not).
export async function removeWorktree($: EngineInterface, root: string, path: string): Promise<string | null> {
  const dirty = await run($, ['git', '-C', path, 'status', '--porcelain'])
  if (dirty.stdout.trim()) return 'it has changes that aren\'t committed, so it stays'
  const r = await run($, ['git', '-C', root, 'worktree', 'remove', path])
  return r.exitCode === 0 ? null : (r.stderr || r.stdout).trim().split('\n').pop() || 'git worktree remove failed'
}

// herdr-github's start prompt.
// What a cloud session started on a PR is told: herdr-github's start prompt,
// for a session that starts from the repo's default branch.
export const startPrompt = (pr: PR) =>
  `Work on pull request ${pr.url} (#${pr.number}, ${pr.title}). Check out its branch with \`gh pr checkout ${pr.number}\` and push your commits to it. Read it with \`gh pr view ${pr.number} --comments\`, look at any failing checks and unresolved review threads, and tell me what's left to do.`

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

// Starts a Claude Code cloud session from a checkout of the PR's repo (the
// cloud clones the repo from GitHub; the checkout only says which), as the
// Linear mod's Start does: \`claude --cloud\` in a pseudo-terminal, which it
// wants. Its link on claude.ai.
export async function startCloud($: EngineInterface, checkout: string, prompt: string): Promise<string> {
  const os = (await run($, ['uname'])).stdout.trim()
  const argv =
    os === 'Darwin'
      ? ['script', '-q', '/dev/null', 'claude', '--cloud', prompt]
      : ['script', '-qfec', ['claude', '--cloud', prompt].map(quote).join(' '), '/dev/null']
  const r = await run($, argv, checkout, 180_000)
  const out = (r.stdout + '\n' + r.stderr).replace(/\x1b\[[0-9;?<>]*[a-zA-Z]/g, '')
  const link = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/.exec(out)?.[0]
  if (!link) throw new Error(out.trim().split('\n').pop() || `claude --cloud exited ${r.exitCode}`)
  return link
}

// ── A PR's agents ────────────────────────────────────────────────────────────

// The Claude Code sessions that have to do with each PR, by its key: the
// running ones on its branch (in a folder on it), and those whose transcripts
// in the last 30 days opened it (with gh pr create) or worked on it. One
// search of the transcripts for every PR at once.
export async function agentsOf($: EngineInterface, prs: PR[]): Promise<Record<string, Agent[]>> {
  const out: Record<string, Agent[]> = {}
  if (!prs.length) return out
  const add = (key: string, a: Agent) => {
    const list = (out[key] ??= [])
    const had = list.find(x => x.session === a.session)
    if (!had) list.push(a)
    else if (a.how === 'opened' || (a.how === 'branch' && had.how === 'worked')) Object.assign(had, { how: a.how })
  }
  const now = await running($)
  // Running sessions by the branch of the folder they're in.
  const branches = new Map<string, string>()
  for (const a of now) {
    if (!a.cwd || branches.has(a.cwd)) continue
    const r = await run($, ['git', '-C', a.cwd, 'branch', '--show-current'])
    branches.set(a.cwd, r.exitCode === 0 ? r.stdout.trim() : '')
  }
  for (const pr of prs) {
    for (const a of now) {
      if (a.cwd && branches.get(a.cwd) === pr.head) {
        add(`${pr.repo}#${pr.number}`, { session: a.sessionId, name: a.name || a.sessionId.slice(0, 8), how: 'branch', status: a.status, cwd: a.cwd, bg: a.kind === 'background' ? a.sessionId.slice(0, 8) : null })
      }
    }
  }
  // Transcripts that name a PR's link: which, and whether they opened it.
  const h = await home($)
  const repos = [...new Set(prs.map(p => p.repo.replace(/[.]/g, '\\.')))].join('|')
  const found = await sh(
    $,
    `cd ${q(`${h}/.claude/projects`)} 2>/dev/null || exit 0
     url='github\\.com/(${repos})/pull/[0-9]+'
     files=$(find . -name '*.jsonl' -mtime -30 2>/dev/null)
     [ -n "$files" ] || exit 0
     # First the transcripts that name a PR, then what's in them: each line once.
     if command -v rg >/dev/null; then
       hits=$(echo "$files" | xargs rg -l -e "$url" 2>/dev/null)
       [ -n "$hits" ] && echo "$hits" | xargs rg -o --with-filename --no-line-number -e "$url" -e 'gh pr create' -e '"customTitle":"[^"]*"' -e '"cwd":"[^"]*"' 2>/dev/null | awk '!seen[$0]++'
     else
       hits=$(echo "$files" | xargs grep -l -E "$url" 2>/dev/null)
       [ -n "$hits" ] && echo "$hits" | xargs grep -o -H -E "$url|gh pr create|\"customTitle\":\"[^\"]*\"|\"cwd\":\"[^\"]*\"" 2>/dev/null | awk '!seen[$0]++'
     fi
     true`,
    undefined,
    120_000,
  )
  const files = new Map<string, { urls: Set<string>; created: boolean; title: string; cwd: string }>()
  for (const line of found.stdout.split('\n')) {
    const i = line.indexOf(':')
    if (i < 0) continue
    const file = line.slice(0, i)
    const what = line.slice(i + 1)
    const f = files.get(file) ?? { urls: new Set<string>(), created: false, title: '', cwd: '' }
    if (what === 'gh pr create') f.created = true
    else if (what.startsWith('"customTitle"')) f.title = what.slice(15, -1)
    // The folder the session ran in: its first word on it.
    else if (what.startsWith('"cwd"')) f.cwd ||= what.slice(7, -1)
    else f.urls.add(what)
    files.set(file, f)
  }
  for (const [file, f] of files) {
    const session = file.split('/').pop()!.replace(/\.jsonl$/, '')
    const live = now.find(a => a.sessionId === session)
    for (const url of f.urls) {
      const m = /github\.com\/(.+)\/pull\/(\d+)/.exec(url)
      if (!m) continue
      const key = `${m[1]}#${m[2]}`
      if (!prs.some(p => `${p.repo}#${p.number}` === key)) continue
      add(key, {
        session,
        name: live?.name || f.title || session.slice(0, 8),
        // A transcript that ran gh pr create and names the PR opened it.
        how: f.created ? 'opened' : 'worked',
        status: live?.status ?? 'gone',
        cwd: live?.cwd ?? (f.cwd || null),
        bg: live?.kind === 'background' ? session.slice(0, 8) : null,
      })
    }
  }
  return out
}

// What takes you to an agent: reattach a background session, resume another.
export const agentCommand = (a: Agent) => (a.link ? a.link : a.bg ? `claude attach ${a.bg}` : `${a.cwd ? `cd ${q(a.cwd)} && ` : ''}claude --resume ${a.session}`)

// ── Going to a PR's session ──────────────────────────────────────────────────

// Takes the person to a Claude Code session, where the terminal they're in
// can: Claude Code itself can't switch to another session. In herdr, its
// pane if it's running there (herdr knows each pane's Claude session), else
// a new tab resuming it in its folder; in tmux, a new window doing that.
// Says what it did, or null where it can't (the command is copied instead).
export async function goTo($: EngineInterface, a: Agent): Promise<string | null> {
  const env = (await sh($, 'printf "%s|%s" "$HERDR_SOCKET_PATH" "$TMUX"')).stdout
  const [herdr, tmux] = env.split('|')
  const command = a.bg ? `claude attach ${a.bg}` : `claude --resume ${a.session}`
  if (herdr) {
    const list = await run($, ['herdr', 'agent', 'list'])
    let agents: any[] = []
    try {
      agents = JSON.parse(list.stdout).result?.agents ?? []
    } catch {
      agents = []
    }
    const live = agents.find(x => x?.agent_session?.value === a.session)
    if (live?.pane_id) {
      const r = await run($, ['herdr', 'agent', 'focus', String(live.pane_id)])
      if (r.exitCode === 0) return `Switched to ${a.name}, in its herdr pane.`
    }
    const tab = await run($, ['herdr', 'tab', 'create', ...(a.cwd ? ['--cwd', a.cwd] : []), '--label', a.name.slice(0, 40), '--focus'])
    let pane: string | undefined
    try {
      const res = JSON.parse(tab.stdout).result
      pane = res?.root_pane?.pane_id ?? res?.root_pane?.id
    } catch {
      pane = undefined
    }
    if (pane) {
      const r = await run($, ['herdr', 'pane', 'run', pane, command])
      if (r.exitCode === 0) return `${a.name} is open again, in a new herdr tab.`
    }
  }
  if (tmux) {
    const r = await run($, ['tmux', 'new-window', ...(a.cwd ? ['-c', a.cwd] : []), '-n', a.name.slice(0, 30), command])
    if (r.exitCode === 0) return `${a.name} is open again, in a new tmux window.`
  }
  return null
}
