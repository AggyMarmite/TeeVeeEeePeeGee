// Builds the final guide: every matched channel gets the listings of its
// source, under YOUR channel's tvg-id (so every app matches it automatically).
import fs from 'node:fs'
import zlib from 'node:zlib'
import { groupChannels, normalizeName } from '../site/shared.js'

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const mappings = JSON.parse(fs.readFileSync('mappings.json', 'utf8')).map || {}
const channels = JSON.parse(fs.readFileSync('data/channels.json', 'utf8'))
const groups = new Map(groupChannels(channels).map(g => [g.key, g]))
const grabmap = fs.existsSync('work/grabmap.json') ? JSON.parse(fs.readFileSync('work/grabmap.json', 'utf8')) : {}
const read = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
const grabbed = read('work/grabbed.xml') + '\n' + read('work/epgshare.xml')

// Index grabbed listings by grab id
const programmes = new Map()
const icons = new Map()
for (const m of grabbed.matchAll(/<channel\b[^>]*\sid="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/g)) {
  const icon = m[2].match(/<icon\b[^>]*src="([^"]*)"/)
  if (icon) icons.set(m[1], icon[1])
}
for (const m of grabbed.matchAll(/<programme\b[^>]*>[\s\S]*?<\/programme>/g)) {
  const id = m[0].match(/\schannel="([^"]*)"/)?.[1]
  if (!id) continue
  if (!programmes.has(id)) programmes.set(id, [])
  programmes.get(id).push(m[0])
}

