// Automatically matches any channel that isn't matched yet, when the best
// suggestion is confident. Your own picks (and "no guide" choices) are never
// changed. Auto matches are marked so they can be reviewed in the matcher.
import fs from 'node:fs'
import { groupChannels, prepareSources, suggest, skipMatcher, AUTO_THRESHOLD } from '../site/shared.js'

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'))
const doc = JSON.parse(fs.readFileSync('mappings.json', 'utf8'))
const map = doc.map || {}
const channels = JSON.parse(fs.readFileSync('data/channels.json', 'utf8'))
const sources = prepareSources(JSON.parse(fs.readFileSync('out/sources.json', 'utf8')))

const bad = new Set(Object.keys(fs.existsSync('data/bad-sources.json') ? JSON.parse(fs.readFileSync('data/bad-sources.json', 'utf8')) : {}))
const known = new Set(sources.map(s => s.k).filter(k => !bad.has(k)))
const skipped = skipMatcher(config.skipGroups)
let added = 0
let fixed = 0
let skippedCount = 0
const groups = groupChannels(channels)
for (const g of groups) {
  const cur = map[g.key]
  if (!cur && skipped(g)) { skippedCount++; continue }
  // Your own picks are kept; auto picks are re-checked every run so they improve
  if (cur && !cur.auto) continue
  const best = suggest(g, sources, { region: config.region, sitePriority: config.sites, limit: 1, exclude: bad })[0]
  if (!best || best.score < AUTO_THRESHOLD) {
    // an old auto pick that no longer passes today's rules (gone, wrong country, bad listings) is dropped
    if (cur && cur.src) {
      const srcObj = known.has(cur.src) && sources.find(s => s.k === cur.src)
      const still = srcObj && suggest(g, [srcObj], { region: config.region, sitePriority: config.sites, limit: 1, exclude: bad })[0]
      if (!still || still.score < AUTO_THRESHOLD) { delete map[g.key]; fixed++ }
    }
    continue
  }
  const next = { src: best.src.k, ...(best.offset ? { offset: best.offset } : {}), auto: true }
  if (JSON.stringify(next) === JSON.stringify(cur)) continue
  map[g.key] = next
  cur ? fixed++ : added++
}

if (added || fixed) {
  const sorted = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)))
  fs.writeFileSync('mappings.json', JSON.stringify({ version: 1, map: sorted }, null, 1) + '\n')
}
const matched = Object.values(map).filter(m => m && m.src).length
console.log(`Auto-match: ${added} new, ${fixed} re-matched — ${matched}/${groups.length - skippedCount} channels have a guide (${skippedCount} in 24/7, PPV or VOD groups skipped)`)
