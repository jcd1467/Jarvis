/**
 * Campaign rules, remembered once per campaign, and a caption check that runs
 * before anything is posted or submitted.
 *
 * The rules come from the campaign page (read through Chrome) or from what the
 * user pastes. JARVIS fills the fields; nothing here invents a rule. The check
 * itself is plain code, not a model's judgement: a required phrase is either
 * in the caption or it is not, so the answer is the same every time.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const ok = (text) => ({ content: [{ type: 'text', text }] })

/** Lower-case, straight quotes, single spaces — so a pasted phrase matches. */
export function normalise(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

const hashtagsIn = (text) => [...String(text ?? '').matchAll(/#[\p{L}\p{N}_]+/gu)].map((m) => m[0].toLowerCase())

/**
 * Check one caption (and optionally a length) against a campaign's rules.
 * Returns { pass, problems[], fixed } — `fixed` is the caption with anything
 * missing appended, ready to paste.
 */
export function checkCaption(campaign, caption, durationSeconds) {
  const problems = []
  const text = normalise(caption)
  let fixed = String(caption ?? '').trim()

  for (const phrase of campaign.requiredPhrases ?? []) {
    if (!text.includes(normalise(phrase))) {
      problems.push(`missing the required text: "${phrase}"`)
      fixed = `${fixed}${fixed ? '\n' : ''}${phrase}`
    }
  }
  const tags = hashtagsIn(caption)
  const asTag = (t) => (String(t).startsWith('#') ? String(t) : `#${t}`)
  if (campaign.onlyListedHashtags) {
    const allowed = new Set(
      [...(campaign.requiredHashtags ?? []), ...(campaign.allowedHashtags ?? [])].map((t) => asTag(t).toLowerCase()),
    )
    const extra = tags.filter((t) => !allowed.has(t))
    if (extra.length) {
      problems.push(`hashtags this campaign does not allow: ${extra.join(' ')}`)
      // Out of the fixed caption too, in whatever case they were typed.
      for (const t of extra) {
        fixed = fixed.replace(new RegExp(`\\s*${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'giu'), '')
      }
      fixed = fixed.trim()
    }
  }
  for (const tag of campaign.requiredHashtags ?? []) {
    // Kept exactly as the campaign wrote it: some check the case.
    const want = asTag(tag)
    if (!tags.includes(want.toLowerCase())) {
      problems.push(`missing the required hashtag ${want}`)
      fixed = `${fixed} ${want}`.trim()
    }
  }
  for (const word of campaign.forbiddenWords ?? []) {
    if (word && text.includes(normalise(word))) problems.push(`contains something the rules forbid: "${word}"`)
  }
  const secs = Number(durationSeconds)
  if (Number.isFinite(secs) && secs > 0) {
    if (campaign.minSeconds && secs < campaign.minSeconds) problems.push(`too short: ${secs}s, minimum ${campaign.minSeconds}s`)
    if (campaign.maxSeconds && secs > campaign.maxSeconds) problems.push(`too long: ${secs}s, maximum ${campaign.maxSeconds}s`)
  }
  return { pass: problems.length === 0, problems, fixed }
}

/** The Ssemble settings a campaign's rules imply, as plain instructions. */
export function ssembleSettings(c) {
  const out = []
  if (c.aiTools === 'not allowed') return ['Do not use Ssemble for this campaign: its rules do not allow AI tools.']
  if (c.aiTools === 'restricted' || c.aiTools === 'unknown') {
    out.push('Check first: the rules limit or do not mention AI tools — confirm Ssemble is allowed before using it.')
  }
  const lo = c.minSeconds ?? 0
  const hi = c.maxSeconds ?? 0
  if (lo || hi) out.push(`Clip length: ${lo ? `at least ${lo}s` : ''}${lo && hi ? ', ' : ''}${hi ? `at most ${hi}s` : ''} (Ssemble can run a little long — check it).`)
  else out.push('Clip length: 30–60s (Ssemble default) is fine.')
  if (c.outsideVisuals === false) out.push('B-roll: OFF. Game Video: OFF. (No outside visuals allowed.)')
  if (c.audioChanges === false) out.push('Sound effects and music: OFF. (Audio must not be changed.)')
  out.push(c.captionsOnVideo === false ? 'On-video captions: OFF.' : 'On-video captions: on is fine.')
  return out
}

function describe(c) {
  const lines = [
    `${c.name}${c.platform ? ` (${c.platform})` : ''}${c.status === 'ended' ? ' — ENDED' : ''}`,
    c.rate ? `Pay: ${c.rate}` : null,
    c.minViews ? `Minimum views to earn: ${c.minViews}` : null,
    c.maxPerPost ? `Max per post: ${c.maxPerPost}` : null,
    c.ends ? `Ends: ${c.ends}` : null,
    c.postPlatforms?.length ? `Counts on: ${c.postPlatforms.join(', ')}` : null,
    c.requiredPhrases?.length ? `Caption must include: ${c.requiredPhrases.map((p) => `"${p}"`).join('; ')}` : null,
    c.requiredHashtags?.length ? `Required hashtags: ${c.requiredHashtags.join(' ')}` : null,
    c.onlyListedHashtags ? 'No other hashtags.' : null,
    c.minSeconds || c.maxSeconds ? `Length: ${c.minSeconds ? `min ${c.minSeconds}s` : ''} ${c.maxSeconds ? `max ${c.maxSeconds}s` : ''}`.trim() : null,
    `AI tools: ${c.aiTools ?? 'unknown'}`,
    c.outsideVisuals === false ? 'No outside visuals.' : null,
    c.audioChanges === false ? 'Do not change the audio.' : null,
    ...(c.rules ?? []).map((r) => `- ${r}`),
    `Ssemble: ${ssembleSettings(c).join(' ')}`,
    c.url ? `Page: ${c.url}` : null,
    `Saved ${c.savedAt?.slice(0, 10) ?? '?'}`,
  ]
  return lines.filter(Boolean).join('\n')
}

const slug = (s) => normalise(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

/** Find a saved campaign by id or by words of its name. */
function find(list, ref) {
  const r = normalise(ref)
  if (!r) return []
  const exact = list.filter((c) => c.id === slug(ref) || normalise(c.name) === r)
  return exact.length ? exact : list.filter((c) => normalise(c.name).includes(r))
}

/**
 * @param {{ load: () => any, save: (s: any) => void }} store
 */
export function campaignTools({ load, save }) {
  const list = () => load().campaigns ?? []
  return [
    tool(
      'campaign_save',
      `Save or update one campaign's rules, so they never have to be looked up again. Fill fields ONLY from the campaign page or what he pasted — read the page through Chrome when you can. Leave a field out when the rules do not say; never guess. Copy required caption text and hashtags EXACTLY, character for character. Afterwards, tell him in two sentences what you saved and the Ssemble settings it implies.`,
      {
        name: z.string().describe('Campaign name as shown, e.g. "The Drop: TikTok Edits".'),
        platform: z.string().optional().describe('Where it lives: Whop, Vyro …'),
        url: z.string().optional(),
        rate: z.string().optional().describe('e.g. "$2.00 per 1,000 views".'),
        minViews: z.number().optional().describe('Views a post needs before it pays.'),
        maxPerPost: z.string().optional(),
        ends: z.string().optional().describe('YYYY-MM-DD if known.'),
        postPlatforms: z.array(z.string()).optional().describe('Platforms that count, e.g. ["TikTok"].'),
        requiredPhrases: z.array(z.string()).optional().describe('Text the caption must include, exactly.'),
        requiredHashtags: z.array(z.string()).optional().describe('Hashtags that must appear, e.g. ["#TheDropPartner"].'),
        allowedHashtags: z.array(z.string()).optional(),
        onlyListedHashtags: z.boolean().optional().describe('True when the rules forbid other or unrelated hashtags.'),
        forbiddenWords: z.array(z.string()).optional(),
        minSeconds: z.number().optional(),
        maxSeconds: z.number().optional(),
        aiTools: z.enum(['allowed', 'restricted', 'not allowed', 'unknown']).optional(),
        outsideVisuals: z.boolean().optional().describe('False when only the provided footage may be used.'),
        audioChanges: z.boolean().optional().describe('False when the audio must not be changed.'),
        captionsOnVideo: z.boolean().optional(),
        rules: z.array(z.string()).optional().describe('Every other rule, one short line each.'),
      },
      async (args) => {
        const name = String(args.name ?? '').trim()
        if (!name) return ok('Not saved — the campaign needs a name.')
        const state = load()
        state.campaigns = state.campaigns ?? []
        const id = slug(name)
        const existing = state.campaigns.find((c) => c.id === id)
        const record = { ...(existing ?? {}), ...args, id, name, status: 'active', savedAt: new Date().toISOString() }
        state.campaigns = [...state.campaigns.filter((c) => c.id !== id), record]
        save(state)
        return ok(`${existing ? 'Updated' : 'Saved'}:\n${describe(record)}`)
      },
    ),
    tool(
      'campaign_rules',
      "One saved campaign's rules and the Ssemble settings to use, by name or words from it. With no name, lists every saved campaign. Read this before writing a caption, planning posts or submitting — instead of re-reading the campaign page.",
      { campaign: z.string().optional() },
      async (args) => {
        const all = list()
        if (!all.length) return ok('No campaigns saved yet.')
        if (!args.campaign) return ok(all.map((c) => `${c.name}${c.status === 'ended' ? ' (ended)' : ''}${c.ends ? ` · ends ${c.ends}` : ''}`).join('\n'))
        const hits = find(all, args.campaign)
        if (!hits.length) return ok(`No saved campaign matches "${args.campaign}". Saved: ${all.map((c) => c.name).join('; ')}`)
        return ok(hits.map(describe).join('\n\n'))
      },
    ),
    tool(
      'caption_check',
      'Check a caption — and the clip length if known — against a saved campaign\'s rules, before posting or before submitting a post. Returns every problem and a fixed caption ready to paste. Run it on every caption you write for a campaign and on every post before you submit it. Never submit a post that fails.',
      {
        campaign: z.string().describe('The campaign, by name or words from it.'),
        caption: z.string().describe('The caption exactly as written or as posted.'),
        durationSeconds: z.number().optional(),
      },
      async (args) => {
        const hits = find(list(), args.campaign)
        if (!hits.length) return ok(`No saved rules for "${args.campaign}" — save the campaign first (campaign_save).`)
        if (hits.length > 1) return ok(`Several campaigns match: ${hits.map((c) => c.name).join('; ')}. Say which.`)
        const r = checkCaption(hits[0], args.caption, args.durationSeconds)
        return ok(
          r.pass
            ? `PASS for ${hits[0].name}.`
            : `FAIL for ${hits[0].name}:\n- ${r.problems.join('\n- ')}\nFixed caption:\n${r.fixed}`,
        )
      },
    ),
    tool(
      'campaign_end',
      'Mark a saved campaign as ended (budget gone or closed), so it is no longer planned for. Keeps its rules for the record.',
      { campaign: z.string() },
      async (args) => {
        const state = load()
        const hits = find(state.campaigns ?? [], args.campaign)
        if (hits.length !== 1) return ok(hits.length ? `Several match: ${hits.map((c) => c.name).join('; ')}` : 'No matching campaign.')
        hits[0].status = 'ended'
        save(state)
        return ok(`Marked ended: ${hits[0].name}`)
      },
    ),
  ]
}
