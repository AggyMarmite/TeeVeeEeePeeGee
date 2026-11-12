import { groupChannels, prepareSources, suggest, normalizeName, parseM3U, skipMatcher, safeLogo, AUTO_THRESHOLD } from './shared.js'

const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// ---------- state ----------
const LS = { token: 'tvg.token', repo: 'tvg.repo' }
const store = {
  get: k => { try { return localStorage.getItem(k) || '' } catch { return '' } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k) } catch {} }
}
const S = {
  token: store.get(LS.token),
  repo: store.get(LS.repo) || guessRepo(),
  branch: 'main',
  sources: [], byKey: new Map(),
  groups: [], mappings: {}, mapSha: null, saved: '{}',
  status: { counts: {} },
  filter: 'unmatched', q: '', shown: 80,
  sugCache: new Map(),
  config: { region: 'London', sites: [] }
}

function guessRepo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/)
  const seg = location.pathname.split('/').filter(Boolean)[0]
  return m && seg ? `${m[1]}/${seg}` : ''
}

// ---------- GitHub API ----------
const b64 = {
  enc(str) {
    const bytes = new TextEncoder().encode(str)
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(bin)
  },
  dec(b) {
    const bin = atob(b.replace(/\s/g, ''))
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)))
  }
}
async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${S.repo}${path}`, {
    ...opts,
    headers: {
      Accept: opts.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {})
    },
    cache: 'no-store'
  })
  if (!res.ok) {
    let msg = `GitHub error ${res.status}`
    try { msg += ': ' + (await res.json()).message } catch {}
    throw new Error(msg)
  }
  return opts.raw ? res.text() : res.json()
}
async function getFile(path) {
  try {
    const meta = await gh(`/contents/${path}?ref=${S.branch}`)
    const text = meta.content ? b64.dec(meta.content) : await gh(`/contents/${path}?ref=${S.branch}`, { raw: true })
    return { text, sha: meta.sha }
  } catch (e) {
    if (String(e.message).includes('404')) return { text: null, sha: null }
    throw e
  }
}
async function putFile(path, text, sha, message) {
  const r = await gh(`/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: b64.enc(text), branch: S.branch, ...(sha ? { sha } : {}) })
  })
  return r.content.sha
}
async function getStatic(name) {
  const r = await fetch(name + '?t=' + Date.now(), { cache: 'no-store' })
  if (!r.ok) throw new Error(`${name}: ${r.status}`)
  return r.json()
}

// ---------- load ----------
async function load() {
  $('#main').innerHTML = '<div class="empty">Loading…</div>'
  try {
    const [sources, status] = await Promise.all([
      getStatic('sources.json'),
      getStatic('status.json').catch(() => ({ counts: {} }))
    ])
    S.config = await getStatic('config.json').catch(() => S.config)
    S.sources = prepareSources(sources)
    S.byKey = new Map(S.sources.map(s => [s.k, s]))
    S.status = status
    let channels, mapText
    if (S.token && S.repo) {
      const repo = await gh('')
      S.branch = repo.default_branch || 'main'
      const [ch, mp] = await Promise.all([getFile('data/channels.json'), getFile('mappings.json')])
      channels = ch.text ? JSON.parse(ch.text) : []
      mapText = mp.text
      S.mapSha = mp.sha
    } else {
      channels = await getStatic('channels.json').catch(() => [])
      mapText = JSON.stringify(await getStatic('mappings.json').catch(() => ({ map: {} })))
    }
    S.mappings = (mapText ? JSON.parse(mapText).map : {}) || {}
    S.saved = JSON.stringify(S.mappings)
    const skip = skipMatcher(S.config.skipGroups || [])
    S.allGroups = groupChannels(channels)
    S.groups = S.allGroups.filter(g => S.mappings[g.key] || !skip(g)).sort((a, b) => a.names[0].localeCompare(b.names[0], undefined, { numeric: true }))
    S.sugCache.clear()
    render()
  } catch (e) {
    $('#main').innerHTML = `<div class="card"><h2>Couldn't load</h2><p>${esc(e.message)}</p><button id="retryBtn">Retry</button></div>`
  }
}

