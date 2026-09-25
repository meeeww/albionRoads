const http = require('http')
const { networkInterfaces } = require('os')
const zones = require('../data/zones.json')
const { exitsOf, STALE_MS } = require('./roads')
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
        exits: exitsOf(id).map((exit) => ({ ...exit, link: tracker.linkOf(id, exit.slot) })),
    }
}

const state = (tracker) => {
    const edges = new Map()
    for (const [key, link] of tracker.links) {
        if (Date.now() - link.t > STALE_MS) continue
        const zone = key.split('|')[0]
        const id = [zone, link.zone].sort().join('~')
        if (!edges.has(id) || edges.get(id).t < link.t) edges.set(id, { a: zone, b: link.zone, t: link.t })
    }
    const ids = new Set([...edges.values()].flatMap(({ a, b }) => [a, b]))
    if (tracker.zone) ids.add(tracker.zone)
    const out = {}
    for (const id of ids) out[id] = zoneInfo(tracker, id)
    return { current: tracker.zone, pos: tracker.pos, zones: out, edges: [...edges.values()] }
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
        } else if (url.pathname === '/api/zone') {
            const id = url.searchParams.get('id') || ''
            const { walked, blocked } = tracker.trails.of(id)
            json({ id, ...zoneInfo(tracker, id), cell: CELL, walked: [...walked], blocked: [...blocked] })
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
  <p>Known roads and the portals between them. Links older than 3 hours drop off. Select a road to see its layout.</p>
</header>
<main>
  <section>
    <div class="row"><h2>Network</h2><span class="muted" id="summary"></span></div>
    <canvas id="net" width="900" height="900"></canvas>
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
    <ul id="exits"></ul>
  </section>
</main>
<script>
const TIER = { 4: '#7dcea0', 5: '#7eb6ff', 6: '#b48ef0', 7: '#e39b54', 8: '#d36b6b' }
const PIECE = { Portal: '#6a5a2c', RES: '#2f4a2a', PVE: '#4a2a2a', DNG: '#3b2d4d' }
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

const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? m + 'm ago' : (m / 60).toFixed(1) + 'h ago' }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

async function refresh() {
  data = await fetch('/api/state').then((r) => r.json())
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
  document.getElementById('exits').innerHTML = zoneData.exits.map((e, i) => {
    const where = e.kind === 'mistscityentrance' ? '<span class="muted">mists city entrance</span>'
      : e.link ? '<a data-zone="' + esc(e.link.zone) + '">' + esc(data.zones[e.link.zone]?.name || e.link.zone) + '</a> <span class="muted">' + ago(e.link.t) + '</span>'
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
  view = { scale: (net.width - 160) / span, x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
  const px = (n) => [net.width / 2 + (n.x - view.x) * view.scale, net.height / 2 + (n.y - view.y) * view.scale]

  nctx.lineWidth = 3
  for (const e of data.edges) {
    const a = nodes[e.a], b = nodes[e.b]
    if (!a || !b) continue
    const age = (Date.now() - e.t) / (3 * 3600 * 1000)
    nctx.strokeStyle = 'rgba(226, 197, 106, ' + Math.max(0.25, 1 - age) + ')'
    nctx.beginPath(); nctx.moveTo(...px(a)); nctx.lineTo(...px(b)); nctx.stroke()
  }
  nctx.font = '22px sans-serif'
  nctx.textAlign = 'center'
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

net.onclick = (event) => {
  const rect = net.getBoundingClientRect()
  const x = (event.clientX - rect.left) * net.width / rect.width
  const y = (event.clientY - rect.top) * net.height / rect.height
  let best = null, bestD = 40
  for (const [id, n] of Object.entries(nodes)) {
    const d = Math.hypot(net.width / 2 + (n.x - view.x) * view.scale - x, net.height / 2 + (n.y - view.y) * view.scale - y)
    if (d < bestD) { best = id; bestD = d }
  }
  if (best) { selected = best; loadZone(best) }
}

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
  for (const p of z.pieces) if (p.kind === 'DNG') label('dungeon', p.x, p.y, '#b48ef0')
  zctx.fillStyle = 'rgba(231, 225, 209, 0.55)'
  for (const key of z.walked) { const [cx, cy] = key.split(',').map(Number); zctx.fillRect(cx * z.cell, cy * z.cell, z.cell, z.cell) }
  zctx.fillStyle = '#d36b6b'
  for (const key of z.blocked) { const [cx, cy] = key.split(',').map(Number); zctx.fillRect(cx * z.cell, cy * z.cell, z.cell, z.cell) }
  z.exits.forEach((e, i) => {
    zctx.fillStyle = e.link ? '#e2c56a' : '#8f8874'
    zctx.beginPath(); zctx.arc(e.x, e.y, 14, 0, Math.PI * 2); zctx.fill()
    const name = e.kind === 'mistscityentrance' ? 'mists' : e.link ? (data.zones[e.link.zone]?.name || e.link.zone) : '?'
    label((i + 1) + '. ' + name, e.x, e.y, e.link ? '#e2c56a' : '#b7b09d')
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
