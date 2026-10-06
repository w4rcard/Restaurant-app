import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mergeStores, migrateStoreToV6 } from '../src/lib/db.js'
import { deductInventoryForSale, getInventoryRequirements, reconcileInventoryStocks, validateInventoryForSale } from '../src/lib/inventory.js'
import { calculateEstimatedPrepTime, getDueKitchenAlerts, getKitchenTiming } from '../src/lib/kitchen.js'
import { STATUS, itemSubtotal, orderTotal } from '../src/lib/pos.js'
import { buildReceiptPdf } from '../src/lib/documents.js'

const root = fileURLToPath(new URL('..', import.meta.url))

function repeat(label, fn, count = 5) {
  for (let i = 1; i <= count; i++) {
    fn(i)
    console.log(`PASS ${label} ${i}/${count}`)
  }
}

const baseIngredients = [
  { id:'i1', name:'Carne', unit:'g', stock:1000, minStock:100 },
  { id:'i2', name:'Queso', unit:'g', stock:500, minStock:50 },
  { id:'i3', name:'Tocino', unit:'g', stock:300, minStock:30 },
]
const products = [{ id:'p1', name:'Burger', price:10000, estimatedPrepTime:900, ingredients:['i1'], ingredientUsage:{i1:150}, extraIds:['e1'], extras:[{id:'e1',name:'Tocino',price:2000,ingredientIds:['i3'],ingredients:['i3'],ingredientUsage:{i3:35}}] }]
const items = [{ productId:'p1', productName:'Burger', basePrice:10000, quantity:2, extras:[products[0].extras[0]], removedIngredients:[] }]

repeat('inventory product + extra consumption', () => {
  const req = getInventoryRequirements(items, products, baseIngredients)
  assert.equal(req.find(x => x.ingredientId === 'i1').quantity, 300)
  assert.equal(req.find(x => x.ingredientId === 'i3').quantity, 70)
  assert.equal(validateInventoryForSale(items, products, baseIngredients).ok, true)
  const deducted = deductInventoryForSale(baseIngredients, req, 'sale-1', 'emp-1', 1000)
  assert.equal(deducted.ingredients.find(x => x.id === 'i1').stock, 700)
  assert.equal(deducted.ingredients.find(x => x.id === 'i3').stock, 230)
})

repeat('kitchen timers + repeating alerts', () => {
  const settings = { defaultEstimatedPrepTime:900, alertRepeatInterval:300, warningRemainingPercent:20 }
  const order = { id:'o1', status:STATUS.PREPARING, createdAt:1000, sentToKitchenAt:1000, estimatedPrepTime:600 }
  assert.equal(getKitchenTiming(order, 602000, settings).alertLevel, 'delayed')
  assert.equal(getDueKitchenAlerts([{...order, lastKitchenAlertAt:0}], 602000, settings).length, 1)
  assert.equal(getDueKitchenAlerts([{...order, lastKitchenAlertAt:400000}], 602000, settings).length, 0)
  assert.equal(calculateEstimatedPrepTime(items.map(item => ({...item, estimatedPrepTime:1200})), products, settings), 1200)
})

repeat('POS totals', () => {
  assert.equal(itemSubtotal({basePrice:100, extras:[{price:25}], quantity:2}), 250)
  assert.equal(orderTotal([{basePrice:100, extras:[], quantity:2}]), 200)
})

repeat('merge keeps independent changes', () => {
  const local = {
    version:6, config:{restaurantName:'Local',updatedAt:20}, tables:[], categories:[], products:[],
    orders:[{id:'a',number:1,status:STATUS.PENDING,createdAt:20,updatedAt:20}], ingredients:[{id:'i1',stock:900,updatedAt:20}], extras:[], employees:[], customers:[], reservations:[], sales:[], documents:[], inventoryMovements:[], audit:[], cash:{isOpen:false,updatedAt:20}, activeEmployeeId:'emp-a'
  }
  const remote = {
    version:6, config:{restaurantName:'Servidor',updatedAt:10}, tables:[], categories:[], products:[],
    orders:[{id:'b',number:2,status:STATUS.READY,createdAt:30,updatedAt:30}], ingredients:[{id:'i1',stock:950,updatedAt:10}], extras:[], employees:[], customers:[], reservations:[], sales:[], documents:[], inventoryMovements:[], audit:[], cash:{isOpen:false,updatedAt:10}, activeEmployeeId:'emp-b'
  }
  const merged = mergeStores(local, remote)
  assert.deepEqual(merged.orders.map(o=>o.id).sort(), ['a','b'])
  assert.equal(merged.ingredients[0].stock,900)
  assert.equal('activeEmployeeId' in merged,false)
})