// ---------- helpers ----------
const sugOpts = () => ({ region: S.config.region || 'London', sitePriority: S.config.sites || [], limit: 6 })
function sugFor(g) {
  if (!S.sugCache.has(g.key)) S.sugCache.set(g.key, suggest(g, S.sources, sugOpts()))
  return S.sugCache.get(g.key)
}
const dirty = () => JSON.stringify(S.mappings) !== S.saved
const isDirtyKey = k => JSON.stringify(S.mappings[k] || null) !== JSON.stringify(JSON.parse(S.saved)[k] || null)
function srcLabel(src) {
  const site = src.s.replace(/^(www\.|player\.)/, '')
  return `${src.n}${src.f ? ' (' + src.f + ')' : ''} · ${site}${src.r ? ' · ' + src.r : ''}`
}
const offLabel = o => (o ? ` (${o > 0 ? '+' : ''}${o}h)` : '')
function toast(msg, ms = 3500) {
  const t = $('#toast')
  t.innerHTML = msg
  t.classList.add('show')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => t.classList.remove('show'), ms)
}

// ---------- render ----------
function filtered() {
  const q = normalizeName(S.q).key
  const raw = S.q.trim().toLowerCase()
  return S.groups.filter(g => {
    const m = S.mappings[g.key]
    const cnt = S.status.counts?.[g.key]
    if (S.filter === 'unmatched' && m) return false
    if (S.filter === 'matched' && !m?.src) return false
    if (S.filter === 'auto' && !m?.auto) return false
    if (S.filter === 'ignored' && !(m && !m.src)) return false
    if (S.filter === 'nologo' && !(m?.src && !S.status.logos?.[g.key] && !isDirtyKey(g.key))) return false
    if (S.filter === 'nolist' && !(m && cnt === 0 && !isDirtyKey(g.key))) return false
    if (S.filter.startsWith('grp:') && !g.groups.includes(S.filter.slice(4))) return false
    if (!raw) return true
    return g.names.some(n => n.toLowerCase().includes(raw) || (q && normalizeName(n).key.includes(q))) || g.tvgId.toLowerCase().includes(raw)
  })
}

function renderChips() {
  const total = S.groups.length
  const matched = S.groups.filter(g => S.mappings[g.key]?.src).length
  const unmatched = S.groups.filter(g => !S.mappings[g.key]).length
  const auto = S.groups.filter(g => S.mappings[g.key]?.auto).length
  const ignored = S.groups.filter(g => S.mappings[g.key] && !S.mappings[g.key].src).length
  const nolist = S.groups.filter(g => S.mappings[g.key]?.src && S.status.counts?.[g.key] === 0).length
  const nologo = S.status.logos ? S.groups.filter(g => S.mappings[g.key]?.src && !S.status.logos[g.key]).length : 0
  const chips = [
    ['unmatched', `Unmatched ${unmatched}`],
    ['matched', `Matched ${matched}`],
    ...(auto ? [['auto', `Auto ${auto}`]] : []),
    ...(nolist ? [['nolist', `⚠ No listings ${nolist}`]] : []),
    ...(ignored ? [['ignored', `No guide ${ignored}`]] : []),
    ...(nologo ? [['nologo', `No logo ${nologo}`]] : []),
    ['all', `All ${total}`]
  ]
  const groupNames = [...new Set(S.groups.flatMap(g => g.groups))].sort()
  $('#chips').innerHTML =
    chips.map(([k, l]) => `<button class="chip ${S.filter === k ? 'on' : ''}" data-f="${k}">${esc(l)}</button>`).join('') +
    (groupNames.length
      ? `<select class="chip ${S.filter.startsWith('grp:') ? 'on' : ''}" id="grpSel" style="width:auto">
          <option value="">Group…</option>${groupNames.map(n => `<option value="${esc(n)}" ${S.filter === 'grp:' + n ? 'selected' : ''}>${esc(n)}</option>`).join('')}
        </select>`
      : '')
  $('#stats').textContent = total ? `${matched}/${total} matched` : ''
}

function rowHtml(g) {
  const m = S.mappings[g.key]
  let match
  if (m && !m.src) {
    match = `<div class="match none">No guide (skipped)</div>`
  } else if (m) {
    const src = S.byKey.get(m.src)
    const cnt = S.status.counts?.[g.key]
    const warn = cnt === 0 && !isDirtyKey(g.key)
    match = src
      ? `<div class="match ${warn ? 'bad' : 'ok'}">${warn ? '⚠ no listings · ' : m.auto ? '✓ auto · ' : '✓ '}${esc(srcLabel(src))}${offLabel(m.offset)}</div>`
      : `<div class="match bad">⚠ source no longer available</div>`
  } else {
    const s = sugFor(g)[0]
    match = s
      ? `<div class="match sug">Suggested: ${esc(srcLabel(s.src))}${offLabel(s.offset)}</div>`
      : `<div class="match none">No match yet — tap to search</div>`
  }
  const variants = g.names.length > 1 ? ` · +${g.names.length - 1} variant${g.names.length > 2 ? 's' : ''}` : ''
  const id = g.tvgId ? `tvg-id ${g.tvgId}` : 'no tvg-id (matched by name)'
  // the logo your guide actually gives this channel
  const url = (m?.src && S.status.logos?.[g.key]) || ''
  const logo = url ? ` style="background-image:url('${esc(url)}')"` : ''
  return `<div class="row ${isDirtyKey(g.key) ? 'dirty' : ''}" data-k="${esc(g.key)}">
    <div class="logo"${logo}></div>
    <div class="body"><div class="name">${esc(g.names[0])}</div><div class="meta">${esc(id)}${variants}</div>${match}</div>
  </div>`
}

