// Copy each channel's logo onto the guide's own site, so devices never fetch
// from hosts that are blocked in some countries (Imgur blocks the UK).
// Tries each candidate in order; a channel whose logos all fail gets no icon
// (apps then fall back to the playlist logo instead of a broken image).
import fs from 'node:fs'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

const repo = process.env.GITHUB_REPOSITORY || ''
const [owner, name] = repo.split('/')
if (!owner) { console.log('No GITHUB_REPOSITORY — skipping logo copy'); process.exit(0) }
const base = name.toLowerCase() === `${owner.toLowerCase()}.github.io`
  ? `https://${owner.toLowerCase()}.github.io/logos/`
  : `https://${owner.toLowerCase()}.github.io/${name}/logos/`

const cands = JSON.parse(fs.readFileSync('work/logo-candidates.json', 'utf8'))
const cacheDir = 'logo-cache'
fs.mkdirSync(cacheDir, { recursive: true })
fs.mkdirSync('out/logos', { recursive: true })

const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' }
const MAX = 1024 * 1024
const hash = u => crypto.createHash('sha1').update(u).digest('hex').slice(0, 16)

// Cache: <hash>.<ext> for good downloads, <hash>.fail (with timestamp) for failures
const cached = new Map()
for (const f of fs.readdirSync(cacheDir)) {
  const [h, ext] = f.split('.')
  cached.set(h, ext)
}
const FAIL_RETRY = 24 * 3600 * 1000

async function download(url) {
  const h = hash(url)
  const ext = cached.get(h)
  if (ext && ext !== 'fail') return `${h}.${ext}`
  if (ext === 'fail') {
    const t = +fs.readFileSync(`${cacheDir}/${h}.fail`, 'utf8') || 0
    if (Date.now() - t < FAIL_RETRY) return null
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0 (guide logo copier)' } })
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const buf = Buffer.from(await res.arrayBuffer())
    const e = TYPES[type]
    if (!res.ok || !e || buf.length < 100 || buf.length > MAX) throw new Error(`${res.status} ${type} ${buf.length}`)
    fs.writeFileSync(`${cacheDir}/${h}.${e}`, buf)
    try { fs.unlinkSync(`${cacheDir}/${h}.fail`) } catch {}
    cached.set(h, e)
    return `${h}.${e}`
  } catch {
    fs.writeFileSync(`${cacheDir}/${h}.fail`, String(Date.now()))
    cached.set(h, 'fail')
    return null
  }
}

const keys = Object.keys(cands)
const result = {}
let next = 0
await Promise.all(Array.from({ length: 16 }, async () => {
  while (next < keys.length) {
    const key = keys[next++]
    for (const url of cands[key]) {
      const file = await download(url)
      if (file) { result[key] = file; break }
    }
  }
}))

// Publish only the files in use
const used = new Set(Object.values(result))
for (const f of used) fs.copyFileSync(`${cacheDir}/${f}`, `out/logos/${f}`)

// Rewrite the guide and status to point at the copies
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
let xml = fs.readFileSync('out/guide.xml', 'utf8')
const status = JSON.parse(fs.readFileSync('out/status.json', 'utf8'))
const from = new Map() // original first-choice url → new url (or '' to drop)
for (const key of keys) {
  const orig = cands[key][0]
  const now = result[key] ? base + result[key] : ''
  if (now) status.logos[key] = now
  else delete status.logos[key]
  from.set(key, { orig, now })
}
// Each <channel> carries its own icon; replace per channel id to keep them independent
const byId = new Map(keys.map(k => [esc(k.startsWith('name:') ? k.slice(5) : k), k]))
xml = xml.replace(/(<channel id="([^"]*)">\n(?:[ \t]*<display-name>[^<]*<\/display-name>\n)*)([ \t]*)<icon src="[^"]*"\/>\n/g, (all, head, id, indent) => {
  const key = byId.get(id)
  if (!key) return all
  const { now } = from.get(key)
  return now ? `${head}${indent}<icon src="${esc(now)}"/>\n` : head
})
fs.writeFileSync('out/guide.xml', xml)
fs.writeFileSync('out/guide.xml.gz', zlib.gzipSync(xml, { level: 9 }))
fs.writeFileSync('out/status.json', JSON.stringify(status))

const failed = keys.length - Object.keys(result).length
const imgur = keys.filter(k => result[k] && /imgur\.com/i.test(cands[k].find(u => hash(u) === result[k].split('.')[0]) || '')).length
console.log(`Logos: ${Object.keys(result).length} copied (${used.size} files, ${imgur} originally from Imgur), ${failed} unavailable`)
const lb = 'data/last-build.json'
if (fs.existsSync(lb)) {
  const j = JSON.parse(fs.readFileSync(lb, 'utf8'))
  j.withLogo = Object.keys(result).length
  j.logoFails = failed
  fs.writeFileSync(lb, JSON.stringify(j, null, 1) + '\n')
}
