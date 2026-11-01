import { expect, test } from 'claude-code/testing'

import { goTo } from '../hooks/local'
import { ticketKey, titleArgs } from '../hooks/register'

const PANE = {
  plugin: 'github',
  component: 'Pane',
  requestId: 'github',
  props: {
    title: 'GitHub',
    isFocused: true,
    bodyColumns: 110,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

// The keys of the list's PR rows drawn, in order.
async function rows(ui: any): Promise<string[]> {
  return ((await ui.findAll({ type: 'Button' })) as any[]).map(b => String(b.key)).filter(k => k.startsWith('pr-'))
}

async function settle() {
  for (let n = 0; n < 400; n++) await Promise.resolve()
}

function engine(on: any, opts: { commands?: string[]; store?: Map<string, unknown>; draft?: string; unplaced?: string } = {}) {
  const store = opts.store ?? new Map<string, unknown>()
  const ran: { command: string; args: string }[] = []
  const filled: string[] = []
  on('prompt.read', () => ({ value: { text: opts.draft ?? '', cursor: 0 } as any }))
  on('prompt.fill', (_: unknown, e: any) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length } as any
  })
  on('command.register', () => ({ value: { command: 'github' } }))
  // The clock: no waiting in a test.
  on('clock.sleep', () => ({ value: undefined }))
  on('command.list', () => ({ value: (opts.commands ?? []).map(name => ({ name, description: '' })) }))
  const opened: { id: string; title?: string }[] = []
  on('ui.open', (_: unknown, e: any) => {
    opened.push({ id: e.id, title: e.title })
    return { value: e.id === opts.unplaced ? { isPlaced: false, reason: 'narrow' } : { isPlaced: true } } as any
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.repo', () => ({ value: { root: '/repo', remote: 'git@github.com:halcyon/notes-app.git' } as any }))
  on('store.get', (_: unknown, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  return { store, ran, filled, opened }
}

test('a ticket key from a branch or a title, not a phase or a version', () => {
  expect(ticketKey('sam/hal-212-offline-conflicts')).toBe('HAL-212')
  expect(ticketKey('phase-2-cleanup', 'Fix the thing')).toBe(null)
  expect(ticketKey('main', 'v-2 release, ENG-77 follow-up')).toBe('ENG-77')
})

test('/github demo: grouped by whose move it is, with no gh, git or session', async ($, on) => {
  engine(on)
  const ran: string[][] = []
  on('process.run', (_: unknown, e: any) => {
    ran.push([...e.argv])
    return { value: { exitCode: 1, stdout: '', stderr: 'no' } as any }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await ($.command.run as any)({ command: 'github', args: 'demo' })
  await settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Ready to merge' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Needs fixing' })).toBeDefined()
  const mine = await rows(ui)
  expect(mine).toContain('pr-halcyon/notes-app#482')
  expect(mine).toContain('pr-halcyon/notes-app#479')
  // As herdr-github: Needs fixing before Ready to merge.
  expect(mine.indexOf('pr-halcyon/notes-app#479')).toBeLessThan(mine.indexOf('pr-halcyon/notes-app#482'))
  // The second line: the branch, the size, checks, the worktree and the agents.
  expect(await ui.find({ type: 'Text', text: 'sam/hal-212-offline-conflicts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✗ checks' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Offline sync conflicts \+1/ })).toBeDefined()

  // The filter: every word.
  await ui.input({ key: 'filter', text: 'search accents', kind: 'change' })
  await settle()
  expect(await rows(ui)).toEqual(['pr-halcyon/notes-app#479'])
  await ui.unmount()
  expect(ran).toEqual([])
})

test('a PR, then merging it: the method, the question, then tidying up', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await ($.command.run as any)({ command: 'github', args: 'demo' })
  await settle()

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'pr-halcyon/notes-app#482' })
  await settle()
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Offline edits survive a sync conflict' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '● open' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✓ 4 passed/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /three-way merge/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'HAL-212' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Review the three-way merge' })).toBeDefined()

  await ui.press({ key: 'merge' })
  await settle()
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const opts = ((await ui.findAll({ type: 'Button' })) as any[]).map(b => String(b.key)).filter(k => k.startsWith('opt-merge:'))
  expect(opts.length).toBeGreaterThan(0)
  await ui.press({ key: opts[0]! })
  await settle()
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /#482 into main now\?$/ })).toBeDefined()
  await ui.press({ key: 'yes' })
  await settle()
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '#482 is merged into main.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '⇄ merged' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'after-worktree' })).toBeDefined()
  await ui.unmount()
})

