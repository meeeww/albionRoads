// Lists every value in packets.jsonl that looks like a time in the future, to find which
// message carries a Roads portal's closing time. Run after a capture: npm run find-timers
const fs = require('fs')
const path = require('path')

const TICKS_AT_EPOCH = 621355968000000000n
const HOUR = 3600 * 1000

// Albion sends times as .NET ticks (100 ns since year 1), as 18-digit numbers or strings.
const asTime = (value) => {
    if (!/^63\d{16}$/.test(String(value))) return null
    return Number((BigInt(value) - TICKS_AT_EPOCH) / 10000n)
}

const found = []
const walk = (value, keyPath, message) => {
    if (Array.isArray(value)) return value.forEach((item, i) => walk(item, `${keyPath}[${i}]`, message))
    if (value && typeof value === 'object') return Object.entries(value).forEach(([k, v]) => walk(v, `${keyPath}.${k}`, message))
    const time = asTime(value)
    if (!time) return
    const ahead = time - message.t
    if (ahead > 60 * 1000 && ahead < 48 * HOUR) found.push({ message, keyPath, ahead })
}

const file = path.join(__dirname, '..', 'packets.jsonl')
const unread = { undecoded: 0, encrypted: 0 }
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.kind in unread) unread[message.kind]++
    walk(message.parameters, 'parameters', message)
}
console.log(`Unreadable messages: ${unread.undecoded} undecoded, ${unread.encrypted} encrypted packets.`)

for (const { message, keyPath, ahead } of found) {
    const code = message.kind === 'event' ? message.parameters[252] : message.parameters[253]
    const h = Math.floor(ahead / HOUR)
    const m = Math.round((ahead % HOUR) / 60000)
    console.log(`${new Date(message.t).toLocaleTimeString()}  ${message.kind} ${code}  ${keyPath}  closes in ${h}h ${m}m`)
    console.log(`  ${JSON.stringify(message.parameters).slice(0, 300)}`)
}
if (!found.length) console.log('No future times found in packets.jsonl.')
