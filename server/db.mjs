import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.resolve(__dirname, '..', 'data')
const dbPath = path.resolve(process.env.DB_PATH || path.join(dataDir, 'restaurante-v8.db'))

fs.mkdirSync(path.dirname(dbPath), { recursive: true })

export const db = new DatabaseSync(dbPath)
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`)

const getStateStatement = db.prepare('SELECT version, data, updated_at FROM app_state WHERE id = 1')
const upsertStateStatement = db.prepare(`
  INSERT INTO app_state (id, version, data, updated_at)
  VALUES (1, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    version = excluded.version,
    data = excluded.data,
    updated_at = excluded.updated_at
`)


function reconcileInventoryStocks(ingredients = [], movements = []) {
  const deltas = new Map()
  for (const movement of movements || []) {
    if (!movement?.ingredientId) continue
    const delta = Number(movement.quantity) || 0
    deltas.set(movement.ingredientId, (deltas.get(movement.ingredientId) || 0) + delta)
  }
  return (ingredients || []).map(ingredient => {
    const fallbackCurrent = Number(ingredient.stock) || 0
    const baseStock = Number.isFinite(Number(ingredient.baseStock)) ? Number(ingredient.baseStock) : fallbackCurrent - (deltas.get(ingredient.id) || 0)
    return { ...ingredient, baseStock, stock: Math.max(0, baseStock + (deltas.get(ingredient.id) || 0)) }
  })
}

function mergeConfig(current = {}, incoming = {}) {
  const cm = current?._updatedAtByField || {}
  const im = incoming?._updatedAtByField || {}
  const hasFieldMeta = Object.keys(cm).length > 0 || Object.keys(im).length > 0
  const result = { ...incoming }
  const meta = { ...im }
  const keys = new Set([...Object.keys(current || {}), ...Object.keys(incoming || {})])
  keys.delete('_updatedAtByField'); keys.delete('updatedAt'); keys.delete('kitchen')
  for (const key of keys) {
    const ct = Number(cm[key]) || (hasFieldMeta ? 0 : Number(current.updatedAt) || 0)
    const it = Number(im[key]) || (hasFieldMeta ? 0 : Number(incoming.updatedAt) || 0)
    if (ct > it) result[key] = current[key]
    meta[key] = Math.max(ct, it)
  }
  const kitchen = { ...(incoming.kitchen || {}) }
  const cKitchen = current.kitchen || {}
  const iKitchen = incoming.kitchen || {}
  const kitchenKeys = new Set([...Object.keys(cKitchen), ...Object.keys(iKitchen)])
  for (const key of kitchenKeys) {
    const metaKey = `kitchen.${key}`
    const ct = Number(cm[metaKey]) || (Object.keys(cm).length || Object.keys(im).length ? 0 : Number(current.updatedAt) || 0)
    const it = Number(im[metaKey]) || (Object.keys(cm).length || Object.keys(im).length ? 0 : Number(incoming.updatedAt) || 0)
    if (ct > it) kitchen[key] = cKitchen[key]
    meta[metaKey] = Math.max(ct, it)
  }
  result.kitchen = kitchen
  result._updatedAtByField = meta
  result.updatedAt = Math.max(Number(current.updatedAt)||0, Number(incoming.updatedAt)||0)
  return result
}

function entityStamp(entity) {
  if (!entity || typeof entity !== 'object') return 0
  return Math.max(Number(entity.updatedAt) || 0, Number(entity.closedAt) || 0, Number(entity.cancelledAt) || 0, Number(entity.createdAt) || 0)
}

function mergeEntityArray(current = [], incoming = []) {
  const map = new Map(current.map(item => [String(item?.id ?? ''), item]))
  for (const item of incoming) {
    if (!item || typeof item !== 'object' || item.id == null) continue
    const id = String(item.id)
    const existing = map.get(id)
    if (!existing || entityStamp(item) >= entityStamp(existing)) map.set(id, item)
  }
  return [...map.values()]
}

function mergeCash(current = {}, incoming = {}) {
  const currentStamp = Number(current.updatedAt) || Number(current.lastClosedAt) || Number(current.openedAt) || 0
  const incomingStamp = Number(incoming.updatedAt) || Number(incoming.lastClosedAt) || Number(incoming.openedAt) || 0
  const winner = incomingStamp >= currentStamp ? incoming : current
  return {
    ...winner,
    movements: mergeEntityArray(current.movements || [], incoming.movements || []),
    closings: mergeEntityArray(current.closings || [], incoming.closings || []),
  }
}

function dedupeSales(store) {
  const sales = Array.isArray(store.sales) ? store.sales : []
  const seenOrderIds = new Set()
  const kept = []
  const skipped = new Set()
  for (const sale of sales) {
    const ids = Array.isArray(sale.orderIds) ? sale.orderIds.map(String) : []
    if (ids.length && ids.some(id => seenOrderIds.has(id))) {
      skipped.add(sale.id)
      continue
    }
    ids.forEach(id => seenOrderIds.add(id))
    kept.push(sale)
  }
  store.sales = kept
  const saleIds = new Set(kept.map(sale => sale.id))
  store.inventoryMovements = (store.inventoryMovements || []).filter(movement => !movement.saleId || saleIds.has(movement.saleId))
  const seenDocumentSales = new Set()
  store.documents = (store.documents || []).filter(document => {
    if (!document?.saleId) return true
    if (seenDocumentSales.has(document.saleId)) return false
    seenDocumentSales.add(document.saleId)
    return saleIds.has(document.saleId)
  })
  store.ingredients = reconcileInventoryStocks(store.ingredients || [], store.inventoryMovements || [])
  return store
}

export function mergeState(current, incoming) {
  if (!current) return incoming
  if (!incoming) return current
  const keys = ['tables','categories','products','orders','ingredients','extras','employees','customers','reservations','sales','documents','inventoryMovements','audit']
  const merged = { ...current, ...incoming, version: 8 }
  for (const key of keys) merged[key] = mergeEntityArray(current[key] || [], incoming[key] || [])
  merged.config = mergeConfig(current.config || {}, incoming.config || {})
  merged.cash = mergeCash(current.cash, incoming.cash)
  delete merged.activeEmployeeId
  if (merged.config) delete merged.config.workMode
  return dedupeSales(merged)
}

export function readState() {
  const row = getStateStatement.get()
  if (!row) return null
  try {
    return { store: JSON.parse(row.data), updatedAt: Number(row.updated_at), version: Number(row.version) }
  } catch {
    return null
  }
}

export function writeState(store, { initializeOnly = false } = {}) {
  if (!store || typeof store !== 'object' || Number(store.version) < 5) throw new Error('Estado de aplicación inválido')
  const current = readState()
  if (initializeOnly && current?.store) return current
  const incoming = JSON.parse(JSON.stringify(store))
  delete incoming.activeEmployeeId
  if (incoming.config) delete incoming.config.workMode
  const nextStore = current?.store ? mergeState(current.store, incoming) : incoming
  const now = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    upsertStateStatement.run(Number(nextStore.version) || 8, JSON.stringify(nextStore), now)
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
  return { store: nextStore, updatedAt: now, version: Number(nextStore.version) || 8 }
}

export function checkpoint() { db.exec('PRAGMA wal_checkpoint(FULL)') }
export function integrityCheck() { const row = db.prepare('PRAGMA integrity_check').get(); return String(row?.integrity_check || '') }
export function getDbPath() { return dbPath }
