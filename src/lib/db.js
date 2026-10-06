import { reconcileInventoryStocks } from './inventory.js'

const DB_KEY = 'restaurant-db-v8'
const LEGACY_DB_KEY = 'restaurant-db-v7'
const LEGACY_DB_V6_KEY = 'restaurant-db-v6'
const PENDING_KEY = 'restaurant-db-v8-pending-sync'
const LEGACY_PENDING_KEY = 'restaurant-db-v7-pending-sync'
const LEGACY_PENDING_V6_KEY = 'restaurant-db-v6-pending-sync'
const CHANNEL_NAME = 'restaurant-v8-sync'
const API_STATE = '/api/state'
const API_EVENTS = '/api/events'

export const defaultCustomers = []
export const defaultReservations = []

export const defaultEmployees = [
  { id: 'emp-admin', name: 'Administrador', role: 'Administrador', active: true, pin: '2468' },
  { id: 'emp-mesero', name: 'Mesero principal', role: 'Mesero', active: true, pin: '1357' },
  { id: 'emp-cocina', name: 'Cocina', role: 'Cocina', active: true, pin: '2580' },
  { id: 'emp-caja', name: 'Caja', role: 'Caja', active: true, pin: '2026' },
]

export const defaultIngredients = [
  { id: 'ing-carne', name: 'Carne de res', category: 'Proteínas', unit: 'g', costPerUnit: 0.035, stock: 8000, minStock: 1000, active: true },
  { id: 'ing-queso', name: 'Queso', category: 'Lácteos', unit: 'g', costPerUnit: 0.025, stock: 4000, minStock: 600, active: true },
  { id: 'ing-lechuga', name: 'Lechuga', category: 'Vegetales', unit: 'g', costPerUnit: 0.01, stock: 3000, minStock: 400, active: true },
  { id: 'ing-tomate', name: 'Tomate', category: 'Vegetales', unit: 'g', costPerUnit: 0.012, stock: 3000, minStock: 400, active: true },
  { id: 'ing-cebolla', name: 'Cebolla', category: 'Vegetales', unit: 'g', costPerUnit: 0.008, stock: 2500, minStock: 350, active: true },
  { id: 'ing-pepinillos', name: 'Pepinillos', category: 'Vegetales', unit: 'g', costPerUnit: 0.018, stock: 1500, minStock: 200, active: true },
  { id: 'ing-pan', name: 'Pan brioche', category: 'Panadería', unit: 'unidad', costPerUnit: 1200, stock: 120, minStock: 20, active: true },
  { id: 'ing-papas', name: 'Papa', category: 'Acompañamientos', unit: 'g', costPerUnit: 0.007, stock: 10000, minStock: 1500, active: true },
  { id: 'ing-tocino', name: 'Tocino', category: 'Proteínas', unit: 'g', costPerUnit: 0.03, stock: 2500, minStock: 250, active: true },
  { id: 'ing-huevo', name: 'Huevo', category: 'Proteínas', unit: 'unidad', costPerUnit: 900, stock: 80, minStock: 12, active: true },
]
export const defaultIngredientCategories = ['Proteínas','Lácteos','Vegetales','Panadería','Acompañamientos']
export const defaultExtraCategories = ['Adiciones','Salsas']
export const defaultExtras = [
  { id: 'ext-queso', name: 'Queso extra', category: 'Adiciones', price: 2000, ingredients: ['ing-queso'], ingredientUsage: { 'ing-queso': 25 }, ingredientUsageUnit: { 'ing-queso':'g' }, active: true },
  { id: 'ext-tocino', name: 'Tocino', category: 'Adiciones', price: 3000, ingredients: ['ing-tocino'], ingredientUsage: { 'ing-tocino': 35 }, ingredientUsageUnit: { 'ing-tocino':'g' }, active: true },
  { id: 'ext-huevo', name: 'Huevo', category: 'Adiciones', price: 1500, ingredients: ['ing-huevo'], ingredientUsage: { 'ing-huevo': 1 }, ingredientUsageUnit: { 'ing-huevo':'unidad' }, active: true },
  { id: 'ext-salsa', name: 'Salsa extra', category: 'Salsas', price: 1000, ingredients: [], ingredientUsage: {}, active: true },
]

function defaultUsageUnit(stockUnit = 'unidad') { if (stockUnit === 'kg') return 'g'; if (stockUnit === 'L') return 'ml'; return stockUnit }

function safeJson(value, fallback) { try { return JSON.parse(value) ?? fallback } catch { return fallback } }

