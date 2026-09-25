const http = require('http')
const { networkInterfaces } = require('os')
const zones = require('../data/zones.json')
const ground = require('../data/ground.json')
const { exitsOf, expiresOf } = require('./roads')
const { CELL } = require('./road-paths')

const PORT = Number(process.env.ROADS_PORT) || 4790

const zoneInfo = (tracker, id) => {
    const zone = zones[id] || { name: id }
    return {
        name: zone.name,
        tier: zone.tier,
        type: zone.type,
        origin: zone.origin,
        size: zone.size,
        pieces: zone.pieces || [],
        exits: exitsOf(id).map((exit) => ({ ...exit, link: tracker.linkOf(id, exit.slot), closed: tracker.closedAt(id, exit.slot) })),
    }
}

const state = (tracker) => {
    const edges = new Map()
    for (const [key, link] of tracker.links) {
        const [zone, slot] = key.split('|')
        if (!tracker.linkOf(zone, slot)) continue
        const id = [zone, link.zone].sort().join('~')
        if (!edges.has(id) || edges.get(id).t < link.t) {
            edges.set(id, { a: zone, b: link.zone, slot, t: link.t, expires: expiresOf(link), typed: Boolean(link.expires) })
        }
    }
    const ids = new Set([...edges.values()].flatMap(({ a, b }) => [a, b]))
    if (tracker.zone) ids.add(tracker.zone)
    const out = {}
    for (const id of ids) out[id] = zoneInfo(tracker, id)
    return { now: Date.now(), current: tracker.zone, pos: tracker.pos, zones: out, edges: [...edges.values()] }
}

