// Shared helpers used by both the matcher page (browser) and the build scripts (Node).

// ---------- M3U parsing ----------

const VOD_URL = /\/(movie|movies|series|vod)\//i
const VOD_EXT = /\.(mp4|mkv|avi|mov|m4v|wmv)(\?|$)/i

function attr(line, name) {
  const m = line.match(new RegExp(name + '="([^"]*)"', 'i'))
  return m ? m[1].trim() : ''
}

// Returns live channels only, WITHOUT stream URLs (they contain login details).
export function parseM3U(text) {
  const lines = text.split(/\r?\n/)
  const out = []
  let pending = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#EXTINF')) {
      const comma = line.lastIndexOf('",') >= 0 ? line.indexOf(',', line.lastIndexOf('"')) : line.indexOf(',')
      const title = comma >= 0 ? line.slice(comma + 1).trim() : ''
      pending = {
        name: title || attr(line, 'tvg-name'),
        tvgId: attr(line, 'tvg-id'),
        group: attr(line, 'group-title'),
        logo: attr(line, 'tvg-logo')
      }
    } else if (line.startsWith('#')) {
      continue
    } else if (pending) {
      if (!VOD_URL.test(line) && !VOD_EXT.test(line) && pending.name) out.push(pending)
      pending = null
    }
  }
  return out
}

// Only keep logos from known public image hosts — provider-hosted logos
// (often bare IP addresses) would reveal where the playlist comes from.
export const DEFAULT_LOGO_HOSTS = [
  'iili.io', 'picons.cmshulk.com', 'i.imgur.com', 'imgur.com', 'raw.githubusercontent.com',
  'upload.wikimedia.org', 'lyngsat.com', 'www.lyngsat.com', 'logo.clearbit.com', 'tvprofil.net'
]
export function safeLogo(url, hosts = DEFAULT_LOGO_HOSTS) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return ''
    const h = u.hostname.toLowerCase()
    return hosts.some(a => h === a || h.endsWith('.' + a)) ? url : ''
  } catch {
    return ''
  }
}

// Group channels by tvg-id (or by name when there is no tvg-id).
export function channelKey(ch) {
  return ch.tvgId ? ch.tvgId : 'name:' + ch.name
}

export function groupChannels(channels) {
  const map = new Map()
  for (const ch of channels) {
    const key = channelKey(ch)
    let g = map.get(key)
    if (!g) {
      g = { key, tvgId: ch.tvgId || '', names: [], groups: [], logo: ch.logo || '' }
      map.set(key, g)
    }
    if (!g.names.includes(ch.name)) g.names.push(ch.name)
    if (ch.group && !g.groups.includes(ch.group)) g.groups.push(ch.group)
    if (!g.logo && ch.logo) g.logo = ch.logo
  }
  return [...map.values()]
}

// ---------- Name normalising & matching ----------

const NOISE = new Set([
  'hevc', 'h265', 'h264', 'x265', 'hd', 'fhd', 'uhd', 'sd', 'hq', 'lq', '4k', '8k', 'hdr',
  '1080', '1080p', '1080i', '720', '720p', '576', '50fps', '60fps', 'fps', 'raw', 'vip',
  'backup', 'bk', 'alt', 'multi', 'uk', 'gb', 'en', 'eng'
])
const CC = 'uk|gb|ie|irl|us|usa|ca|au|nz|de|it|es|fr|nl|be|pt|pl|tr|ar|in|za|ch|at|se|no|dk|fi'
const NUM_WORDS = { one: '1', two: '2', three: '3', four: '4', five: '5' }
const REGIONS = [
  'london', 'england', 'scotland', 'wales', 'cymru', 'ni', 'northernireland', 'nireland',
  'east', 'west', 'north', 'south', 'midlands', 'anglia', 'granada', 'tyne', 'tees', 'border',
  'meridian', 'central', 'yorkshire', 'westcountry', 'stv', 'utv', 'channelislands', 'ireland',
  'eastmidlands', 'westmidlands', 'northeast', 'northwest', 'southeast', 'southwest', 'oxford',
  'yorks', 'lincs', 'cambridge', 'hd'
]

const CALL_STOP = new Set(['WEST', 'WILD', 'WIFE', 'KING', 'WINE', 'WORK', 'WIRE', 'WAVE', 'WARS', 'WALL', 'KIDS', 'KISS', 'WOOD', 'WIND', 'WISE', 'WILL', 'WITH', 'WHAT', 'WHEN', 'WEEK', 'WORD', 'WOLF', 'KNOW', 'KICK', 'KILL', 'KART', 'KEEP', 'WEAR', 'WARD', 'WALK'])
export function callSigns(name, strict = false) {
  const up = (name || '').toUpperCase().trim()
  // a bare call sign, e.g. "WAVE-DT", "KQED"
  const bare = up.match(/^([KW][A-Z]{2,3})(?:-(?:TV|DT|LD|CD|CA|HD))?$/)
  if (bare) return [bare[1]]
  const re = strict ? /\(([KW][A-Z]{2,3})(?:-?(?:TV|DT|LD|CD|CA))?\d?\)/g : /\b([KW][A-Z]{2,3})(?:-?(?:TV|DT|LD|CD|CA))?\b/g
  return [...up.matchAll(re)].map(m => m[1]).filter(c => strict || !CALL_STOP.has(c))
}

