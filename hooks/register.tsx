// Your GitHub pull requests in a pane, as herdr-github's popup has them:
// three tabs (Mine, Review requested, this repo), each grouped by whose move
// it is; a PR's screen with its checks, reviews, threads and conversation;
// draft ↔ ready, merge (pinned to the commit you were looking at), auto-merge,
// worktrees, Start, and the Claude Code sessions that have to do with a PR.
// GitHub through gh's own sign-in. With the Linear mod installed, a PR's
// Linear issue is a key away, and Linear's issues reach their PRs.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent, Detail, Loaded, Notice, PR, Tab, View } from '../types'
import { DEMO_NOW } from './demo'
import {
  AUTO_OFF, AUTO_ON, BY_NUMBER, DELETE_REF, DETAIL, GROUPS, METHOD_NAMES, METHOD_VERBS, MERGE, READY, REPOS, SEARCH,
  TAB_QUERY, TO_DRAFT, age, checkMark, gql, groupOf, keyOf, mergeableNow, readiness, toDetail, toPR,
} from './gh'
import type { Group } from './gh'
import {
  agentCommand, agentsOf, clone, clonePath, createWorktree, existingWorktree, findCheckout, localBranch, removeWorktree,
  repoOfRemote, startCloud, startPrompt,
} from './local'

const PANE = 'github'

const view = atom({ plugin: 'github', key: 'view' } as const, { screen: 'list' } as View, { shape: 'view-1' })
const tab = atom({ plugin: 'github', key: 'tab' } as const, 'mine' as Tab)
const repoTab = atom({ plugin: 'github', key: 'repo' } as const, null as string | null)
const loaded = atom({ plugin: 'github', key: 'loaded' } as const, {} as Record<string, Loaded>, { shape: 'loaded-1' })
const details = atom({ plugin: 'github', key: 'details' } as const, {} as Record<string, Detail>, { shape: 'details-1' })
const agents = atom({ plugin: 'github', key: 'agents' } as const, {} as Record<string, Agent[]>, { shape: 'agents-1' })
const worktrees = atom({ plugin: 'github', key: 'worktrees' } as const, {} as Record<string, string>, { shape: 'worktrees-1' })
const repos = atom({ plugin: 'github', key: 'repos' } as const, [] as string[], { shape: 'repos-1' })
const filter = atom({ plugin: 'github', key: 'filter' } as const, '')
const selected = atom({ plugin: 'github', key: 'selected' } as const, 0)
const notice = atom({ plugin: 'github', key: 'notice' } as const, null as Notice | null, { shape: 'notice-1' })
const from = atom({ plugin: 'github', key: 'from' } as const, null as string | null)
const isDemo = atom({ plugin: 'github', key: 'demo' } as const, false)
// The ⇄ beside the repo tab, which ↑ stops on after that tab: Enter then
// picks another repo.
const armed = atom({ plugin: 'github', key: 'armed' } as const, false)

const TABS: Tab[] = ['mine', 'review', 'repo']

// How many lines of the list the pane has room for, as it was last drawn.
let room = 20
// The element the pane's keyboard is on: the filter, as it opens.
let ring: string | null = null
// Whether the Linear mod is installed, for its issues' links.
let hasLinear = false

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const cut = (text: string, n: number) => (text.length <= n ? text : n <= 1 ? '' : `${text.slice(0, n - 1)}…`)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// A ticket's key in a branch or a title, as herdr-linear finds one.
const TICKET = /(?:^|[^a-z0-9])([a-z][a-z0-9]{1,9})-([1-9][0-9]{0,5})(?=[^a-z0-9]|$)/gi
const NOT_TICKETS = new Set(
  'phase step part pr v version release issue fix bug test try attempt wave stage sprint week day round batch task milestone iteration option plan draft rev'.split(' '),
)
export function ticketKey(...texts: string[]): string | null {
  for (const s of texts) {
    for (const m of s.matchAll(TICKET)) if (!NOT_TICKETS.has(m[1]!.toLowerCase())) return `${m[1]!.toUpperCase()}-${m[2]}`
  }
  return null
}

const tabKey = (t: Tab, repo: string | null) => (t === 'repo' ? `repo:${repo ?? ''}` : t)

async function say($: EngineInterface, text: string, opts: { link?: string; copy?: string; isError?: boolean } = {}) {
  await update($, notice, () => ({ text, link: opts.link ?? null, copy: opts.copy ?? null, isError: Boolean(opts.isError) }))
}

async function copy($: EngineInterface, text: string, surface: any, what: string) {
  const r = await $.ui.copy({ text, surface })
  if (r.isCopied) await say($, `${what} is copied.`)
  else await say($, `${what} couldn't be copied here (${r.reason}): select it on screen instead.`, { isError: true })
}

// As a dialog, as big as the layout allows; opened again while open, it
// takes the keyboard back (Esc gave it up).
async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'GitHub', focus: true, closeOnEscape: true, holdToasts: true, rows: 1000, columns: 1000 })
}

// Each screen's elements have keys of their own (the list's filter is
// `filter`, the picker's `repo-filter`), so a screen just switched to isn't
// drawn yet when this runs: focused before it is, the ring would land on the
// screen going away, and the keyboard go back to the prompt with it. So it
// waits, a frame at a time, for the element to be drawn.
async function focusOn($: EngineInterface, key: string) {
  await openPane($)
  for (let n = 0; n < 20; n++) {
    const r = await $.ui.focus({ requestId: PANE, key }).catch(() => ({ deny: 'failed' }))
    if (!r.deny) {
      ring = key
      return
    }
    if (!/drawn/i.test(r.deny)) return
    await $.clock.sleep(25)
  }
}

// The repo of this session's folder, owner/name, or null.
async function sessionRepo($: EngineInterface): Promise<string | null> {
  if (await read($, isDemo)) return 'halcyon/notes-app'
  const r = await $.session.repo()
  return r?.remote ? repoOfRemote(r.remote) : null
}

// ── Loading ─────────────────────────────────────────────────────────────────

// A tab's PRs, page by page: the first small to show something soon (GitHub
// takes about a second per ten), the rest in bigger pages, 200 at most. What
// was found last time shows at once, marked as updating.
async function load($: EngineInterface, t: Tab) {
  const demo = await read($, isDemo)
  const repo = await read($, repoTab)
  if (t === 'repo' && !repo) return
  const key = tabKey(t, repo)
  if (!(await read($, loaded))[key] && !demo) {
    const kept = await $.store.get(`prs:${key}`)
    if (Array.isArray(kept)) await update($, loaded, all => ({ ...all, [key]: { prs: kept as PR[], at: 0, error: null, isLoading: true } }))
  }
  await update($, loaded, all => ({ ...all, [key]: { prs: all[key]?.prs ?? [], at: all[key]?.at ?? 0, error: null, isLoading: true } }))
  const q = t === 'repo' ? TAB_QUERY.repo(repo!) : TAB_QUERY[t]
  const prs: PR[] = []
  try {
    let after: string | null = null
    let first = 20
    do {
      const d = await gql($, demo, SEARCH, { q, first, after })
      prs.push(...(d.search.nodes ?? []).filter((n: any) => n?.number).map(toPR))
      after = d.search.pageInfo?.hasNextPage ? d.search.pageInfo.endCursor : null
      first = 50
      if (after) await update($, loaded, all => ({ ...all, [key]: { prs: [...prs], at: 0, error: null, isLoading: true } }))
    } while (after && prs.length < 200)
    await update($, loaded, all => ({ ...all, [key]: { prs, at: Date.now(), error: null, isLoading: false } }))
    if (!demo) await $.store.set(`prs:${key}`, prs)
    void lookLocally($, prs)
  } catch (err) {
    await update($, loaded, all => ({ ...all, [key]: { prs: all[key]?.prs ?? [], at: 0, error: message(err), isLoading: false } }))
  }
}