function render() {
  renderChips()
  $('#saveBtn').disabled = !dirty() || !S.token
  const n = Object.keys(S.mappings).length
  $('#saveBtn').textContent = dirty() ? `Save changes` : 'Saved'
  if (!S.groups.length) {
    $('#main').innerHTML = setupHtml(true)
    return
  }
  const list = filtered()
  const head = !S.token ? setupHtml(false) : ''
  if (!list.length) {
    $('#main').innerHTML = head + `<div class="empty">${S.filter === 'unmatched' && !S.q ? '🎉 Everything is matched' : 'Nothing here'}</div>`
    return
  }
  $('#main').innerHTML =
    head +
    list.slice(0, S.shown).map(rowHtml).join('') +
    (list.length > S.shown ? `<button class="more" id="moreBtn">Show more (${list.length - S.shown} left)</button>` : '')
}

function setupHtml(noChannels) {
  if (!S.token) {
    return `<div class="card">
      <h2>Connect to GitHub</h2>
      <p>To save matches, this page needs a GitHub token for your guide repo. It's stored only on this device.</p>
      <ol>
        <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → new fine-grained token</a></li>
        <li>Repository access: <b>Only select repositories</b> → ${esc(S.repo || 'your guide repo')}</li>
        <li>Permissions → Repository → <b>Contents: Read and write</b> (nothing else)</li>
        <li>Set an <b>expiration</b> date</li>
        <li>Generate, copy and paste it below</li>
      </ol>
      <input type="password" id="tokIn" placeholder="github_pat_…" autocomplete="off">
      ${S.repo ? '' : '<input type="text" id="repoIn" placeholder="owner/repo" style="margin-top:8px">'}
      <div class="inline"><button class="primary" id="tokSave">Connect</button></div>
    </div>`
  }
  if (noChannels) {
    return `<div class="card">
      <h2>No channel list yet</h2>
      <p>Add your playlist link as the <b>M3U_URL</b> secret in the repo (Settings → Secrets and variables → Actions) and the list will load after the next build. Or upload an .m3u file now:</p>
      <div class="inline"><button class="primary" id="uploadBtn2">Upload playlist file</button></div>
    </div>`
  }
  return ''
}

