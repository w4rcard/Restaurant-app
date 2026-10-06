import http from 'node:http'
import { readState, writeState, getDbPath, integrityCheck, checkpoint } from './db.mjs'
import fs from 'node:fs'

const HOST = process.env.HOST || '0.0.0.0'
const PORT = Number(process.env.API_PORT || 8787)
const MAX_BODY = 10 * 1024 * 1024
const clients = new Set()

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    let settled = false
    const fail = error => { if (!settled) { settled = true; reject(error) } }
    req.setEncoding('utf8')
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk)
      if (size > MAX_BODY) {
        fail(new Error('Cuerpo demasiado grande'))
        req.destroy()
        return
      }
      body += chunk
    })
    req.on('end', () => { if (!settled) { settled = true; resolve(body) } })
    req.on('error', fail)
    req.on('aborted', () => fail(new Error('Solicitud abortada')))
  })
}

function publishState(result) {
  const payload = `event: state\ndata: ${JSON.stringify(result.store)}\n\n`
  for (const response of clients) {
    try { response.write(payload) } catch { clients.delete(response) }
  }
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  })
  res.write(': connected\n\n')
  const current = readState()
  if (current) res.write(`event: state\ndata: ${JSON.stringify(current.store)}\n\n`)
  clients.add(res)
  req.on('close', () => clients.delete(res))
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' })
    res.end()
    return
  }
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`)

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const integrity = integrityCheck()
    sendJson(res, integrity === 'ok' ? 200 : 503, { ok: integrity === 'ok', database: getDbPath(), clients: clients.size, integrity })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/backup') {
    try {
      const dbPath = getDbPath()
      checkpoint()
      res.writeHead(200, {
        'Content-Type': 'application/x-sqlite3',
        'Content-Disposition': 'attachment; filename=restaurante-v8-backup.db',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      })
      fs.createReadStream(dbPath).pipe(res)
    } catch {
      sendJson(res, 500, { error: 'No se pudo crear el respaldo' })
    }
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const state = readState()
    sendJson(res, 200, state || { store: null, updatedAt: null, version: null })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    handleEvents(req, res)
    return
  }

  if (req.method === 'PUT' && url.pathname === '/api/state') {
    try {
      const raw = await readBody(req)
      const payload = JSON.parse(raw || '{}')
      const result = writeState(payload.store, { initializeOnly: Boolean(payload.initializeOnly) })
      publishState(result)
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Error guardando estado' })
    }
    return
  }

  sendJson(res, 404, { error: 'Ruta no encontrada' })
})

server.listen(PORT, HOST, () => {
  console.log(`API local: http://${HOST}:${PORT}`)
  console.log(`SQLite: ${getDbPath()}`)
})

process.on('SIGINT', () => server.close(() => process.exit(0)))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
