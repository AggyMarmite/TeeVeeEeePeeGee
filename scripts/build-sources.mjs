// Builds the catalogue of guide sources you can match channels to,
// from the open-source iptv-org/epg site lists.
// Usage: node scripts/build-sources.mjs <path-to-iptv-org-epg>
import fs from 'node:fs'
import path from 'node:path'

const epgDir = process.argv[2] || '.epg'
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'))

export function decode(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&amp;/g, '&')
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`))
  return m ? decode(m[1]) : ''
}

const full = []
const seen = new Set()
for (const site of config.sites) {
  if (site === 'epgshare01.online') {
    // live channel list from scripts/epgshare.mjs catalogue
    const f = 'work/epgshare-sources.json'
    const list = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []
    for (const ch of list) {
      const dedupe = `${site}|${ch.feed}|${ch.name}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      ch.key = `${site}|${ch.lang}|${ch.site_id}`
      full.push(ch)
    }
    continue
  }
  const dir = path.join(epgDir, 'sites', site)
  if (!fs.existsSync(dir)) {
    console.warn(`! site not found: ${site}`)
    continue
  }
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.channels.xml'))) {
    const xml = fs.readFileSync(path.join(dir, file), 'utf8')
    for (const m of xml.matchAll(/<channel\b([^>]*)>([\s\S]*?)<\/channel>/g)) {
      const tag = m[1]
      const ch = {
        site,
        site_id: attr(tag, 'site_id'),
        lang: attr(tag, 'lang'),
        xmltv_id: attr(tag, 'xmltv_id'),
        logo: attr(tag, 'logo'),
        name: decode(m[2].trim())
      }
      if (!ch.site_id || !ch.name) continue
      let region = (config.siteRegions || {})[site] || ''
      if (site === 'sky.com') {
        region = ch.site_id.split('#')[0]
        if (config.skyRegions && !config.skyRegions.includes(region)) continue
      }
      // Sky lists the same channel once per regional bouquet — keep one
      const dedupe = `${site}|${region}|${ch.lang}|${ch.name}|${ch.xmltv_id}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      ch.key = `${site}|${ch.lang}|${ch.site_id}`
      ch.region = region
      full.push(ch)
    }
  }
}

fs.mkdirSync('work', { recursive: true })
fs.mkdirSync('out', { recursive: true })
fs.writeFileSync('work/sources-full.json', JSON.stringify(full))
// Compact catalogue for the matcher page
const compact = full.map(c => {
  const o = { k: c.key, n: c.name, s: c.site }
  if (c.xmltv_id) {
    o.x = c.xmltv_id
    const feed = (c.xmltv_id.split('@')[1] || '').replace(/(HD|SD|UHD)$/, '')
    if (feed) o.f = feed
  }
  if (c.site === 'epgshare01.online') o.f = c.feed
  if (c.region && c.region !== 'GB') o.r = c.region
  else if (c.lang && c.lang !== 'en') o.r = c.lang.toUpperCase()
  return o
})
fs.writeFileSync('out/sources.json', JSON.stringify(compact))
console.log(`Catalogue: ${full.length} guide sources from ${config.sites.length} sites`)