// ---------- sheet ----------
let sheetKey = null
function openSheet(key) {
  sheetKey = key
  const g = S.groups.find(x => x.key === key)
  const m = S.mappings[key]
  $('#sheetHead').innerHTML = `<div class="name">${esc(g.names[0])}</div>
    <div class="meta" style="white-space:normal">${g.tvgId ? 'tvg-id ' + esc(g.tvgId) : 'no tvg-id'}${g.names.length > 1 ? ' · also: ' + esc(g.names.slice(1).join(', ')) : ''}</div>
    <div class="inline">
      <select id="offSel">${[-2, -1, 0, 1, 2].map(o => `<option value="${o}" ${(m?.offset || 0) === o ? 'selected' : ''}>${o === 0 ? 'No time shift' : (o > 0 ? '+' : '') + o + ' hour' + (Math.abs(o) > 1 ? 's' : '')}</option>`).join('')}</select>
      ${m?.src || !m ? '<button id="clearBtn">No guide</button>' : '<button id="clearBtn">Undo skip</button>'}
      <button class="ghost" id="closeBtn">Done</button>
    </div>
    <input type="search" id="sq" placeholder="Search all guide sources…" style="margin-top:8px" autocomplete="off">`
  renderSheetBody('')
  $('#sheet').classList.add('open')
  $('#sheetBg').classList.add('open')
  $('#sq').addEventListener('input', e => renderSheetBody(e.target.value))
  $('#offSel').addEventListener('change', e => {
    if (S.mappings[key]?.src) {
      const { auto, ...rest } = S.mappings[key]
      S.mappings[key] = { ...rest, offset: Number(e.target.value) }
      afterChange()
    }
  })
  $('#closeBtn').onclick = closeSheet
  $('#clearBtn').onclick = () => {
    if (m && !m.src) delete S.mappings[key]
    else S.mappings[key] = { src: null }
    afterChange()
    closeSheet()
  }
}
function renderSheetBody(q) {
  const g = S.groups.find(x => x.key === sheetKey)
  const m = S.mappings[sheetKey]
  const opt = (src, extra = '', off = null) => `<div class="opt ${m?.src === src.k ? 'cur' : ''}" data-src="${esc(src.k)}" ${off != null ? `data-off="${off}"` : ''}>
    <div class="body"><div class="name">${esc(src.n)}</div><div class="meta">${esc(src.s)}${src.r ? ' · ' + esc(src.r) : ''}${src.x ? ' · ' + esc(src.x) : ''}</div></div>
    <div class="score">${extra}</div></div>`
  let html = ''
  if (!q.trim()) {
    if (m && S.byKey.get(m.src)) html += `<div class="sec">Current</div>` + opt(S.byKey.get(m.src), '✓')
    const sugs = sugFor(g)
    html += `<div class="sec">Suggestions</div>` + (sugs.length
      ? sugs.map(s => opt(s.src, (s.offset ? `+${s.offset}h · ` : '') + Math.round(Math.min(s.score, 100)) + '%', s.offset)).join('')
      : `<div class="meta" style="padding:6px 2px">No close matches — search below.</div>`)
  } else {
    const raw = q.trim().toLowerCase()
    const nk = normalizeName(q).key
    const hits = S.sources.filter(s => s.n.toLowerCase().includes(raw) || (nk && s._key.includes(nk)) || (s.x || '').toLowerCase().includes(raw))
      .sort((a, b) => (a._key === nk ? -1 : 0) - (b._key === nk ? -1 : 0) || a.n.length - b.n.length)
      .slice(0, 60)
    html += `<div class="sec">${hits.length ? 'Results' : 'No results'}</div>` + hits.map(s => opt(s)).join('')
  }
  $('#sheetBody').innerHTML = html
}
function closeSheet() {
  $('#sheet').classList.remove('open')
  $('#sheetBg').classList.remove('open')
  sheetKey = null
}
function afterChange() {
  const y = window.scrollY
  render()
  window.scrollTo(0, y)
}

// ---------- actions ----------
function autoMatch() {
  let n = 0
  for (const g of S.groups) {
    if (S.mappings[g.key]) continue
    const s = sugFor(g)[0]
    if (s && s.score >= AUTO_THRESHOLD) {
      S.mappings[g.key] = { src: s.src.k, ...(s.offset ? { offset: s.offset } : {}), auto: true }
      n++
    }
  }
  afterChange()
  toast(n ? `Matched ${n} channel${n > 1 ? 's' : ''} — check them, then tap Save` : 'No confident matches left — the rest need picking by hand')
}

async function save() {
  if (!S.token) return toast('Connect GitHub first')
  const btn = $('#saveBtn')
  btn.disabled = true
  btn.textContent = 'Saving…'
  try {
    const sorted = Object.fromEntries(Object.entries(S.mappings).sort(([a], [b]) => a.localeCompare(b)))
    const text = JSON.stringify({ version: 1, map: sorted }, null, 1) + '\n'
    try {
      S.mapSha = await putFile('mappings.json', text, S.mapSha, 'Update channel matches')
    } catch (e) {
      if (!String(e.message).match(/409|does not match/)) throw e
      // Saved from another device meanwhile: merge, theirs first then ours
      const cur = await getFile('mappings.json')
      const theirs = cur.text ? JSON.parse(cur.text).map || {} : {}
      const before = JSON.parse(S.saved)
      for (const k of Object.keys(before)) if (!(k in S.mappings)) delete theirs[k]
      S.mappings = { ...theirs, ...S.mappings }
      const t2 = JSON.stringify({ version: 1, map: Object.fromEntries(Object.entries(S.mappings).sort(([a], [b]) => a.localeCompare(b))) }, null, 1) + '\n'
      S.mapSha = await putFile('mappings.json', t2, cur.sha, 'Update channel matches')
    }
    S.saved = JSON.stringify(S.mappings)
    render()
    toast(`Saved ✓ The guide link updates automatically in about 10–30 minutes. <a href="https://github.com/${S.repo}/actions" target="_blank" rel="noopener">Progress</a>`, 7000)
  } catch (e) {
    toast('Save failed: ' + esc(e.message), 6000)
    render()
  }
}