const entityKeys = ['tables', 'categories', 'products', 'orders', 'ingredients', 'extras', 'employees', 'customers', 'reservations', 'sales', 'documents', 'inventoryMovements', 'audit']
const appendOnlyKeys = new Set(['sales', 'documents', 'inventoryMovements', 'audit'])

function stampOf(entity) {
  if (!entity || typeof entity !== 'object') return 0
  return Math.max(
    Number(entity.updatedAt) || 0,
    Number(entity.closedAt) || 0,
    Number(entity.cancelledAt) || 0,
    Number(entity.createdAt) || 0,
  )
}


function mergeConfig(local = {}, remote = {}) {
  const localMeta = local?._updatedAtByField || {}
  const remoteMeta = remote?._updatedAtByField || {}
  const hasFieldMeta = Object.keys(localMeta).length > 0 || Object.keys(remoteMeta).length > 0
  const result = { ...(remote || {}) }
  const keys = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})])
  keys.delete('_updatedAtByField'); keys.delete('updatedAt'); keys.delete('kitchen')
  const meta = { ...remoteMeta }
  for (const key of keys) {
    const lt = Number(localMeta[key]) || (hasFieldMeta ? 0 : Number(local.updatedAt) || 0)
    const rt = Number(remoteMeta[key]) || (hasFieldMeta ? 0 : Number(remote.updatedAt) || 0)
    if (lt > rt) { result[key] = local[key]; meta[key] = lt }
    else if (!(key in result) && key in local) { result[key] = local[key]; meta[key] = lt }
  }
  const lk = local?.kitchen || {}
  const rk = remote?.kitchen || {}
  const lkm = local?._updatedAtByField || {}
  const rkm = remote?._updatedAtByField || {}
  const kitchen = { ...rk }
  const kitchenKeys = new Set([...Object.keys(lk), ...Object.keys(rk)])
  for (const key of kitchenKeys) {
    const metaKey = `kitchen.${key}`
    const lt = Number(lkm[metaKey]) || (Object.keys(lkm).length || Object.keys(rkm).length ? 0 : Number(local.updatedAt) || 0)
    const rt = Number(rkm[metaKey]) || (Object.keys(lkm).length || Object.keys(rkm).length ? 0 : Number(remote.updatedAt) || 0)
    if (lt > rt) kitchen[key] = lk[key]
    meta[metaKey] = Math.max(lt, rt)
  }
  result.kitchen = kitchen
  result._updatedAtByField = meta
  result.updatedAt = Math.max(Number(local.updatedAt)||0, Number(remote.updatedAt)||0)
  return result
}

function mergeArray(local = [], remote = [], key = 'id') {
  const map = new Map()
  for (const item of remote) {
    if (item && typeof item === 'object' && item[key] != null) map.set(String(item[key]), item)
  }
  for (const item of local) {
    if (!item || typeof item !== 'object' || item[key] == null) continue
    const id = String(item[key])
    const existing = map.get(id)
    if (!existing) {
      map.set(id, item)
      continue
    }
    if (stampOf(item) >= stampOf(existing)) map.set(id, item)
  }
  const merged = [...map.values()]
  if (!appendOnlyKeys.has(key)) return merged
  return merged.sort((a, b) => stampOf(b) - stampOf(a))
}

export function mergeStores(local, remote) {
  if (!local) return remote
  if (!remote) return local
  const next = { ...remote }
  for (const key of entityKeys) {
    if (Array.isArray(local[key]) || Array.isArray(remote[key])) {
      next[key] = mergeArray(Array.isArray(local[key]) ? local[key] : [], Array.isArray(remote[key]) ? remote[key] : [], key === 'audit' ? 'id' : 'id')
    }
  }
  next.config = mergeConfig(local.config || {}, remote.config || {})

  const localCash = local.cash || {}
  const remoteCash = remote.cash || {}
  const localCashStamp = Number(localCash.updatedAt) || Number(localCash.lastClosedAt) || Number(localCash.openedAt) || 0
  const remoteCashStamp = Number(remoteCash.updatedAt) || Number(remoteCash.lastClosedAt) || Number(remoteCash.openedAt) || 0
  const cashWinner = localCashStamp > remoteCashStamp ? localCash : remoteCash
  next.cash = {
    ...cashWinner,
    movements: mergeArray(localCash.movements || [], remoteCash.movements || []),
    closings: mergeArray(localCash.closings || [], remoteCash.closings || []),
  }

  // Local device settings are intentionally not synchronized between devices.
  delete next.activeEmployeeId
  if (next.config) delete next.config.workMode

  // Prevent double-selling the same orders when two clients close a table concurrently.
  if (Array.isArray(next.sales)) {
    const seenOrders = new Set()
    next.sales = next.sales.filter(sale => {
      const orderIds = Array.isArray(sale.orderIds) ? sale.orderIds.map(String).sort() : []
      if (!orderIds.length) return true
      const overlap = orderIds.some(id => seenOrders.has(id))
      if (overlap) return false
      orderIds.forEach(id => seenOrders.add(id))
      return true
    })
  }
  const saleIds = new Set((next.sales || []).map(sale => sale.id))
  next.inventoryMovements = (next.inventoryMovements || []).filter(movement => !movement.saleId || saleIds.has(movement.saleId))
  const seenDocumentSales = new Set()
  next.documents = (next.documents || []).filter(document => {
    if (!document?.saleId) return true
    if (seenDocumentSales.has(document.saleId)) return false
    seenDocumentSales.add(document.saleId)
    return saleIds.has(document.saleId)
  })
  next.ingredients = reconcileInventoryStocks(next.ingredients || [], next.inventoryMovements || [])
  return next
}

