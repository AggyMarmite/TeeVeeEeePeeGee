// Checks the finished guide for likely mistakes and writes data/audit.json.
import fs from 'node:fs'
import { groupChannels, prepareSources, normalizeName, suggest } from '../site/shared.js'

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'))
const map = JSON.parse(fs.readFileSync('mappings.json', 'utf8')).map || {}
const channels = JSON.parse(fs.readFileSync('data/channels.json', 'utf8'))
const sources = prepareSources(JSON.parse(fs.readFileSync('out/sources.json', 'utf8')))
const bySrc = new Map(sources.map(s => [s.k, s]))
const groups = new Map(groupChannels(channels).map(g => [g.key, g]))
const xml = fs.readFileSync('out/guide.xml', 'utf8')

const toMs = stamp => {
  const m = stamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])(\d{2})(\d{2})?/)
  if (!m) return NaN
  const utc = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  const off = (+m[8] * 60 + +(m[9] || 0)) * 60e3
  return m[7] === '+' ? utc - off : utc + off
}
const unesc = s => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

// programmes by channel id
const progs = new Map()
for (const m of xml.matchAll(/<programme\b([^>]*)>([\s\S]*?)<\/programme>/g)) {
  const a = n => (m[1].match(new RegExp(`\\s${n}="([^"]*)"`)) || [])[1] || ''
  const id = unesc(a('channel'))
  if (!progs.has(id)) progs.set(id, [])
  progs.get(id).push({ s: toMs(a('start')), e: toMs(a('stop')), t: unesc((m[2].match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || ''), raw: a('start') })
}

const now = Date.now()
const report = { built: new Date().toISOString().slice(0, 16), weakMatches: [], sharedIds: [], stale: [], gaps: [], overlaps: [], badTimes: [], offsets: [], zones: {} }

for (const [key, m] of Object.entries(map)) {
  if (!m || !m.src) continue
  const g = groups.get(key)
  const src = bySrc.get(m.src)
  const id = key.startsWith('name:') ? key.slice(5) : key
  if (!g) continue
  // 1. weak / suspicious matches
  if (src) {
    const best = suggest(g, [src], { region: config.region, sitePriority: config.sites, limit: 1 })[0]
    const score = best ? Math.round(best.score) : 0
    if (score < 95) report.weakMatches.push({ ch: g.names[0], src: src.n + ' · ' + src.s + (src.f ? ' ' + src.f : '') + (src.r ? ' ' + src.r : ''), score, auto: !!m.auto })
  }
  // 2. one tvg-id shared by clearly different channels
  const keys = [...new Set(g.names.map(n => { const x = normalizeName(n); return x.key + (x.offset ? '+' + x.offset : '') }))]
  if (keys.length > 1) {
    const base = keys.map(k => k.replace(/\+\d+$/, ''))
    const distinct = new Set(base.filter(b => !base.some(o => o !== b && (o.startsWith(b) || b.startsWith(o)))))
    if (distinct.size > 1 || keys.some(k => /\+\d+$/.test(k)) !== keys.every(k => /\+\d+$/.test(k))) report.sharedIds.push({ tvgId: g.tvgId, names: g.names.slice(0, 5) })
  }
  // 3. listing quality
  const list = (progs.get(id) || []).sort((a, b) => a.s - b.s)
  if (!list.length) continue
  const last = Math.max(...list.map(p => p.e))
  if (last < now + 18 * 3600e3) report.stale.push({ ch: g.names[0], hoursAhead: Math.round((last - now) / 3600e3), src: m.src.split('|')[0] })
  let gapH = 0
  let overlaps = 0
  let bad = 0
  for (let i = 0; i < list.length; i++) {
    const p = list[i]
    if (!(p.e > p.s) || p.e - p.s > 24 * 3600e3) bad++
    if (i) {
      const d = p.s - list[i - 1].e
      if (d > gapH * 3600e3) gapH = d / 3600e3
      if (d < -60e3 && p.s !== list[i - 1].s) overlaps++
    }
  }
  if (gapH >= 4) report.gaps.push({ ch: g.names[0], hours: Math.round(gapH), src: m.src.split('|')[0] })
  if (overlaps > 2) report.overlaps.push({ ch: g.names[0], overlaps, src: m.src.split('|')[0] })
  if (bad) report.badTimes.push({ ch: g.names[0], bad, src: m.src.split('|')[0] })
  // 4. +1 channels: is the shift applied?
  const isPlus = g.names.every(n => normalizeName(n).offset === 1)
  const srcPlus = src && src._offset === 1
  if (isPlus && !srcPlus && (m.offset || 0) !== 1) report.offsets.push({ ch: g.names[0], src: src?.n, offset: m.offset || 0 })
  if (!isPlus && srcPlus) report.offsets.push({ ch: g.names[0], src: src.n, note: 'normal channel matched to a +1 guide' })
  // 5. time zones used by each source
  const site = m.src.split('|')[0]
  const tz = (list[0].raw.match(/[+-]\d{4}$/) || ['none'])[0]
  report.zones[site] = report.zones[site] || {}
  report.zones[site][tz] = (report.zones[site][tz] || 0) + 1
}

// Samples to sanity-check times (shown in UK time)
const fmt = ms => new Date(ms).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit' })
report.samples = {}
for (const want of (config.auditSamples || [])) {
  const re = new RegExp(want, 'i')
  const key = Object.keys(map).find(k => map[k]?.src && groups.get(k)?.names.some(n => re.test(n)))
  if (!key) continue
  const id = key.startsWith('name:') ? key.slice(5) : key
  const list = (progs.get(id) || []).filter(p => p.e > now).sort((a, b) => a.s - b.s).slice(0, 6)
  report.samples[groups.get(key).names[0] + ' <- ' + (bySrc.get(map[key].src)?.n || '') + ' · ' + map[key].src.split('|')[0]] = list.map(p => `${fmt(p.s)} ${p.t}`)
}
report.doubleEscaped = (xml.match(/&amp;(amp|apos|quot|lt|gt|#\d+);/g) || []).length
report.counts = Object.fromEntries(Object.entries(report).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]))
for (const k of Object.keys(report.counts)) report[k] = report[k].slice(0, 150)
fs.writeFileSync('data/audit.json', JSON.stringify(report, null, 1) + '\n')
console.log('Audit:', JSON.stringify(report.counts))