async function uploadPlaylist(file) {
  try {
    const text = await file.text()
    const chans = parseM3U(text).map(c => ({ name: c.name, tvgId: c.tvgId, group: c.group, logo: safeLogo(c.logo, S.config.logoHosts) }))
    if (!chans.length) return toast('No live channels found in that file')
    const cur = await getFile('data/channels.json')
    await putFile('data/channels.json', JSON.stringify(chans, null, 0).replace(/},{/g, '},\n{') + '\n', cur.sha, 'Update channel list')
    toast(`Uploaded ${chans.length} channels (stream links are not saved)`)
    load()
  } catch (e) {
    toast('Upload failed: ' + esc(e.message), 6000)
  }
}

function menu() {
  const key = '__menu'
  sheetKey = key
  $('#sheetHead').innerHTML = `<div class="name">Options</div>`
  $('#sheetBody').innerHTML = `
    <div class="opt" id="mUpload"><div class="body"><div class="name">Upload playlist file</div><div class="meta">Replace the channel list from an .m3u file</div></div></div>
    <div class="opt" id="mReload"><div class="body"><div class="name">Reload</div><div class="meta">Fetch the latest list and matches</div></div></div>
    <div class="opt" id="mRepo"><div class="body"><div class="name">Repository</div><div class="meta">${esc(S.repo || 'not set')}</div></div></div>
    ${S.status.built ? `<div class="meta" style="padding:8px 4px">Guide last built ${esc(new Date(S.status.built).toLocaleString())}</div>` : ''}
    ${S.token ? `<div class="opt" id="mLogout"><div class="body"><div class="name" style="color:var(--bad)">Disconnect this device</div><div class="meta">Forget the GitHub token</div></div></div>` : ''}
    <button class="ghost more" id="mClose">Close</button>`
  $('#sheet').classList.add('open')
  $('#sheetBg').classList.add('open')
  $('#mUpload').onclick = () => { closeSheet(); if (!S.token) return toast('Connect GitHub first'); $('#fileIn').click() }
  $('#mReload').onclick = () => { closeSheet(); load() }
  $('#mRepo').onclick = () => {
    const r = prompt('GitHub repository (owner/repo)', S.repo)
    if (r) { S.repo = r.trim(); store.set(LS.repo, S.repo); closeSheet(); load() }
  }
  if ($('#mLogout')) $('#mLogout').onclick = () => { store.set(LS.token, ''); S.token = ''; closeSheet(); load() }
  $('#mClose').onclick = closeSheet
}

// ---------- events ----------
$('#epgUrl').textContent = new URL('guide.xml.gz', location.href).href
$('#copyBtn').onclick = async () => {
  try { await navigator.clipboard.writeText($('#epgUrl').textContent); toast('Guide link copied') } catch { toast('Long-press the link to copy it') }
}
let qt
$('#q').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { S.q = e.target.value; S.shown = 80; render() }, 150) })
$('#chips').addEventListener('click', e => {
  const f = e.target.closest('[data-f]')?.dataset.f
  if (f) { S.filter = f; S.shown = 80; render(); window.scrollTo(0, 0) }
})
$('#chips').addEventListener('change', e => {
  if (e.target.id === 'grpSel') { S.filter = e.target.value ? 'grp:' + e.target.value : 'all'; S.shown = 80; render() }
})
$('#main').addEventListener('click', e => {
  const row = e.target.closest('.row')
  if (row) return openSheet(row.dataset.k)
  if (e.target.id === 'retryBtn') return location.reload()
  if (e.target.id === 'moreBtn') { S.shown += 120; afterChange() }
  if (e.target.id === 'uploadBtn2') $('#fileIn').click()
  if (e.target.id === 'tokSave') {
    const t = $('#tokIn').value.trim()
    if ($('#repoIn')) { S.repo = $('#repoIn').value.trim(); store.set(LS.repo, S.repo) }
    if (!t || !S.repo) return toast('Enter the token' + (S.repo ? '' : ' and repo'))
    S.token = t
    store.set(LS.token, t)
    load()
  }
})
$('#sheetBody').addEventListener('click', e => {
  const o = e.target.closest('[data-src]')
  if (!o || !sheetKey || sheetKey === '__menu') return
  const sel = Number($('#offSel')?.value || 0)
  const off = o.dataset.off != null ? Number(o.dataset.off) : sel
  S.mappings[sheetKey] = off ? { src: o.dataset.src, offset: off } : { src: o.dataset.src }
  afterChange()
  closeSheet()
})
$('#sheetBg').onclick = closeSheet
$('#autoBtn').onclick = autoMatch
$('#saveBtn').onclick = save
$('#menuBtn').onclick = menu
$('#fileIn').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadPlaylist(f) })
window.addEventListener('beforeunload', e => { if (dirty()) { e.preventDefault(); e.returnValue = '' } })

load()