export function readLegacyState() {
  const read = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
  }
  return { config: read('restaurant-config', null), tables: read('restaurant-tables', null), categories: read('restaurant-categories', null), products: read('restaurant-products', null), orders: read('restaurant-orders', null) }
}

export function createInitialStore(seed) {
  const legacy = readLegacyState()
  return {
    version: 8,
    config: {
      restaurantName: 'Verde & Grano', currency: 'COP', tableCount: 8,
      kitchen: { defaultEstimatedPrepTime: 900, warningRemainingPercent: 20, alertRepeatInterval: 300, soundEnabled: false, volume: 0.45, productSpecific: true },
      ...(legacy.config || {}),
    },
    tables: legacy.tables || seed.tables || [], categories: legacy.categories || seed.categories || [],
    ingredientCategories: defaultIngredientCategories, extraCategories: defaultExtraCategories,
    ingredients: (seed.ingredients || defaultIngredients).map(ingredient => ({ ...ingredient, baseStock: Number.isFinite(Number(ingredient.baseStock)) ? Number(ingredient.baseStock) : Number(ingredient.stock) || 0 })), extras: seed.extras || defaultExtras,
    products: legacy.products || seed.products || [], orders: legacy.orders || seed.orders || [], sales: [],
    cash: { isOpen: false, openingAmount: 0, openedAt: null, openedBy: null, closings: [], movements: [], updatedAt: 0 },
    employees: defaultEmployees, customers: defaultCustomers, reservations: defaultReservations, inventoryMovements: [], documents: [], audit: [],
    soundPresets: { delayed:{type:'double',customDataUrl:''}, newOrder:{type:'ping',customDataUrl:''}, ready:{type:'triple',customDataUrl:''}, cash:{type:'click',customDataUrl:''} },
  }
}

export function migrateStoreToV7(store, seed) {
  const base = createInitialStore(seed)
  const source = store && typeof store === 'object' ? store : {}
  const inventoryMovements = Array.isArray(source.inventoryMovements) ? source.inventoryMovements : []
  const movementDeltas = new Map()
  for (const movement of inventoryMovements) {
    if (!movement?.ingredientId) continue
    movementDeltas.set(movement.ingredientId, (movementDeltas.get(movement.ingredientId) || 0) + (Number(movement.quantity) || 0))
  }
  const sourceIngredients = source.ingredients?.length ? source.ingredients : base.ingredients
  return {
    ...base, ...source, version: 7,
    config: { ...base.config, ...(source.config || {}), kitchen: { ...base.config.kitchen, ...(source.config?.kitchen || {}) } },
    ingredientCategories: source.ingredientCategories?.length ? source.ingredientCategories : base.ingredientCategories,
    extraCategories: source.extraCategories?.length ? source.extraCategories : base.extraCategories,
    ingredients: sourceIngredients.map(ingredient => ({
      ...ingredient,
      baseStock: Number.isFinite(Number(ingredient.baseStock)) ? Number(ingredient.baseStock) : (Number(ingredient.stock) || 0) - (movementDeltas.get(ingredient.id) || 0),
    })),
    extras: (source.extras?.length ? source.extras : base.extras).map(extra => ({
      ...extra,
      ingredientIds: extra.ingredientIds || extra.ingredients || [],
      ingredients: extra.ingredients || extra.ingredientIds || [],
      ingredientUsage: extra.ingredientUsage || {},
    })),
    employees: (source.employees?.length ? source.employees : base.employees).map(employee => ({ ...employee, pin: employee.pin || defaultEmployees.find(seedEmployee => seedEmployee.id === employee.id)?.pin || '' })),
    customers: Array.isArray(source.customers) ? source.customers : [],
    reservations: Array.isArray(source.reservations) ? source.reservations : [],
    sales: Array.isArray(source.sales) ? source.sales : [],
    cash: { ...base.cash, ...(source.cash || {}) },
    inventoryMovements,
    documents: Array.isArray(source.documents) ? source.documents : [],
    audit: Array.isArray(source.audit) ? source.audit : [],
  }
}

