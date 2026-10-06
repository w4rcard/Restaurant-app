import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restaurante-v6-'))
const dbPath = path.join(tempDir, 'smoke.db')
const port = 8799 + Math.floor(Math.random() * 80)
const base = `http://127.0.0.1:${port}`
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const server = spawn(process.execPath, [path.join(projectRoot, 'server', 'index.mjs')], {
  cwd: projectRoot,
  env: { ...process.env, API_PORT: String(port), HOST: '127.0.0.1', DB_PATH: dbPath },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

let spawnError = null
server.once('error', error => {
  spawnError = error
})

const waitForHealth = async () => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`)
      if (response.ok) return response.json()
    } catch {}
    if (spawnError) {
      throw new Error(`No se pudo iniciar el servidor de prueba: ${spawnError.message}`)
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (spawnError) {
    throw new Error(`No se pudo iniciar el servidor de prueba: ${spawnError.message}`)
  }
  throw new Error('El servidor no respondió dentro de 5s')
}

try {
  const health = await waitForHealth()
  assert.equal(health.ok, true)
  assert.equal(health.integrity, 'ok')
  assert.equal(fs.existsSync(dbPath), true)

  const empty = await (await fetch(`${base}/api/state`)).json()
  assert.equal(empty.store, null)

  const store = { version: 6, config: { restaurantName: 'Smoke Test' }, orders: [], sales: [], cash: { isOpen: false } }
  const put = await fetch(`${base}/api/state`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ store }),
  })
  assert.equal(put.ok, true)
  const saved = await put.json()
  assert.equal(saved.store.config.restaurantName, 'Smoke Test')
  assert.equal(saved.store.version, 6)

  const got = await (await fetch(`${base}/api/state`)).json()
  assert.equal(got.store.config.restaurantName, 'Smoke Test')

  const backup = await fetch(`${base}/api/backup`)
  assert.equal(backup.ok, true)
  assert.equal(backup.headers.get('content-type'), 'application/x-sqlite3')
  const backupBytes = new Uint8Array(await backup.arrayBuffer())
  assert.ok(backupBytes.byteLength > 0)
  const backupPath = path.join(tempDir, 'backup.db')
  fs.writeFileSync(backupPath, backupBytes)
  const backupDb = new DatabaseSync(backupPath)
  const backupState = backupDb.prepare("SELECT json_extract(data, '$.config.restaurantName') AS name FROM app_state").get()
  assert.equal(backupState.name, 'Smoke Test')
  backupDb.close()

  await new Promise((resolve, reject) => {
    const request = fetch(`${base}/api/events`)
    const timeout = setTimeout(() => reject(new Error('SSE timeout')), 2000)
    request.then(async response => {
      assert.equal(response.ok, true)
      const reader = response.body.getReader()
      let text = ''
      while (text.length < 50) {
        const { done, value } = await reader.read()
        if (done) break
        text += new TextDecoder().decode(value)
        if (text.includes('event: state')) break
      }
      clearTimeout(timeout)
      assert.ok(text.includes('event: state'))
      reader.cancel().finally(resolve)
    }).catch(reject)
  })

  console.log('V6 server smoke tests: PASS')
} finally {
  server.kill('SIGTERM')
  await new Promise(resolve => setTimeout(resolve, 80))
  fs.rmSync(tempDir, { recursive: true, force: true })
}
