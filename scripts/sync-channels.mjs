// Downloads your playlist (M3U_URL secret) and saves the live channel list
// to data/channels.json — names, tvg-ids, groups and logos only. Stream URLs
// (which contain your login) are never saved.
import fs from 'node:fs'
import { parseM3U, safeLogo, DEFAULT_LOGO_HOSTS } from '../site/shared.js'

const url = process.env.M3U_URL
if (!url) {
  console.log('M3U_URL secret not set — keeping existing data/channels.json')
  process.exit(0)
}

// Never print the URL or error details — build logs are public
let text
try {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' },
    signal: AbortSignal.timeout(180000)
  })
  if (!res.ok) {
    console.error(`Playlist download failed (HTTP ${res.status}) — keeping existing list`)
    process.exit(1)
  }
  text = await res.text()
} catch {
  console.error('Playlist download failed — keeping existing list')
  process.exit(1)
}
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'))
const hosts = config.logoHosts || DEFAULT_LOGO_HOSTS
const channels = parseM3U(text)
if (!channels.length) {
  console.error('Playlist contained no live channels — keeping existing list')
  process.exit(1)
}

const clean = channels
  .map(c => ({ name: c.name, tvgId: c.tvgId, group: c.group, logo: safeLogo(c.logo, hosts) }))
  .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))

fs.writeFileSync('data/channels.json', JSON.stringify(clean, null, 0).replace(/},{/g, '},\n{') + '\n')
console.log(`Saved ${clean.length} live channels`)