export function migrateStoreToV8(store, seed) {
  const migrated = migrateStoreToV7(store, seed)
  const ingredientMap = new Map((migrated.ingredients || []).map(item => [item.id, item]))
  const products = (migrated.products || []).map(product => ({
    ...product,
    ingredientUsageUnit: product.ingredientUsageUnit || Object.fromEntries((product.ingredients || []).map(id => [id, defaultUsageUnit(ingredientMap.get(id)?.unit || 'unidad')])),
  }))
  const extras = (migrated.extras || []).map(extra => ({
    ...extra,
    ingredientUsageUnit: extra.ingredientUsageUnit || Object.fromEntries((extra.ingredientIds || extra.ingredients || []).map(id => [id, defaultUsageUnit(ingredientMap.get(id)?.unit || 'unidad')])),
  }))
  return { ...migrated, version: 8, products, extras }
}

export function loadStore(seed) {
  try {
    const current = safeJson(localStorage.getItem(DB_KEY), null)
    if (current) return migrateStoreToV8(current, seed)
    const legacy = safeJson(localStorage.getItem(LEGACY_DB_KEY), null)
    if (legacy) return migrateStoreToV8(legacy, seed)
    const legacyV6 = safeJson(localStorage.getItem(LEGACY_DB_V6_KEY), null)
    if (legacyV6) return migrateStoreToV8(legacyV6, seed)
  } catch {}
  const initial = createInitialStore(seed)
  try { localStorage.setItem(DB_KEY, JSON.stringify(initial)) } catch {}
  return initial
}

function serializableStore(store) {
  const clone = JSON.parse(JSON.stringify(store))
  delete clone.activeEmployeeId
  if (clone.config) delete clone.config.workMode
  return clone
}

export function hasPendingSync() {
  try { return localStorage.getItem(PENDING_KEY) === '1' || localStorage.getItem(LEGACY_PENDING_KEY) === '1' || localStorage.getItem(LEGACY_PENDING_V6_KEY) === '1' } catch { return false }
}

export function markPendingSync(store) {
  try {
    localStorage.setItem(PENDING_KEY, '1')
    localStorage.setItem(DB_KEY, JSON.stringify(store))
  } catch {}
}

export function clearPendingSync() {
  try { localStorage.removeItem(PENDING_KEY); localStorage.removeItem(LEGACY_PENDING_KEY) } catch {}
}

export async function fetchServerStore() {
  try { const response = await fetch(API_STATE, { cache:'no-store' }); if (!response.ok) return null; return (await response.json())?.store || null } catch { return null }
}

export async function saveStore(store) {
  try { localStorage.setItem(DB_KEY, JSON.stringify(store)) } catch {}
  try {
    const response = await fetch(API_STATE,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({store:serializableStore(store)}),keepalive:true})
    if (!response.ok) { markPendingSync(store); return false }
    clearPendingSync()
    return true
  } catch {
    markPendingSync(store)
    return false
  }
}

export async function seedServerStore(store) {
  try {
    const response = await fetch(API_STATE,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({store:serializableStore(store),initializeOnly:true})})
    if (response.ok) clearPendingSync()
    return response.ok
  } catch { return false }
}

export function clearV5Store() { localStorage.removeItem(DB_KEY); localStorage.removeItem(LEGACY_DB_KEY); localStorage.removeItem(LEGACY_DB_V6_KEY); localStorage.removeItem(PENDING_KEY); localStorage.removeItem(LEGACY_PENDING_KEY); localStorage.removeItem(LEGACY_PENDING_V6_KEY) }
export function createSyncChannel() { try { return new BroadcastChannel(CHANNEL_NAME) } catch { return null } }
export function broadcastStore(channel, store) { try { channel?.postMessage({type:'STATE',store}) } catch {} }
export function createServerEventSource(onStore,onStatus=()=>{}) {
  if (!('EventSource' in window)) return null
  try {
    const source = new EventSource(API_EVENTS)
    source.addEventListener('open',()=>onStatus(true))
    source.addEventListener('error',()=>onStatus(false))
    source.addEventListener('state',event=>{ try { const store=JSON.parse(event.data); if(store?.version>=5) onStore(store) } catch {} })
    return source
  } catch { return null }
}
export function nowStamp() { return Date.now() }

export const migrateStoreToV6 = migrateStoreToV8