// The worktrees and the Claude Code sessions of a list's PRs, behind it.
async function lookLocally($: EngineInterface, prs: PR[]) {
  if (await read($, isDemo)) {
    await update($, worktrees, all => ({ ...all, 'halcyon/notes-app#482': '~/code/halcyon/notes-app.worktrees/sam-hal-212-offline-conflicts', 'halcyon/notes-app#476': '~/code/halcyon/notes-app.worktrees/sam-crdt-spike' }))
    await update($, agents, () => DEMO_AGENTS)
    return
  }
  try {
    const found: Record<string, string> = {}
    for (const repo of [...new Set(prs.map(p => p.repo))]) {
      const root = (await $.store.get(`checkout:${repo}`)) as string | undefined
      if (!root) continue
      for (const pr of prs.filter(p => p.repo === repo)) {
        const at = await existingWorktree($, root, pr)
        if (at) found[keyOf(pr)] = at
      }
    }
    await update($, worktrees, all => ({ ...all, ...found }))
    const by = await agentsOf($, prs)
    const clouds = await cloudAgents($, prs)
    for (const [k, list] of Object.entries(clouds)) by[k] = [...list, ...(by[k] ?? [])]
    await update($, agents, all => ({ ...all, ...by }))
  } catch {
    // What's on this computer is extra: the lists stand without it.
  }
}

const DEMO_AGENTS: Record<string, Agent[]> = {
  'halcyon/notes-app#482': [
    { session: 'a1b2c3d4-demo', name: 'Offline sync conflicts', how: 'opened', status: 'idle', cwd: '~/code/halcyon/notes-app.worktrees/sam-hal-212-offline-conflicts', bg: null },
    { session: 'e5f6a7b8-demo', name: 'Review the three-way merge', how: 'branch', status: 'busy', cwd: '~/code/halcyon/notes-app.worktrees/sam-hal-212-offline-conflicts', bg: 'e5f6a7b8' },
  ],
  'halcyon/notes-app#476': [{ session: 'c9d0e1f2-demo', name: 'CRDT spike', how: 'opened', status: 'gone', cwd: '~/code/halcyon/notes-app', bg: null }],
}

async function loadRepos($: EngineInterface) {
  const demo = await read($, isDemo)
  try {
    const out: string[] = []
    let after: string | null = null
    do {
      const d = await gql($, demo, REPOS, { after })
      out.push(...(d.viewer.repositories.nodes ?? []).map((n: any) => String(n.nameWithOwner)))
      after = d.viewer.repositories.pageInfo?.hasNextPage ? d.viewer.repositories.pageInfo.endCursor : null
    } while (after && out.length < 500)
    await update($, repos, () => out)
    if (!demo) await $.store.set('repos', out)
  } catch (err) {
    await say($, `Couldn't list your repos: ${message(err)}`, { isError: true })
  }
}

// A PR's screen, loaded fresh: everything the screen shows.
// The screen is read and acted on by its letters, the arrows scrolling it:
// no element of it has the ring. When the row pressed goes, the ring keeps
// its place in the order of the elements, which on this screen is one of
// its pills: it would look selected, and Enter would press it. So the screen
// is drawn first with no element at all, which the ring falls off, and then
// whole.
let blank = false
let draws = 0

async function openPR($: EngineInterface, key: string) {
  blank = true
  ring = null
  const was = draws
  await update($, view, (): View => ({ screen: 'pr', key, menu: null, pick: null }))
  for (let n = 0; n < 40 && draws === was; n++) await $.clock.sleep(10)
  blank = false
  await update($, view, v => ({ ...v }))
  await reloadPR($, key)
}

async function reloadPR($: EngineInterface, key: string) {
  const demo = await read($, isDemo)
  const pr = await findPR($, key)
  if (!pr) return say($, `Couldn't find ${key}.`, { isError: true })
  try {
    const d = await gql($, demo, DETAIL, { id: pr.id, n: pr.number })
    if (!d.node) throw new Error(`${key} isn't there any more`)
    const detail = toDetail(d.node)
    await update($, details, all => ({ ...all, [key]: detail }))
    void lookLocally($, [detail])
  } catch (err) {
    await say($, `Couldn't load ${key}: ${message(err)}`, { isError: true })
  }
}