export function normalizeName(name) {
  let s = (name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  s = s.replace(/[ᴴᴰᵁᶠˢ]+/g, ' ').toLowerCase()
  // +1 / +2 timeshift
  let offset = 0
  const ccm = s.match(new RegExp('^[\\s|\\[(]*(' + CC + ')\\b'))
  const cc = ccm ? ccm[1].replace('gb', 'uk') : ''
  const ts = s.match(/\+\s*(1|2|24)\b/)
  if (ts) {
    offset = Number(ts[1])
    s = s.replace(ts[0], ' ')
  }
  // country/provider-style prefixes: "UK: ", "|UK| ", "[UK] ", "UK - ", "UK ✪ "
  s = s.replace(new RegExp('^[\\s|\\[(]*(' + CC + ')[\\s|\\])]*[:|\\-–✪★•»]+\\s*'), ' ')
  s = s.replace(new RegExp('^\\s*[|\\[(]\\s*(' + CC + ')\\s*[|\\])]\\s*'), ' ')
  // other short "XX-YYY| " style prefixes, e.g. "UK-BBCI| ", "TV| ", "4K| "
  s = s.replace(/^\s*[^|]{1,14}\|\s*/, ' ')
  s = s.replace(/\b(25|30|50|60)\s*fps\b/g, ' ')
  s = s.replace(/&/g, ' and ').replace(/\+/g, ' plus ')
  s = s.replace(/[^a-z0-9]+/g, ' ').trim()
  s = s.replace(/^u and (?=\w)/, '') // UKTV's "U&Dave", "U&Alibi"…
  let tokens = s.split(' ').filter(Boolean).map(t => NUM_WORDS[t] || t)
  const filtered = tokens.filter(t => !NOISE.has(t))
  if (filtered.length) tokens = filtered
  let key = tokens.join('').replace(/([a-z])(fhd|uhd|hd|sd)$/, '$1') // "SkyAnimationHD"
  // Sky's abbreviations: "SkySp F1", "SkySpMainEv", "SkySp PL"
  key = key.replace(/^skysp(?!orts)/, 'skysports').replace(/mainev$/, 'mainevent').replace(/^skysportspl$/, 'skysportspremierleague')
  return { key, tokens, offset, cc }
}

function bigrams(s) {
  const out = new Map()
  for (let i = 0; i < s.length - 1; i++) {
    const b = s.slice(i, i + 2)
    out.set(b, (out.get(b) || 0) + 1)
  }
  return out
}

function dice(a, b) {
  if (!a.length || !b.length) return 0
  if (a === b) return 1
  const A = bigrams(a)
  const B = bigrams(b)
  let inter = 0
  for (const [k, v] of A) inter += Math.min(v, B.get(k) || 0)
  return (2 * inter) / (Math.max(a.length - 1, 1) + Math.max(b.length - 1, 1))
}

function tvgBase(id) {
  return (id || '').toLowerCase().split('@')[0].replace(/\.(uk|gb|ie)$/, '').replace(/[^a-z0-9]/g, '')
}

// Prepare the source catalogue once: adds normalised keys.
export function prepareSources(sources) {
  return sources.map(src => {
    const n = normalizeName(src.n)
    // Sky drops "Cinema" from its movie channels ("Sky Action HD" = Sky Cinema Action)
    const alt = []
    const xb = (src.x || '').split('@')[0].replace(/\.(uk|ie)$/, '')
    if (/^SkyCinema/.test(xb)) alt.push(normalizeName(xb.replace(/([a-z])([A-Z])/g, '$1 $2')).key)
    const g = n.key.match(/^sky(animation|premiere|action|greats|thriller|family|hits|select|romance|disney|christmas)/)
    if (g) alt.push('skycinema' + n.key.slice(3))
    return { ...src, _alt: alt, _cinema: /^SkyCinema/.test(xb), _key: n.key, _offset: n.offset, _x: tvgBase(src.x), _feed: (src.f || '').toLowerCase(), _call: callSigns(src.n, true)[0] || '' }
  })
}

const callIndex = new WeakMap()
function byCall(sources) {
  let idx = callIndex.get(sources)
  if (!idx) {
    idx = new Map()
    for (const s of sources) if (s._call) (idx.get(s._call) || idx.set(s._call, []).get(s._call)).push(s)
    callIndex.set(sources, idx)
  }
  return idx
}

// Returns up to `limit` suggestions [{src, score, offset}] for a channel group.
export function suggest(group, sources, opts = {}) {
  const { limit = 5, region = 'london', sitePriority = [], exclude = null } = opts
  const pref = region.toLowerCase().replace(/[^a-z]/g, '')
  let names = group.names.map(normalizeName).filter(n => n.key)
  if (!names.length) return []
  // If a tvg-id is shared by a channel and its +1, match the main channel
  const minOff = Math.min(...names.map(n => n.offset))
  names = names.filter(n => n.offset === minOff)
  const groupCc = group.groups.length ? normalizeName(group.groups[0] + ' x').cc : ''
  // UK/Irish channels only ever get UK/Irish (English) listings; US only US/Canada
  const chCc = names[0].cc || groupCc
  const allowed = chCc === 'uk' || chCc === 'ie' ? ['', 'GB', 'IE'] : chCc === 'us' || chCc === 'ca' ? ['US', 'CA'] : null
  const calls = new Set(group.names.flatMap(n => callSigns(n)))
  const callHits = new Set()
  for (const c of calls) for (const s of byCall(sources).get(c) || []) callHits.add(s)
  const idBase = tvgBase(group.tvgId)
  const results = new Map()
  for (const src of sources) {
    if (!src._key) continue
    if (allowed && !allowed.includes(src.r || '')) continue
    if (exclude && exclude.has(src.k)) continue
    let best = 0
    let off = 0
    for (const n of names) {
      if (n.offset !== src._offset && src._offset !== 0) continue
      let score = 0
      if (src._key === n.key) score = 100
      else if (src._alt.length && src._alt.includes(n.key)) score = 99
      if (score === 100 && src._cinema && !n.key.includes('cinema')) score = 94 // "Sky Comedy" (TV) ≠ Sky Cinema Comedy
      else if (src._key.startsWith(n.key) && n.key.length >= 3) {
        const rest = src._key.slice(n.key.length)
        if (rest === pref) score = 92
        else if (REGIONS.includes(rest)) score = 82
      } else if (n.key.startsWith(src._key) && src._key.length >= 4) {
        const rest = n.key.slice(src._key.length)
        if (REGIONS.includes(rest)) score = 85
      }
      if (!score && callHits.has(src)) {
        // US local station: same call sign, e.g. "NBC 4 (WNBC)"; prefer same network
        const net = src._key.match(/^(nbc|cbs|abc|fox|cw|pbs|telemundo|univision|my|ion|mytv)/)
        score = net && n.key.includes(net[1]) ? 90 : 84
        if (/hd$/.test(src.n.toLowerCase())) score -= 0.2
        if (group.tvgId && group.tvgId.toUpperCase().includes(src._call)) score += 3 // tvg-id names this station
      }
      if (!score && src._key[0] === n.key[0] && Math.abs(src._key.length - n.key.length) <= n.key.length * 0.5) {
        const d = dice(src._key, n.key)
        if (d >= 0.7) score = Math.round(d * 75)
      }
      if (score && n.offset && src._offset === n.offset) score += 3 // prefer a real +1 listing
      if (score > best) {
        best = score
        off = src._offset ? 0 : n.offset
      }
    }
    if (idBase && src._x && src._x === idBase && src._offset === (names[0].offset || 0)) {
      best = Math.max(best, 95)
    }
    if (!best) continue
    // Prefer UK/English feeds unless the channel itself is e.g. "DE: …"
    const cc = names[0].cc || groupCc
    if (src.r) best -= cc && src.r.toLowerCase() === cc ? -2 : 6
    else if (cc && cc !== 'uk' && cc !== 'ie') best -= 6
    // Regional feeds: prefer your region, then generic, then other regions
    if (src._feed) {
      if (pref && src._feed.includes(pref)) best += 2
      else if (/ireland|scotland|wales|cymru|northernireland|ni$|anglia|granada|border|meridian|tyne|tees|central|westcountry|yorkshire|midlands/.test(src._feed)) best -= 2
    }
    const pr = sitePriority.indexOf(src.s)
    best -= (pr < 0 ? sitePriority.length : pr) * 0.5
    const prev = results.get(src.k)
    if (!prev || prev.score < best) results.set(src.k, { src, score: best, offset: off })
  }
  return [...results.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}

export const AUTO_THRESHOLD = 80

// Groups that never have a real guide (24/7 loops, PPV events, VOD)
const HEADER = /^\s*([#=*~\-_]{3,}|[-#=*~_★•]+\s[^|]*\s[-#=*~_★•]+(\s|\||$))/ // "#####", "- NO EVENT STREAMING -"
export function skipMatcher(patterns = []) {
  const res = patterns.map(p => new RegExp(p, 'i'))
  return g =>
    g.names.every(n => HEADER.test(n)) ||
    (g.groups.length > 0 && g.groups.every(name => res.some(r => r.test(name))))
}