repeat('duplicate sale protection', () => {
  const base = { version:6, orders:[{id:'o1',status:STATUS.DELIVERED,updatedAt:20}], sales:[{id:'s1',orderIds:['o1'],createdAt:20}], ingredients:[{id:'i1',stock:90,updatedAt:20}], inventoryMovements:[{id:'m1',saleId:'s1',ingredientId:'i1',quantity:-10,createdAt:20}], documents:[],audit:[],tables:[],categories:[],products:[],extras:[],employees:[],cash:{} }
  const duplicate = { ...base, sales:[{id:'s2',orderIds:['o1'],createdAt:30}], ingredients:[{id:'i1',stock:80,updatedAt:30}], inventoryMovements:[{id:'m2',saleId:'s2',ingredientId:'i1',quantity:-10,createdAt:30}] }
  const merged = mergeStores(base, duplicate)
  assert.equal(merged.sales.length,1)
  assert.equal(merged.sales[0].id,'s2')
  assert.equal(merged.inventoryMovements.some(m=>m.saleId==='s2'),true)
})


repeat('inventory ledger reconciliation under concurrent edits', () => {
  const ingredients = [{ id:'i1', name:'Carne', stock:80, baseStock:100 }]
  const movements = [
    { id:'m1', ingredientId:'i1', quantity:-10, saleId:'s1' },
    { id:'m2', ingredientId:'i1', quantity:-10, saleId:'s2' },
  ]
  const result = reconcileInventoryStocks(ingredients, movements)
  assert.equal(result[0].stock,80)
})

repeat('config field merge keeps independent edits', () => {
  const local = { config:{ restaurantName:'Local', currency:'USD', kitchen:{ defaultEstimatedPrepTime:700 }, updatedAt:20, _updatedAtByField:{restaurantName:20,currency:20,'kitchen.defaultEstimatedPrepTime':20} } }
  const remote = { config:{ restaurantName:'Remote', currency:'COP', kitchen:{ defaultEstimatedPrepTime:900 }, updatedAt:10, _updatedAtByField:{currency:10} } }
  const merged = mergeStores({...local,version:6,tables:[],categories:[],products:[],orders:[],ingredients:[],extras:[],employees:[],sales:[],documents:[],inventoryMovements:[],audit:[],cash:{}}, {...remote,version:6,tables:[],categories:[],products:[],orders:[],ingredients:[],extras:[],employees:[],sales:[],documents:[],inventoryMovements:[],audit:[],cash:{}})
  assert.equal(merged.config.restaurantName,'Local')
  assert.equal(merged.config.currency,'USD')
  assert.equal(merged.config.kitchen.defaultEstimatedPrepTime,700)
})

repeat('duplicate sale removes duplicate document and movement', () => {
  const base = { version:6, orders:[{id:'o1',status:STATUS.DELIVERED,updatedAt:20}], sales:[{id:'s1',orderIds:['o1'],createdAt:20}], ingredients:[{id:'i1',stock:90,baseStock:100,updatedAt:20}], inventoryMovements:[{id:'m1',saleId:'s1',ingredientId:'i1',quantity:-10,createdAt:20}], documents:[{id:'d1',saleId:'s1'}], audit:[],tables:[],categories:[],products:[],extras:[],employees:[],cash:{} }
  const duplicate = { ...base, sales:[{id:'s2',orderIds:['o1'],createdAt:30}], ingredients:[{id:'i1',stock:80,baseStock:100,updatedAt:30}], inventoryMovements:[{id:'m2',saleId:'s2',ingredientId:'i1',quantity:-10,createdAt:30}], documents:[{id:'d2',saleId:'s2'}] }
  const merged = mergeStores(base, duplicate)
  assert.equal(merged.sales.length,1)
  assert.equal(merged.documents.length,1)
  assert.equal(merged.inventoryMovements.length,1)
  assert.equal(merged.ingredients[0].stock,90)
})

