// Regenerates data/zones.json from the public ao-bin-dumps game data.
// Run again after a game patch that changes the Roads layout.
const fs = require('fs')
const path = require('path')

const BASE = 'https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/cluster/'

const TEMPLATES = 'https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/templates/'
// Unity turns a piece clockwise seen from above; checked by every road's exits connecting over its ground.
const ROT_SIGN = 1

const get = async (file, base = BASE) => {
    const res = await fetch(base + file)
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`)
    return res.text()
}

// Road pieces of one template as [layerId | null, x, z, width, depth, offroad], rotated into the template's frame.
// ROAD and TRANS pieces are the main road, OFFROAD the side paths; BACKDROP pieces (trees, rock walls) are not walkable.
// ponytail: an S-curve or corner counts as its whole bounding box; walls learned while walking cover the rest.
const parseGround = (text) => {
    const tiles = []
    let layer = null
    const pattern = /<layer id="([^"]+)"|<\/layer>|<compoundtile name="_ROADS_[A-Z]+_(ROAD|TRANS|OFFROAD)_[^"]*?(\d+)x(\d+)[^"]*" pos="(-?[\d.]+) -?[\d.]+ (-?[\d.]+)"([^>]*)>/g
    for (const [token, layerId, kind, w, h, x, z, rest] of text.matchAll(pattern)) {
        if (layerId) layer = layerId
        else if (token === '</layer>') layer = null
        else {
            const rot = Number(rest.match(/roty="([^"]+)"/)?.[1] ?? 0)
            const turned = Math.round(rot / 90) % 2 !== 0
            tiles.push([layer, Number(x), Number(z), Number(turned ? h : w), Number(turned ? w : h), kind === 'OFFROAD' ? 1 : 0])
        }
    }
    return tiles
}

// Walkable road surface of a zone layout as [centerX, centerY, width, depth, offroad] rectangles.
const groundOf = (layout, templateGround, sign = ROT_SIGN) => {
    const rects = []
    const pattern = /<templateinstance id="[^"]+" ref="([^"]+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/templateinstance>)/g
    for (const [, ref, attrs, body = ''] of layout.matchAll(pattern)) {
        const tiles = templateGround[ref]
        if (!tiles) continue
        const [px, , pz] = attrs.match(/pos="([^"]+)"/)[1].split(' ').map(Number)
        const rot = Number(attrs.match(/rot="([^"]+)"/)?.[1] || 0)
        const active = new Set([...body.matchAll(/<activelayer id="([^"]+)"/g)].map((m) => m[1]))
        const angle = sign * rot * Math.PI / 180
        const cos = Math.round(Math.cos(angle))
        const sin = Math.round(Math.sin(angle))
        const turned = Math.round(rot / 90) % 2 !== 0
        for (const [layer, x, z, w, d, offroad] of tiles) {
            if (layer && !active.has(layer)) continue
            rects.push([px + x * cos + z * sin, pz - x * sin + z * cos, turned ? d : w, turned ? w : d, offroad])
        }
    }
    return rects
}

const templateGroundFor = async (refs) => {
    const tree = await (await fetch('https://api.github.com/repos/ao-data/ao-bin-dumps/git/trees/master?recursive=1')).json()
    const paths = {}
    for (const { path: p } of tree.tree) {
        const m = p.match(/^templates\/([^/]+)\/(.+)\.template\.xml$/)
        if (m && (!paths[m[2]] || m[1] === 'NONE')) paths[m[2]] = `${m[1]}/${m[2]}.template.xml`
    }
    const out = {}
    await Promise.all([...refs].filter((ref) => paths[ref]).map(async (ref) => {
        out[ref] = parseGround(await get(paths[ref], TEMPLATES))
    }))
    return out
}

const main = async () => {
    const world = await get('world.xml')

    const zones = {}
    for (const [tag, id, file, name] of world.matchAll(/<cluster id="([^"]+)" file="([^"]+)" displayname="([^"]*)"[^>]*>/g)) {
        const attr = (key) => tag.match(new RegExp(` ${key}="([^"]*)"`))?.[1]
        const numbers = (key) => attr(key)?.split(' ').map(Number)
        zones[id] = { name, file, type: attr('type'), tier: Number(file.match(/_T(\d)_/)?.[1]) || undefined, origin: numbers('origin'), size: numbers('size') }
    }

    const exitSlots = {}
    for (const [, id, body] of world.matchAll(/<cluster id="([^"]+)">([\s\S]*?)<\/cluster>/g)) {
        const slots = [...body.matchAll(/<(tunnelexit|mistscityentrance) path="([^"/]+)\//g)]
            .map(([, kind, slot]) => ({ kind, slot }))
        if (slots.length && zones[id] && id.startsWith('TNL-')) exitSlots[id] = slots
    }
    // Many roads reuse another road's layout file (TNL-341 uses TNL-141's), and world.xml lists
    // the exits only under the road that owns the file, so share them by file.
    const slotsByFile = {}
    for (const [id, slots] of Object.entries(exitSlots)) slotsByFile[zones[id].file] = slots
    for (const [id, zone] of Object.entries(zones)) {
        if (!exitSlots[id] && id.startsWith('TNL-') && slotsByFile[zone.file]) exitSlots[id] = slotsByFile[zone.file]
    }

    const ids = Object.keys(exitSlots)
    console.log(`${Object.keys(zones).length} zones, ${ids.length} with road exits`)

    const layouts = {}
    for (let i = 0; i < ids.length; i += 16) {
        await Promise.all(ids.slice(i, i + 16).map(async (id) => {
            const layout = await get(zones[id].file)
            layouts[zones[id].file] = layout
            const positions = {}
            const pieces = []
            for (const [, slot, ref, x, y] of layout.matchAll(/<templateinstance id="([^"]+)" ref="([^"]+)"[^>]*? pos="(-?[\d.]+) -?[\d.]+ (-?[\d.]+)"/g)) {
                positions[slot] = [Number(x), Number(y)]
                // S_ and M_ pieces are 80 and 280 units square; the ROAD_ base spans the whole zone.
                const size = { S: 80, M: 280 }[ref[0]]
                const kind = ref.match(/_(Portal|RES|PVE|DNG|Sleeve|EMPTY)/)?.[1]
                if (size) pieces.push({ x: Number(x), y: Number(y), size, kind })
            }
            zones[id].pieces = pieces
            zones[id].exits = exitSlots[id]
                .filter(({ slot }) => positions[slot])
                .map(({ kind, slot }) => ({ slot, kind, x: positions[slot][0], y: positions[slot][1] }))
        }))
    }

    const refs = new Set(Object.values(layouts).flatMap((layout) => [...layout.matchAll(/ref="([^"]+)"/g)].map((m) => m[1])))
    const templateGround = await templateGroundFor(refs)
    const ground = {}
    for (const [file, layout] of Object.entries(layouts)) ground[file] = groundOf(layout, templateGround)

    const out = {}
    for (const [id, { name, type, tier, origin, size, exits, pieces, file }] of Object.entries(zones)) {
        out[id] = exits ? { name, type, tier, origin, size, exits, pieces, layout: file } : { name }
    }
    const dataDir = path.join(__dirname, '..', 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'zones.json'), JSON.stringify(out))
    fs.writeFileSync(path.join(dataDir, 'ground.json'), JSON.stringify(ground))
    console.log(`Wrote zones.json and ground.json (${Object.keys(ground).length} layouts) to ${dataDir}`)
    return { zones: out, ground, layouts, templateGround }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message)
        process.exit(1)
    })
}

module.exports = { main, groundOf }