test('↑ from the filter switches the tab, the cursor staying in the filter', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await ($.command.run as any)({ command: 'github', args: 'demo' })
  await settle()
  const r = await $.ui.focus({ requestId: 'github', key: 'tab-mine' } as any)
  expect((r as any).deny).toContain('cursor stays in the filter')
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const review = await rows(ui)
  expect(review.length).toBeGreaterThan(0)
  expect(review).not.toContain('pr-halcyon/notes-app#482')
  await ui.unmount()
})

test('through gh: the search sent typed, the rows from what it answers', async ($, on) => {
  const { store } = engine(on)
  const ran: string[][] = []
  const node = (n: number, title: string, extra: object = {}) => ({
    id: `PR_${n}`, number: n, title, url: `https://github.com/halcyon/notes-app/pull/${n}`, isDraft: false, state: 'OPEN',
    updatedAt: '2026-10-31T10:00:00Z', author: { login: 'sam' }, repository: { nameWithOwner: 'halcyon/notes-app' },
    headRefName: `sam/x-${n}`, baseRefName: 'main', isCrossRepository: false, headRepositoryOwner: { login: 'halcyon' },
    reviewDecision: null, mergeable: 'MERGEABLE', additions: 1, deletions: 2,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, labels: { nodes: [] }, autoMergeRequest: null,
    ...extra,
  })
  on('process.run', (_: unknown, e: any) => {
    ran.push([...e.argv])
    if (e.argv[0] === 'gh') {
      const nodes = [node(901, 'Real one', { reviewDecision: 'APPROVED' })]
      return { value: { exitCode: 0, stdout: JSON.stringify({ data: { search: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } }), stderr: '' } as any }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } as any }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await ($.command.run as any)({ command: 'github', args: '' })
  await settle()
  const gh = ran.filter(a => a[0] === 'gh')
  expect(gh.length).toBeGreaterThan(0)
  expect(gh[0]!.slice(0, 3)).toEqual(['gh', 'api', 'graphql'])
  expect(gh[0]).toContain('first=20')
  expect(gh[0]![gh[0]!.indexOf('first=20') - 1]).toBe('-F')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rows(ui)).toContain('pr-halcyon/notes-app#901')
  await ui.unmount()
  expect(Array.isArray(store.get('prs:mine'))).toBe(true)
})

test('with the Linear mod: the PR names its issue; a press opens the Linear pane on it, as the press', async ($, on) => {
  const { opened, filled } = engine(on, { commands: ['github', 'linear'] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await ($.command.run as any)({ command: 'github', args: 'demo pr halcyon/notes-app#479' })
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'linear' })).toBeDefined()
  await ui.press({ key: 'linear' })
  await settle()
  expect(opened.at(-1)).toEqual({ id: 'linear', title: 'Linear ⟨demo issue HAL-231 from:github⟩' })
  expect(filled).toEqual([])
  await ui.unmount()
})

test('the Linear pane not drawn: its command goes in the prompt, for Enter; a draft is kept', async ($, on) => {
  const { filled } = engine(on, { commands: ['github', 'linear'], unplaced: 'linear' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await ($.command.run as any)({ command: 'github', args: 'demo pr halcyon/notes-app#479' })
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'linear' })
  await settle()
  expect(filled).toEqual(['/linear demo issue HAL-231 from:github'])
  await ui.unmount()
})

test('opened by the Linear mod: its arguments are read from the title', () => {
  expect(titleArgs('GitHub ⟨demo pr halcyon/notes-app#482 from:linear⟩')).toBe('demo pr halcyon/notes-app#482 from:linear')
  expect(titleArgs('GitHub')).toBe(null)
  expect(titleArgs(undefined)).toBe(null)
})

test('the pane draws on every surface', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await ($.command.run as any)({ command: 'github', args: 'demo' })
  await settle()
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await rows(ui)).toContain('pr-halcyon/notes-app#482')
    await ui.unmount()
  }
})

