import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
const root = process.cwd()
for (const file of ['package.json','package-lock.json','vite.config.js','index.html','src/App.jsx','src/lib/db.js','src/lib/pos.js','src/lib/kitchen.js','src/lib/inventory.js','src/lib/documents.js','server/index.mjs','server/dev.mjs','server/db.mjs']) assert.equal(fs.existsSync(path.join(root,file)),true,`Falta ${file}`)
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'))
const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'))
assert.equal(pkg.version,'0.8.0'); assert.equal(lock.packages[''].version,'0.8.0')
const app=fs.readFileSync(path.join(root,'src/App.jsx'),'utf8')
for (const importPath of [...app.matchAll(/from ['"](\.\/[^'"]+)['"]/g)].map(m=>m[1])) {
  const candidate=path.resolve(path.join(root,'src'), importPath)+'.js'
  const candidateRaw=path.resolve(path.join(root,'src'), importPath)
  assert.ok(fs.existsSync(candidate)||fs.existsSync(candidateRaw),`Import inexistente: ${importPath}`)
}
assert.match(app,/Inventario/); assert.match(app,/Modo trabajo/); assert.match(app,/Descargar PDF/); assert.match(app,/setNewOrderPickerOpen\(true\)/); assert.match(app,/validateInventoryForSale/); assert.match(app,/setServerOnline\(false\)/)

assert.match(app,/newOrderPickerOpen &&/)
assert.match(app,/Solo Administrador puede modificar el inventario/)
assert.match(app,/Solo Caja o Administrador puede abrir la caja/)
assert.match(app,/Solo Caja o Administrador puede cerrar la caja/)
assert.match(app,/Dividir pago/); assert.match(app,/¿Cómo quieres dividir el pago/)
assert.match(app,/mixedFirstMethod/); assert.match(app,/mixedSecondMethod/); assert.match(app,/Completar restante/); assert.match(app,/cashPortion/); assert.match(app,/mixedSplitMode/); assert.match(app,/Por personas/); assert.match(app,/Repartir por igual/); assert.match(app,/clampSplitPeople/)
assert.match(app,/changeTableCount/)
assert.match(app,/orderSubmitLockRef/)
assert.match(app,/checkoutSubmitLockRef/)
assert.match(app,/cashActionLockRef/)
assert.match(app,/inventoryActionLockRef/)
assert.match(app,/restaurant-active-employee/)
assert.match(app,/restaurant-work-mode/)
assert.match(app,/setSoundPreset/)
assert.match(app,/file.size > 1_500_000/)
assert.match(app,/reconcileInventoryStocks/)
const payments=fs.readFileSync(path.join(root,'src/lib/payments.js'),'utf8')
assert.match(payments,/clampSplitPeople/); assert.match(payments,/distributeSplitTotal/); assert.match(payments,/buildPaymentBreakdownFromParts/)
const db=fs.readFileSync(path.join(root,'src/lib/db.js'),'utf8')
assert.match(db,/mergeConfig/); assert.match(db,/restaurant-db-v8-pending-sync/); assert.match(db,/restaurant-db-v8/); assert.match(db,/seenDocumentSales/); assert.match(db,/baseStock/)
const server=fs.readFileSync(path.join(root,'server/db.mjs'),'utf8')
assert.match(server,/BEGIN IMMEDIATE/); assert.match(server,/dedupeSales/); assert.match(server,/mergeConfig/); assert.match(server,/reconcileInventoryStocks/)
const dev=fs.readFileSync(path.join(root,'server/dev.mjs'),'utf8')
assert.match(dev,/UI_HOST \|\| '0\.0\.0\.0'/); assert.match(dev,/shell: false/)

console.log('V6 static tests: PASS')
