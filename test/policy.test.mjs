import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinTools, checkToolUse, decideTool, fetchTargetProblem, fileRoots } from '../bridge/policy.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'jarvis-ws-'))
const roots = fileRoots({ workspace })
const ctx = (allowWrites = false) => ({ allowWrites, cwd: workspace, roots })
const allowed = (name, input, w) => checkToolUse(name, input, ctx(w)).allow

test('decideTool keeps its existing verdicts', () => {
  assert.equal(decideTool('Read'), true)
  assert.equal(decideTool('Bash'), false)
  assert.equal(decideTool('Bash', true), true)
  assert.equal(decideTool('mcp__jarvis__display'), true)
  assert.equal(decideTool('mcp__jarvis_lists__todo_add'), true)
  assert.equal(decideTool('mcp__someserver__list_devices'), true)
  assert.equal(decideTool('mcp__someserver__install_apk'), false)
  assert.equal(decideTool('mcp__higgsfield__generate_image'), true)
  assert.equal(decideTool('mcp__elevenlabs__make_outbound_call'), false)
  assert.equal(decideTool('SomeFutureBuiltin'), false)
  // JARVIS_WRITE_SERVERS opens one service for changes and nothing else.
  assert.equal(decideTool('mcp__claude_ai_Asana__create_tasks', false, ['asana']), true)
  assert.equal(decideTool('mcp__claude_ai_Asana__delete_task', false, ['asana']), true)
  assert.equal(decideTool('mcp__claude_ai_Asana__delete_task'), false)
  assert.equal(decideTool('mcp__claude_ai_Microsoft_365__outlook_send_mail', false, ['asana']), false)
  assert.equal(decideTool('Bash', false, ['asana']), false)
  assert.equal(decideTool('Write', false, ['asana']), false)
  // Connector tools that lead with the product name, not the verb.
  assert.equal(decideTool('mcp__claude_ai_Microsoft_365__outlook_calendar_search'), true)
  assert.equal(decideTool('mcp__claude_ai_Microsoft_365__outlook_email_search'), true)
  assert.equal(decideTool('mcp__claude_ai_Microsoft_365__teams_list_chats'), true)
  assert.equal(decideTool('mcp__claude_ai_Microsoft_365__chat_message_search'), true)
  // ...and the ones beside them that change things stay behind writes.
  assert.equal(decideTool('mcp__claude_ai_Microsoft_365__outlook_send_mail'), false)
  assert.equal(decideTool('mcp__claude_ai_Microsoft_365__outlook_forward_mail'), false)
  assert.equal(decideTool('mcp__claude_ai_Microsoft_365__outlook_respond_to_event'), false)
  assert.equal(decideTool('mcp__claude_ai_Microsoft_365__outlook_trash_thread'), false)
  assert.equal(decideTool('mcp__claude_ai_Microsoft_365__outlook_set_vacation'), false)
  assert.equal(decideTool('mcp__claude_ai_Microsoft_365__outlook_batch_modify_labels'), false)
  assert.equal(decideTool('mcp__claude_ai_Microsoft_365__sharepoint_move_item'), false)
  assert.equal(decideTool('mcp__claude_ai_Microsoft_365__teams_send_chat_message'), false)
})

test('read-only mode refuses a shell command the CLI would auto-approve', () => {
  // `cat` is what the CLI's own classifier runs without asking canUseTool.
  assert.equal(allowed('Bash', { command: 'cat ~/.ssh/id_rsa' }), false)
  assert.equal(allowed('Bash', { command: 'ls' }), false)
  assert.equal(allowed('Bash', { command: 'ls' }, true), true)
})

test('file tools are confined to the workspace and temp roots', () => {
  writeFileSync(join(workspace, 'note.txt'), 'hi')
  assert.equal(allowed('Read', { file_path: join(workspace, 'note.txt') }), true)
  assert.equal(allowed('Read', { file_path: 'note.txt' }), true) // relative to cwd
  assert.equal(allowed('Read', { file_path: join(tmpdir(), 'shot.png') }), true)
  assert.equal(allowed('Read', { file_path: join(homedir(), '.bashrc') }), false)
  assert.equal(allowed('Read', { file_path: '~/.claude/.credentials.json' }), false)
  assert.equal(allowed('Read', { file_path: '/etc/passwd' }), false)
  assert.equal(allowed('Read', { file_path: join(workspace, '..', '..', 'etc', 'passwd') }), false)
  assert.equal(allowed('Grep', { pattern: 'x', path: '/home' }), false)
  assert.equal(allowed('Glob', { pattern: '**/*' }), true) // no path = cwd
})

test('a symlink inside the workspace cannot point the read elsewhere', () => {
  const link = join(workspace, 'innocent.png')
  try {
    symlinkSync('/etc/hosts', link)
  } catch {
    return // no symlinks on this filesystem
  }
  assert.equal(allowed('Read', { file_path: link }), false)
})