test('opened from the Linear mod: its crumb, and back opens the Linear pane as it was', async ($, on) => {
  const { opened } = engine(on, { commands: ['github', 'linear'] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await ($.command.run as any)({ command: 'github', args: 'demo pr halcyon/notes-app#482 from:linear' })
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Linear ›' })).toBeDefined()
  await ui.press({ key: 'back' })
  await settle()
  expect(opened.at(-1)).toEqual({ id: 'linear', title: 'Linear ⟨back⟩' })
  await ui.unmount()
})

test('the repo picker is drawn around the keyboard\'s repo, so ↓ walks past the bottom', async ($, on) => {
  const many = Array.from({ length: 60 }, (_, n) => `halcyon/repo-${String(n).padStart(2, '0')}`)
  engine(on, { store: new Map<string, unknown>([['recent-repos', many]]) })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } as any }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await ($.command.run as any)({ command: 'github', args: '' })
  await settle()
  await $.ui.focus({ requestId: 'github', key: 'tab-mine' } as any)
  await $.ui.focus({ requestId: 'github', key: 'tab-review' } as any)
  await settle()
  const short = { ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 24 } } }
  let ui = await $.ui.mount({ ...short, surface: 'terminal' })
  await ui.press({ key: 'tab-change' })
  await settle()
  await ui.unmount()
  const repoRows = async (u: any) => ((await u.findAll({ type: 'Button' })) as any[]).map(b => String(b.key)).filter(k => k.startsWith('repo-'))
  ui = await $.ui.mount({ ...short, surface: 'terminal' })
  expect(await repoRows(ui)).not.toContain('repo-halcyon/repo-40')
  expect(await ui.find({ type: 'Text', text: /↓ \d+ more/ })).toBeDefined()
  await ui.unmount()

  await $.ui.focus({ requestId: 'github', key: 'repo-halcyon/repo-40' } as any)
  await settle()
  ui = await $.ui.mount({ ...short, surface: 'terminal' })
  expect(await repoRows(ui)).toContain('repo-halcyon/repo-40')
  expect(await repoRows(ui)).toContain('repo-halcyon/repo-42')
  expect(await ui.find({ type: 'Text', text: /↑ \d+ more/ })).toBeDefined()
  // The org named over a window that starts inside it.
  expect(await ui.find({ type: 'Text', text: 'halcyon' })).toBeDefined()
  await ui.unmount()
})

test('↑ from the filter stops on the ⇄ after the repo tab: Enter there picks a repo', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await ($.command.run as any)({ command: 'github', args: 'demo' })
  await settle()
  for (const k of ['tab-mine', 'tab-review', 'tab-repo']) await $.ui.focus({ requestId: 'github', key: k } as any)
  await settle()
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // On the repo tab, its ⇄ armed: the hint says what Enter does.
  expect(await ui.find({ type: 'Text', text: ' ⇄ change repo ' })).toBeDefined()
  expect(await rows(ui)).toContain('pr-halcyon/notes-app#482')
  await ui.input({ key: 'filter', text: '', kind: 'submit' })
  await settle()
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: "Pick the repo tab's repo" })).toBeDefined()
  await ui.unmount()
})

test('Start: a cloud session on the PR, from a checkout of its repo, kept among its agents', async ($, on) => {
  const { store } = engine(on)
  const ran: string[][] = []
  const pr = {
    id: 'PR_9', number: 9, title: 'Tidy the sync queue', url: 'https://github.com/halcyon/notes-app/pull/9', isDraft: false, state: 'OPEN',
    updatedAt: '2026-10-31T10:00:00Z', author: { login: 'sam' }, repository: { nameWithOwner: 'halcyon/notes-app' },
    headRefName: 'sam/tidy-queue', baseRefName: 'main', isCrossRepository: false, headRepositoryOwner: { login: 'halcyon' },
    reviewDecision: null, mergeable: 'MERGEABLE', additions: 1, deletions: 2,
    commits: { nodes: [] }, labels: { nodes: [] }, autoMergeRequest: null,
  }
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = [...e.argv]
    ran.push(argv)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } as any })
    if (argv[0] === 'gh') return ok(JSON.stringify({ data: { repository: { pullRequest: pr }, node: null } }))
    if (argv.includes('rev-parse')) return ok('/repo/.git\n')
    if (argv.includes('remote')) return ok('origin\tgit@github.com:halcyon/notes-app.git (fetch)\n')
    if (argv[0] === 'uname') return ok('Linux\n')
    if (argv[0] === 'script') return ok('Created cloud session: Tidy\nView: https://claude.ai/code/session_01XYZ?from=cli\n')
    if (argv[0] === 'claude') return ok('[]')
    return ok('')
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await ($.command.run as any)({ command: 'github', args: 'pr halcyon/notes-app#9' })
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'start' })
  await settle()
  const script = ran.find(a => a[0] === 'script')!
  expect(script[2]).toContain("'claude' '--cloud' 'Work on pull request https://github.com/halcyon/notes-app/pull/9")
  expect(script[2]).toContain('gh pr checkout 9')
  expect(await ui.find({ type: 'Text', text: '#9 is running in the cloud.' })).toBeDefined()
  expect((store.get('cloud:halcyon/notes-app#9') as any[])[0].link).toBe('https://claude.ai/code/session_01XYZ')
  // Nothing local: no worktree made, no background session.
  expect(ran.some(a => a.includes('worktree') && a.includes('add'))).toBe(false)
  expect(ran.some(a => a.includes('--bg'))).toBe(false)
  await ui.unmount()
})