repeat('receipt PDF generation', () => {
  const pdf = buildReceiptPdf({ restaurantName:'Verde & Grano', tableName:'Mesa 4', createdAt:Date.now(), items:[{quantity:2,productName:'Burger',subtotal:24000,extras:[{name:'Queso extra'}]}], subtotal:24000, discount:1000, tip:2300, total:25300, paymentMethod:'Efectivo', people:2 }, 'COP')
  assert.ok(pdf.length > 500)
  assert.equal(new TextDecoder().decode(pdf.slice(0,8)).startsWith('%PDF-1.4'), true)
  assert.match(new TextDecoder().decode(pdf), /%%EOF/)
})

repeat('migration preserves defaults and normalizes extras', () => {
  globalThis.localStorage = { data:new Map(), getItem(k){return this.data.get(k) ?? null}, setItem(k,v){this.data.set(k,String(v))}, removeItem(k){this.data.delete(k)} }
  const migrated = migrateStoreToV6({ version:5, extras:[{id:'x',name:'Extra'}], employees:[{id:'emp-admin',name:'Admin',role:'Administrador',active:true}] }, {tables:[],categories:[],products:[],orders:[],ingredients:[],extras:[]})
  assert.equal(migrated.version,8)
  assert.deepEqual(migrated.extras[0].ingredients,[])
  assert.equal(migrated.employees[0].pin,'2468')
})

async function runServerRound() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restaurante-v6-exhaustive-'))
  const dbPath = path.join(tempDir, 'test.db')
  const port = 9200 + Math.floor(Math.random() * 300)
  const base = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, [path.join(root, 'server', 'index.mjs')], {
    cwd: root,
    env: { ...process.env, API_PORT:String(port), HOST:'127.0.0.1', DB_PATH:dbPath },
    stdio:['ignore','pipe','pipe'],
  })
  let spawnError = null
  server.once('error', error => { spawnError = error })
  try {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      try { if ((await fetch(`${base}/api/health`)).ok) break } catch {}
      await new Promise(resolve=>setTimeout(resolve,25))
    }
    const health = await (await fetch(`${base}/api/health`)).json()
    assert.equal(health.ok,true)
    const seed = { version:6, config:{restaurantName:'Exhaustive',updatedAt:1}, tables:[],categories:[],products:[],orders:[],ingredients:[{id:'i1',stock:100,updatedAt:1}],extras:[],employees:[],sales:[],documents:[],inventoryMovements:[],audit:[],cash:{isOpen:false,updatedAt:1} }
    assert.equal((await fetch(`${base}/api/state`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({store:seed})})).ok,true)
    repeat('server concurrent merge', async()=>{},0)
    const a={...seed,config:{restaurantName:'A',updatedAt:10,_updatedAtByField:{restaurantName:10}},orders:[{id:'oa',number:101,status:STATUS.PENDING,createdAt:10,updatedAt:10}]}
    const b={...seed,config:{restaurantName:'B',updatedAt:20,_updatedAtByField:{restaurantName:20}},orders:[{id:'ob',number:102,status:STATUS.PENDING,createdAt:20,updatedAt:20}]}
    await Promise.all([fetch(`${base}/api/state`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({store:a})}),fetch(`${base}/api/state`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({store:b})})])
    const state=(await (await fetch(`${base}/api/state`)).json()).store
    assert.deepEqual(state.orders.map(o=>o.id).sort(),['oa','ob'])
    assert.equal(state.config.restaurantName,'B')
    const bad=await fetch(`${base}/api/state`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({store:{version:4}})})
    assert.equal(bad.status,400)
    const options=await fetch(`${base}/api/state`,{method:'OPTIONS'})
    assert.equal(options.status,204)
    assert.equal(options.headers.get('access-control-allow-origin'),'*')
    const backup=await fetch(`${base}/api/backup`)
    assert.equal(backup.ok,true)
    const backupPath=path.join(tempDir,'backup.db'); fs.writeFileSync(backupPath,new Uint8Array(await backup.arrayBuffer()))
    const backupDb=new DatabaseSync(backupPath); assert.equal(backupDb.prepare("PRAGMA integrity_check").get().integrity_check,'ok'); backupDb.close()
    console.log('PASS server integration')
  } finally {
    server.kill('SIGTERM')
    await new Promise(resolve=>setTimeout(resolve,80))
    fs.rmSync(tempDir,{recursive:true,force:true})
  }
}

for(let i=1;i<=5;i++){ await runServerRound(); console.log(`PASS server round ${i}/5`) }
console.log('V6 exhaustive tests: PASS')
