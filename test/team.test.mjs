import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TEAM } from '../bridge/team.mjs'

test('only the analyst may reach Asana; no agent reaches the screen, lists or mail', () => {
  for (const [name, a] of Object.entries(TEAM)) {
    for (const blocked of ['mcp__jarvis', 'mcp__jarvis_ui', 'mcp__jarvis_lists', 'mcp__claude_ai_Microsoft_365']) {
      assert.ok(a.disallowedTools.includes(blocked), `${name} must not reach ${blocked}`)
    }
    assert.equal(a.disallowedTools.includes('mcp__claude_ai_Asana'), name !== 'analyst', name)
    assert.match(a.prompt, /Never invent/)
  }
})
