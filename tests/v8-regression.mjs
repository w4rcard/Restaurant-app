import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createInitialStore, migrateStoreToV8, mergeStores } from '../src/lib/db.js'
import { compatibleUnits, convertQuantity, defaultUsageUnit, getInventoryRequirements, validateInventoryForSale } from '../src/lib/inventory.js'

const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const css = fs.readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
const db = fs.readFileSync(new URL('../src/lib/db.js', import.meta.url), 'utf8')
const server = fs.readFileSync(new URL('../server/db.mjs', import.meta.url), 'utf8')
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const seed = {
  tables: [{ id:1, name:'Mesa 1', seats:4, shape:'round', x:50, y:50, joinedWith:[], active:true }],
  categories: [{ id:'cat', name:'Comida', active:true }],
  products: [{ id:'p1', name:'Burger', price:20000, categoryId:'cat', isActive:true, estimatedPrepTime:900, ingredients:['i1'], ingredientUsage:{i1:150}, ingredientUsageUnit:{i1:'g'}, extraIds:[] }],
  orders: [], ingredients: [{ id:'i1', name:'Carne', category:'Proteínas', unit:'kg', costPerUnit:30, stock:5, minStock:1, baseStock:5 }], extras: [],
}

function repeat(name, fn) {
  for (let i = 1; i <= 5; i += 1) {
    fn(i)
    console.log(`PASS 5x · ${name} ${i}/5`)
  }
}

repeat('store version + migration', () => {
  const store = createInitialStore(seed)
  assert.equal(store.version, 8)
  const migrated = migrateStoreToV8({ version:7, ...store, products:[{...store.products[0],ingredientUsageUnit:undefined}] }, seed)
  assert.equal(migrated.version, 8)
  assert.equal(migrated.products[0].ingredientUsageUnit.i1, 'g')
})

repeat('unit conversions', () => {
  assert.deepEqual(compatibleUnits('kg'), ['g','kg'])
  assert.equal(defaultUsageUnit('kg'), 'g')
  assert.equal(convertQuantity(150,'g','kg'), 0.15)
  assert.equal(convertQuantity(2,'kg','g'), 2000)
  assert.equal(convertQuantity(750,'ml','L'), 0.75)
})

repeat('inventory uses stock unit correctly', () => {
  const store = createInitialStore(seed)
  const req = getInventoryRequirements([{productId:'p1',quantity:2,extras:[]}],store.products,store.ingredients)
  assert.equal(req[0].quantity,0.3)
  assert.equal(req[0].unit,'kg')
  assert.equal(validateInventoryForSale([{productId:'p1',quantity:40,extras:[]}],store.products,store.ingredients).ok,false)
})

repeat('independent merge', () => {
  const a = { ...createInitialStore(seed), version:8, customers:[{id:'c1',name:'Ana',updatedAt:10}] }
  const b = { ...createInitialStore(seed), version:8, customers:[{id:'c2',name:'Luis',updatedAt:20}] }
  const merged = mergeStores(a,b)
  assert.equal(merged.version,8)
  assert.equal(merged.customers.length,2)
})

repeat('V8 UI + architecture markers', () => {
  for (const marker of [
    "['analytics','Análisis'",
    'inventoryMovementDateFilter',
    'inventoryMovementSearch',
    'Añadir stock',
    'Ajustar',
    'ingredientUsageUnit',
    'compatibleUnits',
    'handleTablePointerDown',
    'table-dragging',
    'kitchen-status-label',
    "newOrder",
    'analyticsNextDemand',
    'downloadAnalyticsCsv',
    'V8 · Operación local',
  ]) assert.ok(app.includes(marker), `missing ${marker}`)
  for (const marker of ['salon-config-panel','usage-editor','usage-unit-select','kitchen-status-label','analytics-grid','inventory-history-toolbar']) assert.ok(css.includes(marker), `missing CSS ${marker}`)
  assert.match(db,/restaurant-db-v8/)
  assert.match(db,/restaurant-db-v7/)
  assert.match(server,/version: 8/)
  assert.equal(pkg.version,'0.8.0')
})

console.log('V8 regression suite: PASS 5/5 por bloque')
