import { spawn } from 'node:child_process'
import process from 'node:process'
import path from 'node:path'

const viteBin = path.resolve(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js')
const viteHost = process.env.UI_HOST || '0.0.0.0'
const api = spawn(process.execPath, ['server/index.mjs'], { stdio: 'inherit', env: process.env, shell: false })
const vite = spawn(process.execPath, [viteBin, '--host', viteHost], { stdio: 'inherit', env: process.env, shell: false })

let shuttingDown = false
function fail(label, error) {
  if (shuttingDown) return
  console.error(`${label} no pudo iniciar: ${error.message}`)
  shutdown(1)
}
function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  if (!api.killed) api.kill()
  if (!vite.killed) vite.kill()
  setTimeout(() => process.exit(code), 60)
}

api.on('error', error => fail('API', error))
vite.on('error', error => fail('Vite', error))
api.on('exit', code => { if (!shuttingDown && code && code !== 0) shutdown(code) })
vite.on('exit', code => { if (!shuttingDown && code && code !== 0) shutdown(code) })
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
