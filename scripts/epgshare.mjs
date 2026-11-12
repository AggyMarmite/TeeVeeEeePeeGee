// epgshare01.online — handled directly instead of through the generic grabber,
// because its file names and channel lists change over time.
//
//   node scripts/epgshare.mjs catalogue   download the region files listed in
//                                         config.epgshareTags and list their channels
//   node scripts/epgshare.mjs listings    extract programmes for matched channels
import fs from 'node:fs'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const BASE = process.env.EPGSHARE_BASE || 'https://epgshare01.online/epgshare01/'
const DIR = 'work/epgshare'
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'))
const mode = process.argv[2]

const decode = s =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&')

// Stream a (large) XML file and call fn(element) for each <tag …>…</tag>
async function eachElement(path, tag, fn) {
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'g')
  const open = `<${tag}`
  let buf = ''
  for await (const chunk of fs.createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 })) {
    buf += chunk
    re.lastIndex = 0
    let m
    let last = 0
    while ((m = re.exec(buf))) {
      last = re.lastIndex
      fn(m[0])
    }
    const tail = buf.lastIndexOf(open)
    buf = tail >= last ? buf.slice(tail) : buf.slice(Math.max(last, buf.length - 64))
  }
}

function regionOf(tag) {
  if (/^UK/.test(tag)) return 'GB'
  return tag.slice(0, 2)
}

if (mode === 'catalogue') {
  fs.mkdirSync(DIR, { recursive: true })
  const wanted = config.epgshareTags || []
  let tags = []
  try {
    const html = await (await fetch(BASE, { signal: AbortSignal.timeout(60000) })).text()
    const all = [...new Set([...html.matchAll(/epg_ripper_([A-Za-z0-9_\-]+)\.xml\.gz/g)].map(m => m[1]))]
    tags = all.filter(t => wanted.some(w => new RegExp(`^${w}(\\d|_|$)`, 'i').test(t)))
    console.log(`epgshare01 files: ${tags.join(', ') || 'none matched'} (of ${all.length})`)
  } catch (e) {
    console.log(`epgshare01 index unavailable (${e.message})`)
  }
  const sources = []
  const log = {}
  for (const tag of tags) {
    const file = `${DIR}/${tag}.xml`
    try {
      const res = await fetch(`${BASE}epg_ripper_${tag}.xml.gz`, { signal: AbortSignal.timeout(600000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await pipeline(Readable.fromWeb(res.body), zlib.createGunzip(), fs.createWriteStream(file))
      let n = 0
      await eachElement(file, 'channel', el => {
        const id = el.match(/\sid="([^"]*)"/)?.[1]
        const dn = el.match(/<display-name\b[^>]*>([\s\S]*?)<\/display-name>/)?.[1]
        if (!id) return
        sources.push({
          site: 'epgshare01.online',
          site_id: `${tag}#${decode(id)}`,
          lang: 'en',
          name: decode((dn || id).replace(/<!\[CDATA\[|\]\]>/g, '').trim()),
          xmltv_id: '',
          logo: el.match(/<icon\b[^>]*src="([^"]*)"/)?.[1] || '',
          region: regionOf(tag),
          feed: tag
        })
        n++
      })
      log[tag] = { channels: n, sample: sources.slice(-n).filter((_, i) => i % Math.max(1, Math.floor(n / 6)) === 0).slice(0, 6).map(c => c.name + ' = ' + c.site_id.split('#')[1]) }
      console.log(`  ${tag}: ${n} channels`)
    } catch (e) {
      log[tag] = e.message
      console.log(`  ${tag}: failed (${e.message})`)
    }
  }
  fs.writeFileSync('work/epgshare-sources.json', JSON.stringify(sources))
  fs.writeFileSync('work/epgshare-log.json', JSON.stringify({ catalogue: log }))
}

if (mode === 'listings') {
  const days = config.days || 3
  const grabmap = JSON.parse(fs.readFileSync('work/grabmap.json', 'utf8'))
  const byTag = new Map()
  for (const [key, gid] of Object.entries(grabmap)) {
    const [site, , siteId] = key.split('|')
    if (site !== 'epgshare01.online') continue
    const i = siteId.indexOf('#')
    const tag = siteId.slice(0, i)
    if (!byTag.has(tag)) byTag.set(tag, new Map())
    byTag.get(tag).set(siteId.slice(i + 1), gid)
  }
  const now = Date.now()
  const from = now - 6 * 3600e3
  const to = now + days * 86400e3
  const toMs = stamp => {
    const m = stamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])(\d{2})(\d{2})?/)
    if (!m) return NaN
    const utc = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])
    const off = (+m[8] * 60 + +(m[9] || 0)) * 60e3
    return m[7] === '+' ? utc - off : utc + off
  }
  const out = fs.createWriteStream('work/epgshare.xml')
  const logPath = 'work/epgshare-log.json'
  const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : {}
  log.listings = {}
  let total = 0
  for (const [tag, ids] of byTag) {
    const file = `${DIR}/${tag}.xml`
    if (!fs.existsSync(file)) {
      log.listings[tag] = 'file missing'
      continue
    }
    const got = new Set()
    let count = 0
    await eachElement(file, 'programme', p => {
      const ch = p.match(/\schannel="([^"]*)"/)
      const id = ch && decode(ch[1])
      const gid = id && ids.get(id)
      if (!gid) return
      const start = toMs(p.match(/\sstart="([^"]*)"/)?.[1] || '')
      const stop = toMs(p.match(/\sstop="([^"]*)"/)?.[1] || '')
      if (!(stop >= from && start < to)) return
      out.write(p.replace(/\schannel="[^"]*"/, ` channel="${gid}"`) + '\n')
      got.add(id)
      count++
    })
    log.listings[tag] = { channels: ids.size, withListings: got.size, programmes: count }
    console.log(`${tag}: ${got.size}/${ids.size} channels, ${count} programmes`)
    total += count
  }
  out.end()
  await new Promise(r => out.on('finish', r))
  fs.writeFileSync(logPath, JSON.stringify(log))
  console.log(`epgshare01: ${total} programmes`)
}