// A PR by its key: from the lists, the details, or asked of GitHub.
async function findPR($: EngineInterface, key: string): Promise<PR | null> {
  const d = (await read($, details))[key]
  if (d) return d
  for (const l of Object.values(await read($, loaded))) {
    const pr = l.prs.find(p => keyOf(p) === key)
    if (pr) return pr
  }
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(key)
  if (!m) return null
  try {
    const r = await gql($, await read($, isDemo), BY_NUMBER, { owner: m[1]!, name: m[2]!, n: Number(m[3]) })
    return r.repository?.pullRequest ? toPR(r.repository.pullRequest) : null
  } catch {
    return null
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function flipDraft($: EngineInterface, d: Detail) {
  const demo = await read($, isDemo)
  try {
    await gql($, demo, d.isDraft ? READY : TO_DRAFT, { id: d.id })
    await say($, d.isDraft ? `#${d.number} is ready for review.` : `#${d.number} is a draft again.`)
    await reloadPR($, keyOf(d))
    void load($, await read($, tab))
  } catch (err) {
    await say($, `Couldn't change #${d.number}: ${message(err)}`, { isError: true })
  }
}

// The merge methods the repo allows, the one you used last in it first,
// else the one GitHub remembers for you.
async function methods($: EngineInterface, d: Detail): Promise<string[]> {
  const last = (await $.store.get(`method:${d.repo}`)) as string | undefined
  const allowed = (['SQUASH', 'MERGE', 'REBASE'] as const).filter(m => (m === 'SQUASH' ? d.settings.squash : m === 'MERGE' ? d.settings.merge : d.settings.rebase))
  const first = last && allowed.includes(last as never) ? last : d.settings.defaultMethod
  return [...allowed].sort((a, b) => Number(b === first) - Number(a === first))
}

// What the merge menu offers now.
async function mergeOptions($: EngineInterface, d: Detail): Promise<{ key: string; label: string }[] | string> {
  if (d.state === 'MERGED') return 'Already merged.'
  if (d.state === 'CLOSED') return 'Closed: reopen it on GitHub to merge it.'
  if (d.isDraft) return "A draft can't merge: mark it ready for review first (d)."
  if (d.mergeable === 'CONFLICTING' || d.mergeStateStatus === 'DIRTY') return `It conflicts with ${d.base}: resolve that first.`
  if (!d.settings.canMerge) return "You can't merge in this repo."
  const ms = await methods($, d)
  const out: { key: string; label: string }[] = []
  if (mergeableNow(d)) for (const m of ms) out.push({ key: `merge:${m}`, label: METHOD_NAMES[m]! })
  else if (d.settings.autoMerge && !d.autoMerge && ms[0]) out.push({ key: `auto:${ms[0]}`, label: `Auto-merge when ready (${METHOD_NAMES[ms[0]]!.toLowerCase()})` })
  if (d.autoMerge) out.push({ key: 'auto-off', label: 'Turn off auto-merge' })
  if (!out.length) return `It can't merge yet: ${readiness(d).text}.`
  return out
}

// The question a pick asks once more, naming exactly what will happen.
function confirmText(d: Detail, pick: string): string {
  const [kind, m] = pick.split(':')
  if (kind === 'merge') return `${METHOD_VERBS[m!]} #${d.number} into ${d.base} now?`
  if (kind === 'auto') return `Turn on auto-merge (${METHOD_NAMES[m!]!.toLowerCase()}) for #${d.number}?`
  return `Turn off auto-merge for #${d.number}?`
}

async function doPick($: EngineInterface, d: Detail, pick: string) {
  const demo = await read($, isDemo)
  const [kind, m] = pick.split(':')
  const key = keyOf(d)
  try {
    if (kind === 'merge') {
      // Pinned to the commit on screen: GitHub refuses if anyone pushed since.
      await gql($, demo, MERGE, { id: d.id, method: m!, oid: d.headOid })
      await $.store.set(`method:${d.repo}`, m)
      await say($, `#${d.number} is merged into ${d.base}.`)
      await reloadPR($, key)
      const wt = (await read($, worktrees))[key]
      const canDelete = !d.settings.deleteBranchOnMerge && !d.isCrossRepository && d.headRefId
      if (canDelete || wt) await update($, view, (v): View => (v.screen === 'pr' ? { ...v, menu: 'after', pick: null } : v))
      else await update($, view, (v): View => (v.screen === 'pr' ? { ...v, menu: null, pick: null } : v))
    } else {
      await gql($, demo, kind === 'auto' ? AUTO_ON : AUTO_OFF, kind === 'auto' ? { id: d.id, method: m! } : { id: d.id })
      if (kind === 'auto') await $.store.set(`method:${d.repo}`, m)
      await say($, kind === 'auto' ? `#${d.number} merges by itself once it can.` : `Auto-merge is off for #${d.number}.`)
      await update($, view, (v): View => (v.screen === 'pr' ? { ...v, menu: null, pick: null } : v))
      await reloadPR($, key)
    }
    void load($, await read($, tab))
  } catch (err) {
    const why = message(err)
    await say($, /head|expected/i.test(why) ? `Not merged: someone pushed since this screen loaded. Reload it (r) and look again.` : `Not done: ${why}`, { isError: true })
    await update($, view, (v): View => (v.screen === 'pr' ? { ...v, menu: null, pick: null } : v))
  }
}

async function deleteBranch($: EngineInterface, d: Detail) {
  try {
    if (d.headRefId) await gql($, await read($, isDemo), DELETE_REF, { id: d.headRefId })
    await say($, `The branch ${d.head} is deleted on GitHub.`)
  } catch (err) {
    await say($, `Couldn't delete ${d.head}: ${message(err)}`, { isError: true })
  }
}

// The PR's worktree: found, or made. With no checkout of the repo here, the
// clone menu instead.
async function worktree($: EngineInterface, pr: PR): Promise<string | null> {
  const key = keyOf(pr)
  if (await read($, isDemo)) {
    const at = (await read($, worktrees))[key] ?? `~/code/${pr.repo}.worktrees/${localBranch(pr).replace(/[^A-Za-z0-9._-]+/g, '-')}`
    await update($, worktrees, all => ({ ...all, [key]: at }))
    await say($, `Demo: the worktree for #${pr.number} would be at ${at}.`, { copy: `cd ${at} && claude` })
    return at
  }
  const root = await findCheckout($, pr.repo)
  if (!root) {
    await update($, view, (v): View => (v.screen === 'pr' ? { ...v, menu: 'clone', pick: null } : v))
    return null
  }
  try {
    const at = (await existingWorktree($, root, pr)) ?? (await createWorktree($, root, pr))
    await update($, worktrees, all => ({ ...all, [key]: at }))
    await say($, `The worktree for #${pr.number} is at ${at}.`, { copy: `cd ${at} && claude` })
    return at
  } catch (err) {
    await say($, `Couldn't make the worktree: ${message(err)}`, { isError: true })
    return null
  }
}

// Start: a Claude Code cloud session on the PR, told what herdr-github's
// start prompt tells an agent, on the PR's branch. Started from a checkout of
// the repo (the cloud clones it from GitHub; the checkout only says which).
// What's started is kept with the PR, among its agents.
type Cloud = { link: string; at: number }

async function start($: EngineInterface, pr: PR) {
  const key = keyOf(pr)
  if (await read($, isDemo)) {
    await say($, `Demo: a Claude Code cloud session would now start on #${pr.number}, on its branch ${pr.head}, told to read the PR, its failing checks and its review threads.`)
    return
  }
  const root = await findCheckout($, pr.repo)
  if (!root) {
    await say($, `Start runs in the cloud from a checkout of ${pr.repo}, and there's none here: clone it, then Start again.`, { isError: true })
    await update($, view, (v): View => (v.screen === 'pr' ? { ...v, menu: 'clone', pick: null } : v))
    return
  }
  await say($, `Starting #${pr.number} in the cloud…`)
  try {
    const link = await startCloud($, root, startPrompt(pr))
    const kept = ((await $.store.get(`cloud:${key}`)) as Cloud[] | undefined) ?? []
    await $.store.set(`cloud:${key}`, [{ link, at: Date.now() }, ...kept].slice(0, 10))
    await say($, `#${pr.number} is running in the cloud.`, { link })
    $.ui.toast(`#${pr.number} started in the cloud`)
    void lookLocally($, [pr])
  } catch (err) {
    await say($, `The cloud session didn't start: ${message(err)}`, { isError: true })
  }
}

// The cloud sessions Start began on these PRs, as agents.
async function cloudAgents($: EngineInterface, prs: PR[]): Promise<Record<string, Agent[]>> {
  const out: Record<string, Agent[]> = {}
  for (const pr of prs) {
    const kept = ((await $.store.get(`cloud:${keyOf(pr)}`)) as Cloud[] | undefined) ?? []
    if (kept.length) {
      out[keyOf(pr)] = kept.map(c => ({ session: c.link, name: `Cloud session, ${new Date(c.at).toISOString().slice(0, 10)}`, how: 'cloud' as const, status: 'cloud', cwd: null, bg: null, link: c.link }))
    }
  }
  return out
}

// The repos the picker offers, filtered, in the order it lists them: by
// org, this session's org first with its repo on top, then as found.
async function repoChoices($: EngineInterface) {
  const f = (await read($, filter)).toLowerCase()
  const own = await sessionRepo($)
  // The demo keeps to its own org: none of your recent repos.
  const demo = await read($, isDemo)
  const recent = demo ? [] : (((await $.store.get('recent-repos')) as string[] | undefined) ?? [])
  const known = [...new Set([...(own ? [own] : []), ...recent, ...Object.values(await read($, loaded)).flatMap(l => l.prs.map(p => p.repo)), ...(await read($, repos))])]
  const shown = known.filter(r => !f || r.toLowerCase().includes(f) || r.split('/')[0]!.toLowerCase() === f)
  const orgs: string[] = []
  for (const r of shown) {
    const o = r.split('/')[0]!
    if (!orgs.includes(o)) orgs.push(o)
  }
  if (own) orgs.sort((a, b) => Number(b === own.split('/')[0]) - Number(a === own.split('/')[0]))
  const ordered = orgs.flatMap(o => shown.filter(r => r.startsWith(`${o}/`)).sort((a, b) => Number(b === own) - Number(a === own)))
  const typed = /^[\w.-]+\/[\w.-]+$/.test(f) && !known.some(r => r.toLowerCase() === f) ? f : null
  return { own, recent, ordered, typed }
}

// ── The pane ────────────────────────────────────────────────────────────────

// Another tab: its list from the top, loaded if it isn't.
async function switchTab($: EngineInterface, to: Tab) {
  await update($, armed, () => false)
  await update($, tab, () => to)
  await update($, selected, () => 0)
  if (!(await read($, isDemo))) await $.store.set('tab', to)
  const key = tabKey(to, await read($, repoTab))
  if (!(await read($, loaded))[key]) void load($, to)
}

// The repo picker, for the repo tab's repo.
async function openPicker($: EngineInterface) {
  await update($, armed, () => false)
  await update($, filter, () => '')
  await update($, view, (): View => ({ screen: 'repos' }))
  await update($, selected, () => 0)
  if (!(await read($, repos)).length) {
    const kept = (await $.store.get('repos')) as string[] | undefined
    if (kept && !(await read($, isDemo))) await update($, repos, () => kept)
    void loadRepos($)
  }
  await focusOn($, 'repo-filter')
}

// The PRs a tab shows, filtered, in their groups' order.
function grouped(prs: PR[], f: string, inReview: boolean): Map<Group, PR[]> {
  const words = f.toLowerCase().split(/\s+/).filter(Boolean)
  const out = new Map<Group, PR[]>()
  for (const g of GROUPS) {
    const list = prs
      .filter(p => groupOf(p, inReview) === g.id)
      .filter(p => {
        const hay = `#${p.number} ${p.title} ${p.repo} ${p.author} ${p.head} ${p.labels.map(l => l.name).join(' ')}`.toLowerCase()
        return words.every(w => hay.includes(w))
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    if (list.length) out.set(g.id, list)
  }
  return out
}

async function currentPRs($: EngineInterface): Promise<PR[]> {
  const t = await read($, tab)
  const all = (await read($, loaded))[tabKey(t, await read($, repoTab))]?.prs ?? []
  return [...grouped(all, await read($, filter), t === 'review').values()].flat()
}

// Back to the list, the keyboard on the PR it came from.
async function back($: EngineInterface, key: string | null) {
  await update($, view, (): View => ({ screen: 'list' }))
  const at = key ? (await currentPRs($)).findIndex(p => keyOf(p) === key) : -1
  await update($, selected, () => Math.max(0, at))
  await focusOn($, at >= 0 && key ? `pr-${key}` : 'filter')
}

// Back to the pane this one was opened from: it closes, that one opens.
async function goBackFrom($: EngineInterface): Promise<boolean> {
  const was = await read($, from)
  if (!was) return false
  await update($, from, () => null)
  await $.ui.close({ id: PANE }).catch(() => undefined)
  await $.command.run({ command: was, args: 'back' } as any).catch(() => undefined)
  return true
}

// The Linear mod on an issue, from this pane: there, and Esc there back here.
async function openLinear($: EngineInterface, issueKey: string) {
  const demo = await read($, isDemo)
  await $.ui.close({ id: PANE }).catch(() => undefined)
  await $.command.run({ command: 'linear', args: `${demo ? 'demo ' : ''}issue ${issueKey} from:github` } as any).catch(() => undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'github',
      description: 'Your GitHub pull requests in a pane: review, merge, worktrees, start (`/github demo` for a made-up org)',
    })
    return next(e)
  })

  // /github, /github demo, /github pr owner/repo#n, with from:<mod> when
  // another mod opened it, to go back to with Esc.
  on('command.run', { command: 'github' }, async ($, e) => {
    await update($, notice, () => null)
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    // `back`: another mod's pane closed, and this one opens as it was left.
    if (words[0] === 'back') {
      if ((await read($, view)).screen === 'list') await focusOn($, 'filter')
      else await openPane($)
      return { text: 'GitHub pane opened.' }
    }
    const demo = words.includes('demo')
    await update($, isDemo, () => demo)
    await update($, from, () => words.find(w => w.startsWith('from:'))?.slice(5) ?? null)
    hasLinear = (await $.command.list()).some(c => c.name === 'linear')
    if (demo) await update($, repoTab, () => null)
    const own = await sessionRepo($)
    if (!(await read($, repoTab))) await update($, repoTab, () => own)
    const kept = (await $.store.get('tab')) as Tab | undefined
    if (kept && TABS.includes(kept) && !demo) await update($, tab, () => kept)
    if (demo) await update($, tab, () => 'mine')
    const prAt = words.indexOf('pr')
    const target = prAt >= 0 ? words[prAt + 1] : undefined
    if (target) {
      await openPane($)
      await openPR($, target.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+).*$/, '$1#$2'))
      return { text: 'GitHub pane opened.' }
    }
    if ((await read($, view)).screen !== 'list') await update($, view, (): View => ({ screen: 'list' }))
    for (const t of TABS) void load($, t)
    await update($, selected, () => 0)
    await focusOn($, 'filter')
    return { text: 'GitHub pane opened.' }
  })

  // Esc: a menu closes alone; a PR goes back to the list (or to the pane it
  // was opened from); the repo picker to the list; on the list the first Esc
  // clears the filter, the next closes the pane.
  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE || e.origin.kind !== 'person') return next(e)
    const v = await read($, view)
    if (v.screen === 'pr' && v.menu) {
      await update($, view, (): View => ({ ...v, menu: null, pick: null }))
      await openPane($)
      // Drawn again once the pane has the keyboard back, or its hotkeys stay
      // on the frame before ("no Button is held under handle").
      await update($, view, x => ({ ...x }))
      return { value: undefined }
    }
    if (v.screen === 'pr') {
      if (await goBackFrom($)) return { value: undefined }
      await back($, v.key)
      return { value: undefined }
    }
    if (v.screen === 'repos') {
      await update($, filter, () => '')
      await back($, null)
      return { value: undefined }
    }
    if (await read($, filter)) {
      await update($, filter, () => '')
      await update($, selected, () => 0)
      await focusOn($, 'filter')
      return { value: undefined }
    }
    if (await goBackFrom($)) return { value: undefined }
    return next(e)
  })

  // ↑ from the filter switches tab (Mine → Review requested → the repo), the
  // cursor staying in the filter: the tabs are all there is above it. The
  // keyboard on a row moves the list with it.
  on('ui.focus', async ($, e, next) => {
    const element = e.element ?? (e as { key?: string }).key
    const origin = e.origin as { kind: string; name?: string } | undefined
    const isOwn = origin?.kind === 'plugin' && /^github(@|$)/.test(origin.name ?? '')
    if (e.requestId === PANE && !isOwn && (ring ?? 'filter') === 'filter' && element?.startsWith('tab-') && (await read($, view)).screen === 'list') {
      const t = await read($, tab)
      // After the repo tab, its ⇄; then round to Mine.
      if (t === 'repo' && !(await read($, armed))) await update($, armed, () => true)
      else await switchTab($, TABS[(TABS.indexOf(t) + 1) % TABS.length]!)
      return { deny: 'The tab switched; the cursor stays in the filter.' }
    }
    if (e.requestId === PANE && element?.startsWith('repo-') && element !== 'repo-typed') {
      const at = (await repoChoices($)).ordered.findIndex(r => `repo-${r}` === element)
      if (at >= 0) await update($, selected, () => at)
    }
    if (e.requestId === PANE && element?.startsWith('pr-')) {
      const at = (await currentPRs($)).findIndex(p => `pr-${keyOf(p)}` === element)
      if (at >= 0) await update($, selected, () => at)
    }
    const moved = await next(e)
    if (!moved.deny && e.requestId === PANE && element) {
      ring = element
      if (await read($, armed)) await update($, armed, () => false)
    }
    return moved
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Markdown, Link } = table
    const Input = 'Input' in table ? table.Input : null
    const v = await read($, view)
    const note = await read($, notice)
    const demo = await read($, isDemo)
    const width = e.props.bodyColumns ?? 80
    const now = demo ? DEMO_NOW : Date.now()

    const pill = (p: { id: string; hotkey?: string; label: string; color: string; onPress: (x: { surface: any }) => unknown }) => (
      <Button key={p.id} plain hotkey={p.hotkey} label={p.label} onPress={x => void p.onPress(x)}>
        <Text backgroundColor={p.color} color="inverseText" weight="semibold">{` ${p.label} `}</Text>
      </Button>
    )

    const noticeRow = note && (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text color={note.isError ? 'error' : 'success'} wrap="wrap">{note.text}</Text>
        {note.link && <Link href={note.link} label="open" />}
        {note.copy && <Button key="copy-note" plain hotkey="c" label={`copy: ${cut(note.copy, 50)}`} onPress={p => copy($, note.copy!, p.surface, 'The command')} />}
        <Button key="dismiss" plain dimColor label="×" onPress={() => update($, notice, () => null)} />
      </Box>
    )

    // A PR's second line: branch, size, review, checks, auto-merge, worktree,
    // its first agent and the count of the rest, each in its colour.
    const facts = (pr: PR, wt: string | undefined, as: Agent[] | undefined) => {
      const mark = checkMark(pr.checks)
      const parts: [string, string | undefined][] = [
        [cut(pr.head, 34), 'planMode'],
        [`+${pr.additions}`, 'success'],
        [`−${pr.deletions}`, 'error'],
      ]
      if (pr.mergeable === 'CONFLICTING') parts.push(['conflicts', 'error'])
      else if (pr.reviewDecision === 'CHANGES_REQUESTED') parts.push(['changes requested', 'error'])
      else if (pr.reviewDecision === 'APPROVED') parts.push(['approved', 'success'])
      if (mark) parts.push([`${mark} checks`, mark === '✓' ? 'success' : mark === '✗' ? 'error' : 'warning'])
      if (pr.autoMerge) parts.push(['auto-merge', 'suggestion'])
      if (wt) parts.push(['worktree', 'suggestion'])
      if (as?.length) parts.push([`${agentMark(as[0]!)} ${cut(as[0]!.name, 24)}${as.length > 1 ? ` +${as.length - 1}` : ''}`, 'subtle'])
      return (
        <Text wrap="truncate-end">
          {'    '}
          {parts.map(([t, c], i) => (
            <Text>
              {i > 1 ? <Text dimColor> · </Text> : i === 1 ? <Text dimColor> · </Text> : ''}
              <Text color={c}>{t}</Text>
            </Text>
          ))}
        </Text>
      )
    }

    draws++
    // ── A PR ──
    if (v.screen === 'pr' && blank) return <Text dimColor>Loading {v.key}…</Text>
    if (v.screen === 'pr') {
      const d = (await read($, details))[v.key]
      const pr = d ?? (await findPR($, v.key))
      const t = await read($, tab)
      const cameFrom = await read($, from)
      const crumb = cameFrom === 'linear' ? 'Linear' : t === 'mine' ? 'Mine' : t === 'review' ? 'Review requested' : (await read($, repoTab))?.split('/')[1] ?? 'Repo'
      const backPill = pill({ id: 'back', label: 'back', color: 'subtle', onPress: async () => ((await goBackFrom($)) ? undefined : back($, v.key)) })
      if (!pr) return <Box flexDirection="column">{backPill}<Text dimColor>Loading {v.key}…</Text></Box>
      const key = keyOf(pr)
      const wt = (await read($, worktrees))[key]
      const as = (await read($, agents))[key] ?? []
      const stateLook =
        pr.state === 'MERGED' ? { t: 'Merged', c: 'merged' } : pr.state === 'CLOSED' ? { t: 'Closed', c: 'error' } : pr.isDraft ? { t: 'Draft', c: 'subtle' } : { t: 'Open', c: 'success' }
      const field = (name: string, value: any) =>
        value ? (
          <Box flexDirection="row">
            <Box width={10} flexShrink={0}><Text dimColor>{name}</Text></Box>
            <Box flexShrink={1}>{typeof value === 'string' ? <Text wrap="wrap">{value}</Text> : value}</Box>
          </Box>
        ) : null
      const ticket = ticketKey(pr.head, pr.title, d?.body ?? '')
      const ready = d ? readiness(d) : null
      const passed = d?.checkList.filter(c => c.outcome === 'pass').length ?? 0
      const failing = d?.checkList.filter(c => c.outcome === 'fail') ?? []
      const pending = d?.checkList.filter(c => c.outcome === 'pending') ?? []
      const opts = d && v.menu === 'merge' ? await mergeOptions($, d) : null

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1}>
            {backPill}
            <Text dimColor>{crumb} ›</Text>
            <Text weight="bold">{key}</Text>
            {demo && <Text dimColor>· demo</Text>}
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text backgroundColor={stateLook.c} color="inverseText" weight="semibold">{` ${stateLook.t} `}</Text>
            <Text color="success">#{pr.number}</Text>
            <Text dimColor>· {pr.repo}</Text>
          </Box>
          <Text weight="bold" wrap="wrap">{pr.title}</Text>
          <Box flexDirection="column">
            {field('Author', <Text>{pr.author}<Text dimColor> · updated {age(pr.updatedAt, now)} ago</Text></Text>)}
            {field('Branch', (
              <Text>
                <Text color="planMode">{pr.head}</Text> <Text dimColor>→</Text> <Text color="planMode">{pr.base}</Text>
                {wt ? <Text color="suggestion">  ⌥ worktree</Text> : ''}
              </Text>
            ))}
            {as.length > 0 && field('Agents', (
              <Box flexDirection="column">
                {as.map(a => (
                  <Text key={`ag-${a.session}`}>
                    <Text color={agentColor(a)}>{agentMark(a)}</Text> {a.name}
                    <Text dimColor> · {a.status === 'gone' ? 'not running' : a.status} · {a.how === 'opened' ? 'opened it' : a.how === 'branch' ? 'on its branch' : a.how === 'cloud' ? 'started here' : 'worked on it'}</Text>
                  </Text>
                ))}
              </Box>
            ))}
            {field('Changes', <Text><Text color="success">+{pr.additions}</Text> <Text color="error">−{pr.deletions}</Text>{d ? <Text dimColor> · {plural(d.changedFiles, 'file')}</Text> : ''}</Text>)}
            {pr.labels.length > 0 && field('Labels', (
              <Text wrap="wrap">
                {pr.labels.map((l, n) => (
                  <Text key={`lb-${n}`}>{n ? '  ' : ''}<Text color={/^[0-9a-f]{6}$/i.test(l.color) ? `#${l.color}` : 'subtle'}>●</Text> {l.name}</Text>
                ))}
              </Text>
            ))}
            {d && (d.reviews.length > 0 || d.requested.length > 0) && field('Reviews', (
              <Text wrap="wrap">
                {d.reviews.map((r, n) => (
                  <Text key={`rv-${n}`}>
                    {n ? <Text dimColor> · </Text> : ''}
                    <Text color={r.state === 'APPROVED' ? 'success' : r.state === 'CHANGES_REQUESTED' ? 'error' : 'subtle'}>
                      {r.state === 'APPROVED' ? '✓' : r.state === 'CHANGES_REQUESTED' ? '✗' : '·'}
                    </Text> {r.author}
                  </Text>
                ))}
                {d.requested.map((r, n) => (
                  <Text key={`rq-${n}`}>{d.reviews.length + n ? <Text dimColor> · </Text> : ''}<Text dimColor>○</Text> {r}</Text>
                ))}
              </Text>
            ))}
            {d && d.checkList.length > 0 && field('Checks', (
              <Text>
                {failing.length ? <Text color="error">✗ {failing.length} failing  </Text> : ''}
                {pending.length ? <Text color="warning">● {pending.length} running  </Text> : ''}
                {passed ? <Text color="success">✓ {passed} passed</Text> : ''}
              </Text>
            ))}
            {ticket && field('Linear', (
              hasLinear
                ? <Button key="linear" plain hotkey="l" label={ticket} onPress={() => openLinear($, ticket)}><Text color="success" underline>{ticket}</Text></Button>
                : <Text color="success">{ticket}</Text>
            ))}
            {ready && field('Merge', <Text color={ready.color} wrap="wrap">{ready.text}</Text>)}
          </Box>
          {noticeRow}

          {/* The menus: merge, its confirmation, after a merge, the agents, a clone. */}
          {d && v.menu === 'merge' && (
            <Box flexDirection="column">
              <Text weight="bold">Merge #{d.number} into {d.base}</Text>
              {typeof opts === 'string' ? (
                <Text dimColor wrap="wrap">{opts}</Text>
              ) : (
                opts?.map((o, n) => (
                  <Button key={`opt-${o.key}`} plain hotkey={String(n + 1)} label={o.label} onPress={() => update($, view, (x): View => (x.screen === 'pr' ? { ...x, menu: 'confirm', pick: o.key } : x))} />
                ))
              )}
              <Button key="opt-cancel" plain dimColor label="cancel" onPress={() => update($, view, (x): View => (x.screen === 'pr' ? { ...x, menu: null, pick: null } : x))} />
            </Box>
          )}
          {d && v.menu === 'confirm' && v.pick && (
            <Box flexDirection="column">
              <Text weight="bold" wrap="wrap">{confirmText(d, v.pick)}</Text>
              <Box flexDirection="row" gap={2}>
                {pill({ id: 'yes', hotkey: '1', label: 'yes', color: 'success', onPress: () => doPick($, d, v.pick!) })}
                {pill({ id: 'no', hotkey: '2', label: 'no', color: 'subtle', onPress: () => update($, view, (x): View => (x.screen === 'pr' ? { ...x, menu: null, pick: null } : x)) })}
              </Box>
            </Box>
          )}
          {d && v.menu === 'after' && (
            <Box flexDirection="column">
              <Text weight="bold">#{d.number} is merged. Tidy up?</Text>
              {!d.settings.deleteBranchOnMerge && !d.isCrossRepository && d.headRefId && (
                <Button key="after-branch" plain hotkey="1" label={`Delete the branch ${d.head} on GitHub`} onPress={() => deleteBranch($, d)} />
              )}
              {wt && (
                <Button
                  key="after-worktree"
                  plain
                  hotkey="2"
                  label={`Remove the worktree ${cut(wt, 50)}`}
                  onPress={async () => {
                    if (demo) return say($, 'Demo: the worktree would be removed, unless it held changes.')
                    const root = await findCheckout($, d.repo)
                    const why = root ? await removeWorktree($, root, wt) : 'no checkout of the repo was found'
                    if (why) return say($, `The worktree stays: ${why}.`, { isError: true })
                    await update($, worktrees, all => Object.fromEntries(Object.entries(all).filter(([k]) => k !== key)))
                    await say($, 'The worktree is removed.')
                  }}
                />
              )}
              <Button key="after-done" plain label="done" onPress={() => update($, view, (x): View => (x.screen === 'pr' ? { ...x, menu: null } : x))} />
            </Box>
          )}
          {v.menu === 'agents' && (
            <Box flexDirection="column">
              <Text weight="bold">Its Claude Code sessions: a pick copies the command that takes you there, or opens a cloud one</Text>
              {as.length === 0 && <Text dimColor>None known: none on its branch, and no transcript of the last 30 days names it.</Text>}
              {as.map((a, n) => a.link ? (
                <Box key={`goto-${a.session}`} flexDirection="row" gap={1}>
                  <Text color={agentColor(a)}>{agentMark(a)}</Text>
                  <Link href={a.link} label={a.name} />
                </Box>
              ) : (
                <Button key={`goto-${a.session}`} plain hotkey={n < 9 ? String(n + 1) : undefined} label={a.name} onPress={p => copy($, agentCommand(a), p.surface, `The command for ${a.name}`)}>
                  <Text color={agentColor(a)}>{agentMark(a)}</Text> {a.name} <Text dimColor>· {agentCommand(a)}</Text>
                </Button>
              ))}
              <Button key="agents-cancel" plain dimColor label="cancel" onPress={() => update($, view, (x): View => (x.screen === 'pr' ? { ...x, menu: null } : x))} />
            </Box>
          )}
          {v.menu === 'clone' && (
            <Box flexDirection="column">
              <Text weight="bold" wrap="wrap">There's no checkout of {pr.repo} here. Clone it?</Text>
              <Button
                key="clone-yes"
                plain
                hotkey="1"
                label={`gh repo clone ${pr.repo}`}
                onPress={async () => {
                  await update($, view, (x): View => (x.screen === 'pr' ? { ...x, menu: null } : x))
                  await say($, `Cloning ${pr.repo} into ${await clonePath($, pr.repo)}…`)
                  try {
                    await clone($, pr.repo)
                    await worktree($, pr)
                  } catch (err) {
                    await say($, `Couldn't clone it: ${message(err)}`, { isError: true })
                  }
                }}
              />
              <Button key="clone-no" plain dimColor label="cancel" onPress={() => update($, view, (x): View => (x.screen === 'pr' ? { ...x, menu: null } : x))} />
            </Box>
          )}

          {!v.menu && (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {pill({ id: 'agents', hotkey: 'a', label: 'agents', color: 'success', onPress: () => update($, view, (x): View => (x.screen === 'pr' ? { ...x, menu: 'agents' } : x)) })}
              {pill({ id: 'worktree', hotkey: 'w', label: 'worktree', color: 'claude', onPress: () => worktree($, pr) })}
              {pill({ id: 'start', hotkey: 's', label: 'start in cloud', color: 'claude', onPress: () => start($, pr) })}
              {d && pill({ id: 'draft', hotkey: 'd', label: d.isDraft ? 'ready' : 'draft', color: 'claude', onPress: () => flipDraft($, d) })}
              {d && pill({ id: 'merge', hotkey: 'm', label: 'merge', color: 'claude', onPress: () => update($, view, (x): View => (x.screen === 'pr' ? { ...x, menu: 'merge' } : x)) })}
              {pill({ id: 'copy-url', hotkey: 'y', label: 'copy url', color: 'suggestion', onPress: p => copy($, pr.url, p.surface, 'The link') })}
              {pill({ id: 'copy-branch', hotkey: 'b', label: 'copy branch', color: 'suggestion', onPress: p => copy($, localBranch(pr), p.surface, 'The branch') })}
              {pill({ id: 'reload', hotkey: 'r', label: 'reload', color: 'suggestion', onPress: () => reloadPR($, key) })}
              <Link href={pr.url} label="open on GitHub" />
            </Box>
          )}

          {d && (failing.length > 0 || pending.length > 0) && (
            <Box flexDirection="column">
              <Text color="suggestion" weight="semibold">Checks</Text>
              {[...failing, ...pending].map((c, n) => (
                <Text key={`ck-${n}`} wrap="truncate-end">
                  <Text color={c.outcome === 'fail' ? 'error' : 'warning'}>{c.outcome === 'fail' ? '✗' : '●'}</Text> {c.name}
                  {c.isRequired ? <Text dimColor> · required</Text> : ''}
                </Text>
              ))}
            </Box>
          )}
          {d && (
            <Box flexDirection="column">
              <Text color="suggestion" weight="semibold">Description</Text>
              {d.body.trim() ? <Markdown key={`md-${key}`} text={d.body} /> : <Text dimColor>No description.</Text>}
            </Box>
          )}
          {d && d.threads.length > 0 && (
            <Box flexDirection="column" gap={1}>
              <Text color="suggestion" weight="semibold">Unresolved threads {d.threads.length}</Text>
              {d.threads.map((th, n) => (
                <Box key={`th-${n}`} flexDirection="column">
                  <Text color="planMode">{th.path}{th.line ? `:${th.line}` : ''}{th.isOutdated ? <Text dimColor> · outdated</Text> : ''}</Text>
                  {th.comments.map((c, m) => (
                    <Text key={`thc-${n}-${m}`} wrap="wrap"><Text weight="semibold">{c.author}</Text> {c.body}</Text>
                  ))}
                </Box>
              ))}
            </Box>
          )}
          {d && d.conversation.length > 0 && (
            <Box flexDirection="column" gap={1}>
              <Text color="suggestion" weight="semibold">Conversation</Text>
              {d.conversation.map((c, n) => (
                <Box key={`cv-${n}`} flexDirection="column">
                  <Text><Text weight="semibold">{c.author}</Text><Text dimColor> · {age(c.createdAt, now)} ago{c.state ? ` · ${c.state.toLowerCase().replace(/_/g, ' ')}` : ''}</Text></Text>
                  <Markdown key={`cvm-${n}`} text={c.body} />
                </Box>
              ))}
            </Box>
          )}
          {!d && <Text dimColor>Loading…</Text>}
        </Box>
      )
    }

    // ── The repo picker ──
    // Drawn as the PR list is: around the repo the keyboard is on, as many
    // lines as fit, so ↓ walks on past the bottom of the pane.
    if (v.screen === 'repos') {
      const f = await read($, filter)
      const all = await read($, repos)
      const { own, recent, ordered, typed } = await repoChoices($)
      const pick = async (r: string) => {
        await update($, repoTab, () => r)
        if (!demo) await $.store.set('recent-repos', [r, ...recent.filter(x => x !== r)].slice(0, 8))
        await update($, filter, () => '')
        await update($, view, (): View => ({ screen: 'list' }))
        await switchTab($, 'repo')
        void load($, 'repo')
        await focusOn($, 'filter')
      }
      type Line = { kind: 'org'; org: string } | { kind: 'repo'; repo: string }
      const lines: Line[] = []
      for (const r of ordered) {
        const o = r.split('/')[0]!
        if (!lines.some(l => l.kind === 'org' && l.org === o)) lines.push({ kind: 'org', org: o })
        lines.push({ kind: 'repo', repo: r })
      }
      const sel = Math.max(0, Math.min(await read($, selected), ordered.length - 1))
      const fits = Math.max(6, (e.props.scroll?.bodyRows ?? 24) - 10 - (note ? 2 : 0) - (typed ? 1 : 0))
      const at = Math.max(0, lines.findIndex(l => l.kind === 'repo' && l.repo === ordered[sel]))
      let startAt = Math.max(0, at - Math.floor(fits / 2))
      const endAt = Math.min(lines.length, startAt + fits)
      startAt = Math.max(0, endAt - fits)
      const shown = lines.slice(startAt, endAt)
      // The org a window starts inside of, named over it.
      const lead = shown[0]?.kind === 'repo' ? [...lines.slice(0, startAt)].reverse().find(l => l.kind === 'org') : undefined
      const above = lines.slice(0, startAt).filter(l => l.kind === 'repo').length
      const below = lines.slice(endAt).filter(l => l.kind === 'repo').length
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1}>
            {pill({ id: 'back', label: 'back', color: 'subtle', onPress: () => back($, null) })}
            <Text weight="bold">Pick the repo tab's repo</Text>
          </Box>
          {Input && (
            <Input
              key="repo-filter"
              autoFocus
              submitLabel="open"
              placeholder="Type an org, a repo, or owner/repo · ↓ to the list"
              value={f}
              onInput={async text => {
                await update($, filter, () => text)
                await update($, selected, () => 0)
              }}
              onSubmit={() => (typed ? pick(typed) : ordered[0] ? pick(ordered[0]) : undefined)}
            />
          )}
          {noticeRow}
          {typed && <Button key="repo-typed" plain label={`Use ${typed}`} onPress={() => pick(typed)}><Text>{`Use ${typed}`.padEnd(Math.max(10, width - 1))}</Text></Button>}
          {all.length === 0 && <Text dimColor>Listing your repos…</Text>}
          <Box flexDirection="column">
            <Text dimColor>{above ? `↑ ${above} more` : ' '}</Text>
            {[...(lead ? [lead] : []), ...shown].map(l =>
              l.kind === 'org' ? (
                <Text color="suggestion" weight="semibold">{l.org}</Text>
              ) : (
                <Button key={`repo-${l.repo}`} plain label={l.repo} onPress={() => pick(l.repo)}>
                  <Text>{`${l.repo === own ? '★ ' : '  '}${l.repo}`.padEnd(Math.max(10, width - 1))}</Text>
                </Button>
              ),
            )}
            <Text dimColor>{below ? `↓ ${below} more` : ' '}</Text>
          </Box>
        </Box>
      )
    }

    // ── The lists ──
    const t = await read($, tab)
    const repo = await read($, repoTab)
    const lists = await read($, loaded)
    const mine = lists[tabKey(t, repo)]
    const f = await read($, filter)
    const groups = grouped(mine?.prs ?? [], f, t === 'review')
    const prs = [...groups.values()].flat()
    const wts = await read($, worktrees)
    const ags = await read($, agents)
    const sel = Math.max(0, Math.min(await read($, selected), prs.length - 1))
    const picked = prs[sel]
    // The list's lines: a heading and a blank per group, each PR two lines
    // and a blank. Drawn around the keyboard's PR, as many as fit.
    type Item = { kind: 'head'; g: Group; n: number } | { kind: 'pr'; pr: PR }
    const items: Item[] = []
    for (const [g, list] of groups) {
      items.push({ kind: 'head', g, n: list.length })
      for (const pr of list) items.push({ kind: 'pr', pr })
    }
    const height = (it: Item) => (it.kind === 'head' ? 2 : 3)
    room = Math.max(6, (e.props.scroll?.bodyRows ?? 24) - 12 - (note ? 2 : 0) - (mine?.error ? 2 : 0))
    const at = picked ? items.findIndex(it => it.kind === 'pr' && it.pr === picked) : 0
    let startAt = at
    let used = height(items[at] ?? { kind: 'head', g: 'waiting', n: 0 })
    while (startAt > 0 && used + height(items[startAt - 1]!) <= room / 2) used += height(items[--startAt]!)
    let endAt = at + 1
    while (endAt < items.length && used + height(items[endAt]!) <= room) used += height(items[endAt++]!)
    while (startAt > 0 && used + height(items[startAt - 1]!) <= room) used += height(items[--startAt]!)
    const shown = items.slice(startAt, endAt)
    const lead = shown[0]?.kind === 'pr' ? [...items.slice(0, startAt)].reverse().find(it => it.kind === 'head') : undefined
    const above = items.slice(0, startAt).filter(it => it.kind === 'pr').length
    const below = items.slice(endAt).filter(it => it.kind === 'pr').length
    const count = (k: Tab) => {
      const l = lists[tabKey(k, repo)]
      return l ? `${l.prs.length}${l.isLoading && l.prs.length >= 20 ? '+' : ''}` : ''
    }
    const tabName = (k: Tab) => (k === 'mine' ? 'Mine' : k === 'review' ? 'Review requested' : repo ? repo.split('/')[1]! : 'This repo')
    const isArmed = await read($, armed)
    const nextTab = t === 'repo' && !isArmed ? '⇄ change repo' : tabName(TABS[(TABS.indexOf(t) + 1) % TABS.length]!)
    const hint = isArmed ? `Enter picks another repo · ↑ ${nextTab}` : width >= 70 ? `Type to filter · ↓ the list · ↑ ${nextTab}` : `Filter… · ↓ list · ↑ ${nextTab}`

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {TABS.map(k => {
            const isOn = k === t
            return (
              <Button key={`tab-${k}`} plain onPress={async () => {
                await switchTab($, k)
                await focusOn($, 'filter')
              }}>
                <Text inverse={isOn || undefined} weight={isOn ? 'semibold' : undefined} color={isOn ? 'suggestion' : undefined}>{` ${tabName(k)} `}</Text>
                <Text dimColor>{count(k)} </Text>
              </Button>
            )
          })}
          <Button key="tab-change" plain label="change repo" onPress={() => openPicker($)}>
            <Text inverse={isArmed || undefined} color="suggestion" weight={isArmed ? 'semibold' : undefined}>{isArmed ? ' ⇄ change repo ' : '⇄'}</Text>
          </Button>
          <Text dimColor>{mine?.isLoading ? ' updating…' : ''}{demo ? ' · demo' : ''}</Text>
        </Box>
        {Input && (
          <Input
            key="filter"
            autoFocus
            submitLabel="open"
            placeholder={hint}
            value={f}
            onInput={async text => {
              await update($, armed, () => false)
              await update($, filter, () => text)
              await update($, selected, () => 0)
            }}
            onSubmit={() => (isArmed ? openPicker($) : prs[0] ? openPR($, keyOf(prs[0])) : undefined)}
          />
        )}
        {noticeRow}
        {mine?.error && <Text color="error" wrap="wrap">{mine.error}</Text>}
        {!mine?.isLoading && prs.length === 0 && !mine?.error && (
          // A row of the pane's width even with nothing to list: with no element
          // under the filter, ↓ would wrap round to the tabs, and switch them.
          <Button key="empty" plain label="nothing here" onPress={() => (f ? update($, filter, () => '') : load($, t))}>
            <Text dimColor>{(f ? 'No pull request matches.' : t === 'mine' ? 'No open pull requests of yours.' : t === 'review' ? 'Nothing waiting on your review.' : repo ? 'No open pull requests here.' : "This session isn't in a GitHub repository: pick one with ⇄ above.").padEnd(Math.max(10, width - 1))}</Text>
          </Button>
        )}
        {items.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>{above ? `↑ ${above} more` : ' '}</Text>
            {[...(lead ? [lead] : []), ...shown].map(it => {
              if (it.kind === 'head') {
                const g = GROUPS.find(x => x.id === it.g)!
                return (
                  <Box flexDirection="column">
                    <Text><Text color={g.color} weight="semibold">{g.label}</Text> <Text dimColor>{it.n}</Text></Text>
                    <Text> </Text>
                  </Box>
                )
              }
              const pr = it.pr
              const key = keyOf(pr)
              const meta = [t === 'mine' ? null : pr.author, t === 'repo' ? null : pr.repo.split('/')[1], age(pr.updatedAt, now)].filter(Boolean).join(' · ')
              const titleRoom = Math.max(12, width - String(pr.number).length - meta.length - 9)
              // Padded to the pane's width, meta at the right: the arrows move to
              // an element under the one they leave, and a row as wide as the
              // filter is always under it.
              const shownTitle = cut(pr.title, titleRoom)
              const gap = Math.max(2, width - 1 - (4 + String(pr.number).length + shownTitle.length + meta.length))
              return (
                <Box flexDirection="column">
                  <Button key={`pr-${key}`} plain label={`#${pr.number} ${pr.title}`} onPress={() => openPR($, key)}>
                    <Text color={pr.isDraft ? 'subtle' : 'success'}>{pr.isDraft ? '◌' : '●'}</Text>
                    <Text color="success"> #{pr.number}</Text>
                    <Text> {shownTitle}</Text>
                    <Text dimColor>{' '.repeat(gap)}{meta}</Text>
                  </Button>
                  {facts(pr, wts[key], ags[key])}
                  <Text> </Text>
                </Box>
              )
            })}
            <Text dimColor>{below ? `↓ ${below} more` : ' '}</Text>
          </Box>
        )}
        {picked && (
          <Text wrap="truncate-end">
            {picked.labels.map((l, n) => (
              <Text key={`fl-${n}`}><Text color={/^[0-9a-f]{6}$/i.test(l.color) ? `#${l.color}` : 'subtle'}>●</Text> {l.name}  </Text>
            ))}
            <Text dimColor>into </Text><Text color="planMode">{picked.base}</Text>
          </Text>
        )}
      </Box>
    )
  })
}

// An agent's mark and colour, by its state: working, waiting, done, gone.
function agentMark(a: Agent): string {
  if (a.how === 'cloud') return '☁'
  if (a.status === 'gone') return '○'
  if (a.status === 'busy' || a.status === 'running') return '◔'
  if (a.status === 'waiting') return '◉'
  return '✓'
}

function agentColor(a: Agent): string {
  if (a.how === 'cloud') return 'claude'
  if (a.status === 'gone') return 'subtle'
  if (a.status === 'busy' || a.status === 'running') return 'warning'
  if (a.status === 'waiting') return 'error'
  return 'success'
}