// ---- Spot useless sources: channel-moved notices and foreign-language listings ----
const NOTICE = /\b(on|to) (channel )?\d{3,4}\b|\bmoved\b|\bnow (on|available)\b|\bno longer\b|\bhas closed\b|\bclos(ing|edown)\b|\boff air\b|\bfrom (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d/i
const FOREIGN = /\b(der|das|und|mit|für|wird|nicht|ein|eine|les|une|dans|avec|pour|sur|los|las|para|por|una|est[aá]|het|een|och|för|på|della|nella|não|uma|ikke|og)\b/gi
const ENGLISH = /\b(the|and|of|to|with|for|his|her|their|is|are|in|on|from|after|who|this)\b/gi
const ACCENT = /[äöüßéèêëàâçñãõåøæìòùíóúœ]/i
const text = (p, tag) => (p.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\/${tag}>`)) || [])[1] || ''
function verdict(list, englishOnly) {
  if (!list.length) return null
  const titles = list.map(p => text(p, 'title').trim())
  const counts = {}
  for (const t of titles) counts[t] = (counts[t] || 0) + 1
  const [top, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  if (n / titles.length >= 0.9 && NOTICE.test(top)) return 'notice'
  if (!englishOnly) return null
  let fo = 0
  let en = 0
  let accents = 0
  for (const p of list) {
    const t = text(p, 'title') + ' ' + text(p, 'desc')
    fo += (t.match(FOREIGN) || []).length
    en += (t.match(ENGLISH) || []).length
    if (ACCENT.test(text(p, 'title'))) accents++
  }
  if (list.length >= 4 && (fo > en * 1.5 + 3 || (accents / list.length > 0.5 && en < list.length))) return 'foreign'
  return null
}
const badPath = 'data/bad-sources.json'
const bad = fs.existsSync(badPath) ? JSON.parse(fs.readFileSync(badPath, 'utf8')) : {}
// retry sources after 14 days
// retry: empty sources after 3 days, the rest after 14
for (const [k, v] of Object.entries(bad)) if (Date.now() - Date.parse(v.since) > (v.reason === 'empty' ? 3 : 14) * 86400e3) delete bad[k]
// sources used by UK/Irish channels must be English
const ukKeys = new Set()
for (const [k, m] of Object.entries(mappings)) {
  const g = groups.get(k)
  if (!m?.src || !g) continue
  const cc = normalizeName(g.names[0]).cc || (g.groups[0] ? normalizeName(g.groups[0] + ' x').cc : '')
  if (cc === 'uk' || cc === 'ie') ukKeys.add(m.src)
}
const gidToKey = Object.fromEntries(Object.entries(grabmap).map(([k, g]) => [g, k]))
let newBad = 0
for (const [gid, list] of programmes) {
  const key = gidToKey[gid]
  if (!key || bad[key]) continue
  const v = verdict(list, ukKeys.has(key))
  if (v) {
    bad[key] = { reason: v, since: new Date().toISOString().slice(0, 10) }
    newBad++
  }
}
// sources that returned nothing at all (site down or channel gone)
if (programmes.size) {
  for (const [gid, key] of Object.entries(gidToKey)) {
    if (!programmes.has(gid) && !bad[key]) {
      bad[key] = { reason: 'empty', since: new Date().toISOString().slice(0, 10) }
      newBad++
    }
  }
}
for (const [gid, key] of Object.entries(gidToKey)) if (bad[key]) programmes.delete(gid)
fs.writeFileSync(badPath, JSON.stringify(Object.fromEntries(Object.entries(bad).sort()), null, 1) + '\n')
if (newBad) {
  fs.writeFileSync('work/bad-changed', String(newBad))
  console.log(`${newBad} source(s) had notices or foreign-language listings — they'll be swapped out`)
}

// Shift "YYYYMMDDHHMMSS +ZZZZ" by whole hours, keeping the original zone
function shift(stamp, hours) {
  const m = stamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*(.*)$/)
  if (!m) return stamp
  const d = new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + hours * 3600000)
  const p = n => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${m[7] ? ' ' + m[7] : ''}`
}

const chanXml = []
const progXml = []
const status = {}
const logos = {}
const srcLogos = new Map()
if (fs.existsSync('work/sources-full.json')) for (const c of JSON.parse(fs.readFileSync('work/sources-full.json', 'utf8'))) if (c.logo) srcLogos.set(c.key, c.logo)
const bySite = {}
let total = 0
for (const [key, m] of Object.entries(mappings).sort()) {
  if (!m || !m.src) continue
  const id = key.startsWith('name:') ? key.slice(5) : key
  const g = groups.get(key)
  const names = g ? g.names : [id]
  const gid = grabmap[m.src]
  const logo = (g && g.logo) || icons.get(gid) || srcLogos.get(m.src) || ''
  if (logo) logos[key] = logo
  chanXml.push(
    `  <channel id="${esc(id)}">\n` +
      names.map(n => `    <display-name>${esc(n)}</display-name>\n`).join('') +
      (logo ? `    <icon src="${esc(logo)}"/>\n` : '') +
      `  </channel>`
  )
  const list = (gid && programmes.get(gid)) || []
  const offset = Number(m.offset) || 0
  for (const p of list) {
    let out = p.replace(/\schannel="[^"]*"/, ` channel="${esc(id)}"`)
    if (offset) out = out.replace(/\s(start|stop)="([^"]*)"/g, (_, a, v) => ` ${a}="${shift(v, offset)}"`)
    progXml.push('  ' + out.trim())
  }
  status[key] = list.length
  const site = m.src.split('|')[0]
  bySite[site] = bySite[site] || [0, 0]
  bySite[site][list.length ? 0 : 1]++
  total += list.length
}

const mapped = Object.keys(status).length
if (mapped && total === 0) {
  console.error('No listings were fetched at all — not publishing, the previous guide stays live.')
  process.exit(1)
}

const xml =
  `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="tv-guide">\n` +
  chanXml.join('\n') + (chanXml.length ? '\n' : '') +
  progXml.join('\n') + (progXml.length ? '\n' : '') +
  `</tv>\n`

fs.mkdirSync('out', { recursive: true })
fs.writeFileSync('out/guide.xml', xml)
fs.writeFileSync('out/guide.xml.gz', zlib.gzipSync(xml, { level: 9 }))
fs.writeFileSync('out/status.json', JSON.stringify({ built: new Date().toISOString(), counts: status, logos }))
const empty = Object.values(status).filter(n => n === 0).length
fs.writeFileSync('data/last-build.json', JSON.stringify({ built: new Date().toISOString().slice(0, 16), channels: mapped, programmes: total, noListings: empty, withLogo: Object.keys(logos).length, bySite, epgshare: fs.existsSync('work/epgshare-log.json') ? JSON.parse(read('work/epgshare-log.json')) : null }, null, 1) + '\n')
console.log(`Guide: ${mapped} channels, ${total} programmes${empty ? `, ${empty} with no listings` : ''}`)