test('a merge queue: ready, it joins the queue (pinned to the commit shown); in, it can be taken out', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await ($.command.run as any)({ command: 'github', args: 'demo pr halcyon/sync-server#121' })
  await settle()
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Ready to merge: through the merge queue' })).toBeDefined()
  await ui.press({ key: 'merge' })
  await settle()
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // No methods to choose: the queue merges it its own way.
  const opts = ((await ui.findAll({ type: 'Button' })) as any[]).map(b => String(b.key)).filter(k => k.startsWith('opt-'))
  expect(opts).toEqual(['opt-queue', 'opt-cancel'])
  await ui.press({ key: 'opt-queue' })
  await settle()
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /merge queue for main\? It merges when its turn comes\.$/ })).toBeDefined()
  await ui.press({ key: 'yes' })
  await settle()
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '#121 is in the merge queue, 1st in line.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^In the merge queue, 1st in line: its checks are running · about 9 min$/ })).toBeDefined()
  await ui.press({ key: 'merge' })
  await settle()
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'opt-dequeue' })).toBeDefined()
  await ui.unmount()
})

test('to a PR\'s session: its herdr pane if running there, else a new herdr tab resuming it, else tmux, else nothing', async () => {
  const agent = { session: 'sess-1', name: 'Offline sync conflicts', how: 'opened' as const, status: 'gone', cwd: '/code/notes-app', bg: null }
  let env = '/run/herdr.sock|'
  let live = true
  const ran: string[][] = []
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
  // Only what goTo uses: processes.
  const $ = {
    process: {
      run: async (argv: string[]) => {
        ran.push([...argv])
        if (argv[0] === 'sh') return ok(env)
        if (argv.join(' ') === 'herdr agent list') return ok(JSON.stringify({ result: { agents: live ? [{ pane_id: 'wA:p1', agent_session: { value: 'sess-1' } }] : [] } }))
        if (argv[1] === 'tab') return ok(JSON.stringify({ result: { root_pane: { pane_id: 'wB:p1' } } }))
        return ok('')
      },
    },
  } as any
  expect(await goTo($, agent)).toBe('Switched to Offline sync conflicts, in its herdr pane.')
  expect(ran.at(-1)).toEqual(['herdr', 'agent', 'focus', 'wA:p1'])

  live = false
  expect(await goTo($, agent)).toBe('Offline sync conflicts is open again, in a new herdr tab.')
  expect(ran.find(a => a[1] === 'tab')).toEqual(['herdr', 'tab', 'create', '--cwd', '/code/notes-app', '--label', 'Offline sync conflicts', '--focus'])
  expect(ran.at(-1)).toEqual(['herdr', 'pane', 'run', 'wB:p1', 'claude --resume sess-1'])

  env = '|/tmp/tmux-1/default,1,0'
  expect(await goTo($, { ...agent, bg: 'ab12cd34' })).toBe('Offline sync conflicts is open again, in a new tmux window.')
  expect(ran.at(-1)).toEqual(['tmux', 'new-window', '-c', '/code/notes-app', '-n', 'Offline sync conflicts', 'claude attach ab12cd34'])

  env = '|'
  expect(await goTo($, agent)).toBe(null)
})
