const fs = require('fs')
const path = require('path')
const { initListener } = require('../src/event-listener')
const { startInspector, recordMessage } = require('../src/inspector')

const dumpPath = path.join(__dirname, '..', 'packets.jsonl')
const dump = fs.createWriteStream(dumpPath, { flags: 'a' })
const toJson = (key, value) => {
    if (key === 'raw') return undefined
    if (typeof value === 'bigint') return value.toString()
    return value
}

startInspector()
console.log('Reading packets only. The bot will not click or cast.')
console.log(`Every message is also written to ${dumpPath}`)

const listener = initListener({
    readyMessage: 'Listening. Packets show up on the packet map above.',
})

for (const kind of ['event', 'request', 'response']) {
    listener.on(kind, (message) => {
        dump.write(JSON.stringify({ t: Date.now(), kind, ...message }, toJson) + '\n')
        recordMessage(kind, message)
    })
}
