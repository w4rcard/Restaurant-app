import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createInitialStore, migrateStoreToV8, mergeStores } from '../src/lib/db.js'
import { validateInventoryForSale, getInventoryRequirements } from '../src/lib/inventory.js'

const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const db = fs.readFileSync(new URL('../src/lib/db.js', import.meta.url), 'utf8')
const css = fs.readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')

const seed = { tables: [], categories: [], products: [], orders: [], ingredients: [], extras: [] }

function check(name, fn) {
  for (let i = 1; i <= 5; i += 1) fn(i)
  console.log(`PASS 5x · ${name}`)
}

check('V8 store defaults', () => {
  const store = createInitialStore(seed)
  assert.equal(store.version, 8)
  assert.ok(Array.isArray(store.customers))
  assert.ok(Array.isArray(store.reservations))
})

check('V7 → V8 migration', () => {
  const store = migrateStoreToV8({ version: 6, customers: undefined, reservations: undefined }, seed)
  assert.equal(store.version, 8)
  assert.ok(Array.isArray(store.customers))
  assert.ok(Array.isArray(store.reservations))
})

check('entity merge customers/reservations', () => {
  const a = { version: 8, customers: [{ id:'c1', name:'Ana', updatedAt:20 }], reservations: [{ id:'r1', updatedAt:20 }] }
  const b = { version: 8, customers: [{ id:'c2', name:'Luis', updatedAt:30 }], reservations: [{ id:'r2', updatedAt:30 }] }
  const merged = mergeStores(a, b)
  assert.equal(merged.customers.length, 2)
  assert.equal(merged.reservations.length, 2)
})

check('inventory add/usage compatibility', () => {
  const ingredients = [{ id:'ing', name:'Carne', unit:'g', stock:100, minStock:10 }]
  const products = [{ id:'p', ingredients:['ing'], ingredientUsage:{ ing:20 } }]
  const items = [{ productId:'p', quantity:2, extras:[], removedIngredients:[] }]
  const req = getInventoryRequirements(items, products, ingredients)
  assert.equal(req[0].quantity, 40)
  assert.equal(validateInventoryForSale(items, products, ingredients).ok, true)
})

check('V7 UI architecture markers', () => {
  for (const marker of ['Clientes','Reservas','Para llevar','Domicilio','Buscar en todo','QR mesa','Añadir ingrediente','V8','openExternalOrderComposer','openExternalCheckout','customerId','reservationId']) assert.ok(app.includes(marker), `missing ${marker}`)
  assert.ok(db.includes("restaurant-db-v8")); assert.ok(db.includes("restaurant-db-v7-pending-sync"))
  assert.ok(css.includes('global-result-row'))
})

console.log('V7 regression suite: PASS')