const startRoadMap = (tracker) => {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const json = (body) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(body))
        }
        if (url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(PAGE)
        } else if (url.pathname === '/api/state') {
            json(state(tracker))
        } else if (url.pathname === '/api/timer' && req.method === 'POST') {
            const zone = url.searchParams.get('zone') || ''
            const slot = url.searchParams.get('slot') || ''
            const left = Number(url.searchParams.get('left'))
            if (!tracker.linkOf(zone, slot) || !(left > 0 && left < 48 * 3600 * 1000)) {
                res.writeHead(400)
                return res.end()
            }
            tracker.setTimer(zone, slot, Date.now() + left)
            json({ ok: true })
        } else if (url.pathname === '/api/zone') {
            const id = url.searchParams.get('id') || ''
            const { walked, blocked } = tracker.trails.of(id)
            json({ id, ...zoneInfo(tracker, id), ground: ground[zones[id]?.layout] || [], cell: CELL, walked: [...walked], blocked: [...blocked] })
        } else {
            res.writeHead(404)
            res.end()
        }
    })
    server.listen(PORT, '0.0.0.0', () => {
        const hosts = Object.values(networkInterfaces()).flat().filter((d) => d.family === 'IPv4').map((d) => d.address)
        for (const host of hosts) console.log(`Roads map: http://${host}:${PORT}`)
    })
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Roads map</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 14px/1.4 ui-sans-serif, sans-serif; background: #12140f; color: #e7e1d1; }
  header { padding: 14px 20px 6px; }
  h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
  h2 { font-size: 15px; margin: 0 0 8px; font-weight: 600; }
  p { margin: 0; color: #b7b09d; }
  main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; padding: 8px 20px 24px; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  section { background: #1a1e16; border: 1px solid #2e3426; border-radius: 10px; padding: 12px; }
  canvas { width: 100%; aspect-ratio: 1; display: block; background: #151812; border-radius: 8px; cursor: pointer; }
  ul { margin: 10px 0 0; padding-left: 18px; }
  li { margin: 3px 0; font-variant-numeric: tabular-nums; }
  button { background: #1d2118; color: inherit; border: 1px solid #3a4030; border-radius: 6px; padding: 4px 10px; font: inherit; cursor: pointer; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; }
  .muted { color: #8f8874; }
  .legend span { display: inline-block; margin-right: 12px; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; vertical-align: -1px; }
  a { color: #e2c56a; cursor: pointer; }
</style>
</head>
<body>
<header>
  <h1>Roads map</h1>
  <p>Known roads and the portals between them. Select a road to see its layout.</p>
</header>
<main>
  <section>
    <div class="row"><h2>Network</h2><span class="muted" id="summary"></span></div>
    <canvas id="net" width="900" height="900" style="touch-action:none"></canvas>
    <p class="muted" style="margin:6px 0 0">Drag to move, scroll to zoom, double-click to reset. Times on the links count down to when the portal closes.
      A <b>~</b> time is a 3-hour guess: click it and type the portal's real timer (like 15h26m).</p>
    <p class="legend" style="margin-top:8px">
      <span><i class="dot" style="background:#7dcea0"></i>T4</span>
      <span><i class="dot" style="background:#7eb6ff"></i>T5</span>
      <span><i class="dot" style="background:#b48ef0"></i>T6</span>
      <span><i class="dot" style="background:#e39b54"></i>T7</span>
      <span><i class="dot" style="background:#d36b6b"></i>T8</span>
      <span><i class="dot" style="background:#6b6f63"></i>not a road</span>
      <span><i class="dot" style="border:2px solid #e2c56a"></i>you are here</span>
    </p>
  </section>
  <section>
    <div class="row"><h2 id="zoneTitle">No road selected</h2><button id="rotate" type="button">Rotate 45°</button></div>
    <canvas id="zone" width="900" height="900"></canvas>
    <p id="spots" class="muted"></p>
    <ul id="exits"></ul>
  </section>
</main>
<script>
const TIER = { 4: '#7dcea0', 5: '#7eb6ff', 6: '#b48ef0', 7: '#e39b54', 8: '#d36b6b' }
const PIECE = { Portal: '#6a5a2c', RES: '#2f4a2a', PVE: '#4a2a2a', DNG: '#3b2d4d' }
// What spawns at a piece, from its layout name: RES_OreRock, PVE_SOLO (a boss that drops a chest), DNG_GROUP_Entrance.
// Icons come from the QRadar project; solo/group/raid use its green/blue/gold variants.
const ICONS = 'https://raw.githubusercontent.com/FashionFlora/Albion-Online-Radar-QRadar/main/images/Resources/'
const RESOURCE_ICON = { Ore: 'ore', Rock: 'rock', Wood: 'Logs', Fiber: 'fiber', Hide: 'hide' }
const CHEST_ICON = { SOLO: 'green', GROUP: 'blue', RAID: 'legendary' }
const DUNGEON_ICON = { SOLO: 'dungeon_1', GROUP: 'dungeon_2', RAID: 'dungeon_4' }
const spotOf = (p, tier) => {
  const res = p.name?.match(/^RES_([A-Z][a-z]+)([A-Z][a-z]+)$/)
  if (res) return { group: 'Resources', text: res[1] + ' + ' + res[2], icons: [res[1], res[2]].map((kind) => RESOURCE_ICON[kind] + '_' + (tier || 4) + '_0') }
  const pve = p.name?.match(/^PVE_(SOLO|GROUP|RAID)$/)
  if (pve) return { group: 'Chests', text: pve[1].toLowerCase() + ' chest', icons: [CHEST_ICON[pve[1]]] }
  const dng = p.name?.match(/^DNG_(SOLO|GROUP|RAID)_Entrance$/)
  if (dng) return { group: 'Dungeons', text: dng[1].toLowerCase() + ' dungeon', icons: [DUNGEON_ICON[dng[1]]] }
  return null
}
const images = {}
const iconImage = (name) => {
  if (!images[name]) {
    images[name] = new Image()
    images[name].crossOrigin = 'anonymous'
    images[name].onload = () => drawZone()
    images[name].src = ICONS + name + '.png'
  }
  return images[name]
}
const iconsHtml = (spot) => spot.icons.map((name) => '<img src="' + ICONS + name + '.png" alt="' + esc(spot.text) + '" title="' + esc(spot.text) + '" width="28" height="28" style="vertical-align:middle">').join('')
const net = document.getElementById('net')
const nctx = net.getContext('2d')
const zoneCanvas = document.getElementById('zone')
const zctx = zoneCanvas.getContext('2d')
let data = { zones: {}, edges: [] }
let selected = null
// The game camera looks at the world turned 45°, the same angle albionRadar clicks with.
let rotation = 45
let zoneData = null
const nodes = {}
let view = { scale: 1, x: 0, y: 0 }
// User pan (canvas pixels) and zoom on top of the automatic fit.
let pan = [0, 0]
let zoom = 1
// Server clock minus this device's clock, so countdowns are right on a phone with a different time.
let clockSkew = 0
const nodePx = (n) => [net.width / 2 + (n.x - view.x) * view.scale + pan[0], net.height / 2 + (n.y - view.y) * view.scale + pan[1]]
const countdown = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return Math.floor(s / 3600) + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
}

const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? m + 'm ago' : (m / 60).toFixed(1) + 'h ago' }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

async function refresh() {
  data = await fetch('/api/state').then((r) => r.json())
  clockSkew = data.now - Date.now()
  for (const id of Object.keys(data.zones)) {
    if (nodes[id]) continue
    const edge = data.edges.find((e) => e.a === id || e.b === id)
    const other = edge && nodes[edge.a === id ? edge.b : edge.a]
    nodes[id] = { x: (other ? other.x : 0) + Math.random() * 60 - 30, y: (other ? other.y : 0) + Math.random() * 60 - 30, vx: 0, vy: 0 }
  }
  for (const id of Object.keys(nodes)) if (!data.zones[id]) delete nodes[id]
  if (!selected && data.current) selected = data.current
  document.getElementById('summary').textContent = Object.keys(data.zones).length + ' zones, ' + data.edges.length + ' links'
  if (selected) await loadZone(selected)
}

async function loadZone(id) {
  zoneData = await fetch('/api/zone?id=' + encodeURIComponent(id)).then((r) => r.json())
  const known = zoneData.exits.filter((e) => e.link).length
  document.getElementById('zoneTitle').textContent = zoneData.name + (zoneData.exits.length ? ' (' + known + '/' + zoneData.exits.length + ' exits known)' : '')
  const groups = {}
  for (const spot of zoneData.pieces.map((p) => spotOf(p, zoneData.tier)).filter(Boolean)) {
    const counts = groups[spot.group] ||= {}
    counts[spot.text] ||= { spot, n: 0 }
    counts[spot.text].n++
  }
  document.getElementById('spots').innerHTML = Object.values(groups).map((counts) =>
    Object.values(counts).map(({ spot, n }) => '<span style="margin-right:10px">' + iconsHtml(spot) + (n > 1 ? ' ×' + n : '') + '</span>').join('')).join('')
  document.getElementById('exits').innerHTML = zoneData.exits.map((e, i) => {
    const where = e.kind === 'mistscityentrance' ? '<span class="muted">mists city entrance</span>'
      : e.link ? '<a data-zone="' + esc(e.link.zone) + '">' + esc(data.zones[e.link.zone]?.name || e.link.zone) + '</a> <span class="muted">' + ago(e.link.t) + '</span>'
      : e.closed ? '<span style="color:#d36b6b">no portal right now</span> <span class="muted">checked ' + ago(e.closed) + '</span>'
      : '<span class="muted">unknown</span>'
    return '<li>' + (i + 1) + '. (' + e.x + ', ' + e.y + ') → ' + where + '</li>'
  }).join('')
  drawZone()
}

document.getElementById('exits').onclick = (event) => {
  const id = event.target.dataset?.zone
  if (id) { selected = id; loadZone(id) }
}
document.getElementById('rotate').onclick = () => { rotation = (rotation + 45) % 360; drawZone() }

function step() {
  const ids = Object.keys(nodes)
  for (const a of ids) {
    const na = nodes[a]
    for (const b of ids) {
      if (a >= b) continue
      const nb = nodes[b]
      let dx = na.x - nb.x, dy = na.y - nb.y
      const d2 = Math.max(dx * dx + dy * dy, 25)
      const f = 4000 / d2
      const d = Math.sqrt(d2)
      dx /= d; dy /= d
      na.vx += dx * f; na.vy += dy * f; nb.vx -= dx * f; nb.vy -= dy * f
    }
  }
  for (const e of data.edges) {
    const na = nodes[e.a], nb = nodes[e.b]
    if (!na || !nb) continue
    const dx = nb.x - na.x, dy = nb.y - na.y
    const d = Math.hypot(dx, dy) || 1
    const f = (d - 110) * 0.02
    na.vx += dx / d * f; na.vy += dy / d * f; nb.vx -= dx / d * f; nb.vy -= dy / d * f
  }
  for (const id of ids) {
    const n = nodes[id]
    n.vx -= n.x * 0.002; n.vy -= n.y * 0.002
    n.x += n.vx; n.y += n.vy
    n.vx *= 0.6; n.vy *= 0.6
  }
}

function drawNet() {
  step()
  const ids = Object.keys(nodes)
  nctx.clearRect(0, 0, net.width, net.height)
  if (!ids.length) {
    nctx.fillStyle = '#b7b09d'
    nctx.font = '28px sans-serif'
    nctx.fillText('Change zone once to start mapping.', 40, 70)
    return requestAnimationFrame(drawNet)
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const id of ids) { const n = nodes[id]; minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y) }
  const span = Math.max(maxX - minX, maxY - minY, 200)
  view = { scale: (net.width - 160) / span * zoom, x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
  const px = nodePx

  nctx.lineWidth = 3
  nctx.font = '18px sans-serif'
  nctx.textAlign = 'center'
  const now = Date.now() + clockSkew
  for (const e of data.edges) {
    const a = nodes[e.a], b = nodes[e.b]
    if (!a || !b) continue
    const left = e.expires - now
    nctx.strokeStyle = 'rgba(226, 197, 106, ' + Math.max(0.25, left / (e.expires - e.t)) + ')'
    const [ax, ay] = px(a), [bx, by] = px(b)
    nctx.beginPath(); nctx.moveTo(ax, ay); nctx.lineTo(bx, by); nctx.stroke()
    const [mx, my] = [(ax + bx) / 2, (ay + by) / 2]
    const text = (e.typed ? '' : '~') + countdown(left)
    nctx.fillStyle = 'rgba(18, 20, 15, 0.8)'
    nctx.fillRect(mx - nctx.measureText(text).width / 2 - 4, my - 13, nctx.measureText(text).width + 8, 20)
    nctx.fillStyle = left < 15 * 60000 ? '#d36b6b' : '#e2c56a'
    nctx.fillText(text, mx, my + 3)
  }
  nctx.font = '22px sans-serif'
  for (const id of ids) {
    const z = data.zones[id]
    const [x, y] = px(nodes[id])
    nctx.fillStyle = z.exits.length ? (TIER[z.tier] || '#b7b09d') : '#6b6f63'
    nctx.beginPath(); nctx.arc(x, y, 14, 0, Math.PI * 2); nctx.fill()
    if (id === data.current) { nctx.strokeStyle = '#e2c56a'; nctx.lineWidth = 4; nctx.beginPath(); nctx.arc(x, y, 21, 0, Math.PI * 2); nctx.stroke() }
    if (id === selected) { nctx.strokeStyle = '#e7e1d1'; nctx.lineWidth = 2; nctx.beginPath(); nctx.arc(x, y, 26, 0, Math.PI * 2); nctx.stroke() }
    nctx.fillStyle = '#e7e1d1'
    nctx.fillText(z.name, x, y - 32)
    if (z.exits.length) {
      nctx.fillStyle = '#8f8874'
      nctx.fillText(z.exits.filter((e) => e.link).length + '/' + z.exits.length, x, y + 40)
    }
  }
  requestAnimationFrame(drawNet)
}

const canvasPoint = (event) => {
  const rect = net.getBoundingClientRect()
  return [(event.clientX - rect.left) * net.width / rect.width, (event.clientY - rect.top) * net.height / rect.height]
}
// Drag to move, wheel to zoom around the cursor, double-click to reset.
let drag = null
net.onpointerdown = (event) => { drag = { at: canvasPoint(event), moved: false }; net.setPointerCapture(event.pointerId) }
net.onpointermove = (event) => {
  if (!drag) return
  const at = canvasPoint(event)
  if (Math.hypot(at[0] - drag.at[0], at[1] - drag.at[1]) > 4) drag.moved = true
  if (!drag.moved) return
  pan = [pan[0] + at[0] - drag.at[0], pan[1] + at[1] - drag.at[1]]
  drag.at = at
}
net.onpointerup = (event) => {
  const wasDrag = drag?.moved
  drag = null
  if (wasDrag) return
  const [x, y] = canvasPoint(event)
  const edge = data.edges.find((e) => {
    if (!nodes[e.a] || !nodes[e.b]) return false
    const [ax, ay] = nodePx(nodes[e.a]), [bx, by] = nodePx(nodes[e.b])
    return Math.abs((ax + bx) / 2 - x) < 50 && Math.abs((ay + by) / 2 - y) < 16
  })
  if (edge) return askTimer(edge)
  let best = null, bestD = 40
  for (const [id, n] of Object.entries(nodes)) {
    const [nx, ny] = nodePx(n)
    const d = Math.hypot(nx - x, ny - y)
    if (d < bestD) { best = id; bestD = d }
  }
  if (best) { selected = best; loadZone(best) }
}
// "15h26m", "15h", "26m" or "15:26" to milliseconds, or null.
const parseLeft = (text) => {
  const m = String(text).trim().match(/^(?:(\\d+)\\s*h)?\\s*(?:(\\d+)\\s*m?)?$/i) || String(text).trim().match(/^(\\d+):(\\d+)$/)
  const ms = m ? ((Number(m[1]) || 0) * 60 + (Number(m[2]) || 0)) * 60000 : 0
  return ms > 0 ? ms : null
}
async function askTimer(edge) {
  const names = (data.zones[edge.a]?.name || edge.a) + ' ↔ ' + (data.zones[edge.b]?.name || edge.b)
  const answer = prompt('Time left on the portal ' + names + ' (like 15h26m):')
  if (answer == null) return
  const left = parseLeft(answer)
  if (!left) return alert('Could not read "' + answer + '". Use something like 15h26m.')
  const params = new URLSearchParams({ zone: edge.a, slot: edge.slot, left })
  const res = await fetch('/api/timer?' + params, { method: 'POST' })
  if (!res.ok) return alert('The server did not accept that timer.')
  refresh()
}
net.onwheel = (event) => {
  event.preventDefault()
  const factor = Math.exp(-event.deltaY * 0.0015)
  const [x, y] = canvasPoint(event)
  const m = [x - net.width / 2, y - net.height / 2]
  zoom *= factor
  pan = [m[0] - (m[0] - pan[0]) * factor, m[1] - (m[1] - pan[1]) * factor]
}
net.ondblclick = () => { pan = [0, 0]; zoom = 1 }

function drawZone() {
  const z = zoneData
  zctx.setTransform(1, 0, 0, 1, 0, 0)
  zctx.clearRect(0, 0, zoneCanvas.width, zoneCanvas.height)
  if (!z || !z.origin) {
    zctx.fillStyle = '#b7b09d'
    zctx.font = '28px sans-serif'
    zctx.fillText(z ? 'No layout for ' + z.name + '.' : 'Select a road.', 40, 70)
    return
  }
  const [ox, oy] = z.origin, [w, h] = z.size
  const scale = (zoneCanvas.width - 40) / Math.max(w, h) / (rotation % 90 ? Math.SQRT2 : 1)
  zctx.translate(zoneCanvas.width / 2, zoneCanvas.height / 2)
  zctx.rotate(rotation * Math.PI / 180)
  zctx.scale(scale, -scale)
  zctx.translate(-(ox + w / 2), -(oy + h / 2))
  const label = (text, x, y, color) => {
    zctx.save(); zctx.translate(x, y); zctx.scale(1 / scale, -1 / scale); zctx.rotate(-rotation * Math.PI / 180)
    zctx.fillStyle = color; zctx.font = '22px sans-serif'; zctx.textAlign = 'center'; zctx.fillText(text, 0, -18); zctx.restore()
  }

  zctx.strokeStyle = '#2e3426'; zctx.lineWidth = 2 / scale
  zctx.strokeRect(ox, oy, w, h)
  for (const p of z.pieces) {
    zctx.fillStyle = PIECE[p.kind] || '#262b20'
    zctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size)
  }
  for (const [x, y, w, d, offroad] of z.ground) {
    zctx.fillStyle = offroad ? '#343a2a' : '#5a5440'
    zctx.fillRect(x - w / 2, y - d / 2, w, d)
  }
  const ICON_PX = 34
  for (const p of z.pieces) {
    const spot = spotOf(p, z.tier)
    if (!spot) continue
    zctx.save(); zctx.translate(p.x, p.y); zctx.scale(1 / scale, -1 / scale); zctx.rotate(-rotation * Math.PI / 180)
    spot.icons.forEach((name, i) => {
      const image = iconImage(name)
      if (image.complete && image.naturalWidth) zctx.drawImage(image, (i - spot.icons.length / 2) * ICON_PX, -ICON_PX / 2, ICON_PX, ICON_PX)
    })
    zctx.restore()
  }
  zctx.fillStyle = 'rgba(231, 225, 209, 0.55)'
  for (const key of z.walked) { const [cx, cy] = key.split(',').map(Number); zctx.fillRect(cx * z.cell, cy * z.cell, z.cell, z.cell) }
  zctx.fillStyle = '#d36b6b'
  for (const key of z.blocked) { const [cx, cy] = key.split(',').map(Number); zctx.fillRect(cx * z.cell, cy * z.cell, z.cell, z.cell) }
  z.exits.forEach((e, i) => {
    zctx.beginPath(); zctx.arc(e.x, e.y, 14, 0, Math.PI * 2)
    if (e.closed && !e.link) {
      zctx.strokeStyle = '#d36b6b'; zctx.lineWidth = 3 / scale; zctx.stroke()
    } else {
      zctx.fillStyle = e.link ? '#e2c56a' : '#8f8874'; zctx.fill()
    }
    const name = e.kind === 'mistscityentrance' ? 'mists' : e.link ? (data.zones[e.link.zone]?.name || e.link.zone) : e.closed ? 'closed' : '?'
    label((i + 1) + '. ' + name, e.x, e.y, e.link ? '#e2c56a' : e.closed ? '#d36b6b' : '#b7b09d')
  })
  if (z.id === data.current && data.pos) {
    zctx.fillStyle = '#ffffff'
    zctx.beginPath(); zctx.arc(data.pos[0], data.pos[1], 10, 0, Math.PI * 2); zctx.fill()
    label('you', data.pos[0], data.pos[1], '#ffffff')
  }
}

refresh()
setInterval(refresh, 3000)
requestAnimationFrame(drawNet)
</script>
</body>
</html>`

module.exports = { startRoadMap }
