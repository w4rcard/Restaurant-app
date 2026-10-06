import assert from 'node:assert/strict'
globalThis.localStorage = {
  data: new Map(),
  getItem(key){ return this.data.has(key) ? this.data.get(key) : null },
  setItem(key,value){ this.data.set(key,String(value)) },
  removeItem(key){ this.data.delete(key) },
}
const { migrateStoreToV6 } = await import('../src/lib/db.js')
const seed = { tables:[{id:1,name:'Mesa 1'}], categories:[], products:[], orders:[], ingredients:[], extras:[] }
const legacy = { version:5, config:{restaurantName:'Mi Restaurante'}, tables:[{id:3,name:'Mesa 3'}], orders:[{id:'o1'}], products:[{id:'p1'}], sales:[{id:'s1'}], cash:{isOpen:true}, ingredientCategories:['Proteínas'] }
const migrated = migrateStoreToV6(legacy, seed)
assert.equal(migrated.version,8)
assert.equal(migrated.config.restaurantName,'Mi Restaurante')
assert.equal(migrated.tables[0].name,'Mesa 3')
assert.equal(migrated.orders[0].id,'o1')
assert.equal(migrated.products[0].id,'p1')
assert.equal(migrated.sales.length,1)
assert.equal(migrated.cash.isOpen,true)
assert.ok(Array.isArray(migrated.inventoryMovements))
assert.ok(Array.isArray(migrated.documents))

const withInventory = migrateStoreToV6({ version:6, ingredients:[{id:'i1',name:'Carne',stock:70}], inventoryMovements:[{id:'m1',ingredientId:'i1',quantity:-30}] }, seed)
assert.equal(withInventory.ingredients[0].baseStock,100)

console.log('V6 migration tests: PASS')