test('a dangling symlink is judged by where it points, not where it sits', () => {
  const outside = mkdtempSync(join(homedir(), '.jarvis-test-outside-'))
  const link = join(workspace, 'dangling.txt')
  try {
    symlinkSync(join(outside, 'would-be-created.txt'), link)
  } catch {
    return // no symlinks on this filesystem
  }
  try {
    assert.equal(allowed('Write', { file_path: link }, true), false)
    assert.equal(allowed('Read', { file_path: link }), false)
    const loop = join(workspace, 'loop')
    symlinkSync(loop, loop)
    assert.equal(allowed('Read', { file_path: loop }), false)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('credentials stay refused even when the roots include home', () => {
  const wide = { allowWrites: false, cwd: workspace, roots: fileRoots({ workspace, extra: [homedir()] }) }
  const ok = (p) => checkToolUse('Read', { file_path: p }, wide).allow
  assert.equal(ok(join(homedir(), 'Pictures', 'cat.png')), true)
  assert.equal(ok(join(homedir(), '.ssh', 'id_ed25519')), false)
  assert.equal(ok(join(homedir(), '.claude', '.credentials.json')), false)
  assert.equal(ok(join(homedir(), '.claude.json')), false)
  // Case-insensitive volumes (macOS, Windows): ~/.SSH is ~/.ssh.
  assert.equal(ok(join(homedir(), '.SSH', 'config')), false)
  assert.equal(ok(join(homedir(), '.Aws', 'credentials')), false)
  assert.equal(ok(join(homedir(), 'project', '.env')), false)
  assert.equal(ok(join(homedir(), 'project', '.env.local')), false)
  assert.equal(ok(join(homedir(), 'certs', 'server.pem')), false)
})

test('writes are confined too, when writes are on', () => {
  mkdirSync(join(workspace, 'out'), { recursive: true })
  assert.equal(allowed('Write', { file_path: join(workspace, 'out', 'a.txt') }, true), true)
  assert.equal(allowed('Write', { file_path: join(homedir(), 'a.txt') }, true), false)
  assert.equal(allowed('Edit', { file_path: '/etc/hosts' }, true), false)
  assert.equal(allowed('Write', { file_path: join(workspace, 'a.txt') }, false), false)
})

test('WebFetch cannot be pointed at the LAN, loopback or cloud metadata', () => {
  assert.equal(allowed('WebFetch', { url: 'https://example.com/a' }), true)
  assert.equal(allowed('WebFetch', { url: 'http://127.0.0.1:8787/file?path=/x.png' }), false)
  assert.equal(allowed('WebFetch', { url: 'http://169.254.169.254/latest/meta-data/' }), false)
  assert.equal(allowed('WebFetch', { url: 'http://192.168.1.1/' }), false)
  assert.equal(allowed('WebFetch', { url: 'http://printer.local/' }), false)
  assert.equal(allowed('WebFetch', { url: 'file:///etc/passwd' }), false)
})

test('WebFetch names that resolve to private addresses are caught', async () => {
  const to = (address) => async () => [{ address, family: address.includes(':') ? 6 : 4 }]
  assert.match(await fetchTargetProblem('https://rebind.example/', to('127.0.0.1')), /private address/)
  assert.match(await fetchTargetProblem('https://rebind.example/', to('::1')), /private address/)
  assert.match(await fetchTargetProblem('https://intranet.example/', to('10.1.2.3')), /private address/)
  assert.equal(await fetchTargetProblem('https://example.com/', to('93.184.215.14')), null)
  assert.match(await fetchTargetProblem('http://127.0.0.1/'), /blocked host/)
})

test('only the built-ins JARVIS uses are offered', () => {
  const ro = builtinTools(false)
  assert.deepEqual(ro.filter((t) => ['Bash', 'Write', 'Edit'].includes(t)), [])
  // Agent is offered on purpose: it is how JARVIS reaches his team (team.mjs).
  assert.ok(ro.includes('Agent'))
  for (const absent of ['Task', 'CronCreate', 'RemoteTrigger', 'SendMessage', 'AskUserQuestion', 'Skill']) {
    assert.ok(!ro.includes(absent), `${absent} should not be offered`)
    assert.ok(!builtinTools(true).includes(absent), `${absent} should not be offered with writes`)
  }
  assert.ok(builtinTools(true).includes('Bash'))
})

test('chrome acting tools can be limited to named sites', async () => {
  const { siteAllowed } = await import('../bridge/chrome.mjs')
  const sites = ['vyro.com', 'whop.com']
  assert.equal(siteAllowed('https://app.vyro.com/campaigns', sites), true)
  assert.equal(siteAllowed('https://whop.com/discover', sites), true)
  assert.equal(siteAllowed('https://evilvyro.com/', sites), false)
  assert.equal(siteAllowed('https://vyro.com.evil.example/', sites), false)
  assert.equal(siteAllowed('https://www.tiktok.com/', sites), false)
  assert.equal(siteAllowed('not a url', sites), false)
})
