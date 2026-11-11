// Creates the test audio with the ffmpeg inside the running container. Usage: node make-media.mjs [container]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const container = process.argv[2] ?? 'firstmic-e2e'
fs.mkdirSync(new URL('./media', import.meta.url), { recursive: true })
const script = [
  'ffmpeg -loglevel error -y -f lavfi -i sine=frequency=440:duration=4 -c:a libopus /tmp/tone.webm',
  'ffmpeg -loglevel error -y -f lavfi -i sine=frequency=440:duration=60 -ar 48000 -ac 1 /tmp/tone440.wav',
].join(' && ')
execFileSync('docker', ['exec', container, 'sh', '-c', script], { stdio: 'inherit' })
for (const file of ['tone.webm', 'tone440.wav']) {
  execFileSync('docker', ['cp', `${container}:/tmp/${file}`, `media/${file}`], {
    stdio: 'inherit',
    cwd: new URL('.', import.meta.url),
  })
}
console.log('media/tone.webm and media/tone440.wav are ready')
