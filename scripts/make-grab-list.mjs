// Turns mappings.json into a channels.xml for the grabber, fetching each
// matched source only once even if several of your channels use it.
import fs from 'node:fs'

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const mappings = JSON.parse(fs.readFileSync('mappings.json', 'utf8')).map || {}
const full = JSON.parse(fs.readFileSync('work/sources-full.json', 'utf8'))
const byKey = new Map(full.map(c => [c.key, c]))

const wanted = [...new Set(Object.values(mappings).map(m => m.src).filter(Boolean))].sort()
const grabmap = {}
const lines = []
let i = 0
for (const key of wanted) {
  const c = byKey.get(key)
  if (!c) {
    console.warn(`! source no longer available: ${key}`)
    continue
  }
  const gid = `g${++i}`
  grabmap[key] = gid
  if (c.site === 'epgshare01.online') continue // fetched directly by fetch-epgshare.mjs
  lines.push(
    `  <channel site="${esc(c.site)}" site_id="${esc(c.site_id)}" lang="${esc(c.lang)}" xmltv_id="${gid}">${esc(c.name)}</channel>`
  )
}

fs.writeFileSync('work/channels.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n${lines.join('\n')}\n</channels>\n`)
fs.writeFileSync('work/grabmap.json', JSON.stringify(grabmap))
fs.writeFileSync('work/count', String(lines.length))
console.log(`Grab list: ${lines.length} sources for ${Object.keys(mappings).length} matched channels`)
