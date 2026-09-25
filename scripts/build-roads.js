// Regenerates data/zones.json from the public ao-bin-dumps game data.
// Run again after a game patch that changes the Roads layout.
const fs = require('fs')
const path = require('path')

const BASE = 'https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/cluster/'

const get = async (file) => {
    const res = await fetch(BASE + file)
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`)
    return res.text()
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

    const ids = Object.keys(exitSlots)
    console.log(`${Object.keys(zones).length} zones, ${ids.length} with road exits`)

    for (let i = 0; i < ids.length; i += 16) {
        await Promise.all(ids.slice(i, i + 16).map(async (id) => {
            const layout = await get(zones[id].file)
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

    const out = {}
    for (const [id, { name, type, tier, origin, size, exits, pieces }] of Object.entries(zones)) {
        out[id] = exits ? { name, type, tier, origin, size, exits, pieces } : { name }
    }
    const outPath = path.join(__dirname, '..', 'data', 'zones.json')
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify(out))
    console.log(`\nWrote ${outPath}`)
}

main().catch((error) => {
    console.error(error.message)
    process.exit(1)
})
