import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildRows, hasAmbiguousJsonNumbers, readSnapshot, safeReport, validateImportPaths, validateState } from '../server/sqlite-postgres-import.mjs'

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pos-p3-unit-'))
try{
  const sourcePath=path.join(temp,'synthetic-source.sqlite'),activePath=path.join(temp,'active-never-opened.sqlite'),reportPath=path.join(temp,'report.json')
  fs.writeFileSync(activePath,'not opened')
  const fixture={
    version:8,config:{restaurantName:'Synthetic POS',currency:'COP'},
    employees:[{id:'emp_admin',name:'Admin Fixture',role:'Administrador',active:true,pin:'11112222'}],
    tables:[{id:17,name:'Mesa 17',active:true,shape:'round',x:1,y:2,seats:2,sizeScale:1,joinedWith:[]}],
    categories:[{id:'cat-soup',name:'Sopas',active:true}],
    ingredients:[{id:'ing-g',name:'Harina',unit:'g',category:'Secos',costPerUnit:0.125,minStock:0,stock:90,baseStock:100,active:true}],
    extras:[{id:'extra-cheese',name:'Queso',category:'Extras',price:0.5,active:true,ingredientIds:['ing-g'],ingredientUsage:{'ing-g':10},ingredientUsageUnit:{'ing-g':'g'}}],
    products:[{id:'prod-soup',name:'Sopa',description:'',price:4.5,categoryId:'cat-soup',isActive:true,estimatedPrepTime:300,ingredients:['ing-g'],ingredientUsage:{'ing-g':10},ingredientUsageUnit:{'ing-g':'g'},extraIds:['extra-cheese']}],
    orders:[{id:'order-A',number:17,tableId:17,tableName:'Mesa 17',orderType:'mesa',status:'ENTREGADO',items:[{id:'line-A',productId:'prod-soup',productName:'Sopa',basePrice:4.5,quantity:1,extras:[{id:'extra-cheese',name:'Queso',price:0.5}],removedIngredients:['ing-onion'],note:'',estimatedPrepTime:300}],total:5,createdAt:1730000000000,updatedAt:1730000001000,employeeId:'emp_admin'}],
    customers:[],reservations:[],sales:[{id:'sale-A',createdAt:1730000002000,tableId:17,tableName:'Mesa 17',orderIds:['order-A'],orderType:'mesa',subtotal:5,discount:0,netTotal:5,tip:0.1,total:5.1,paymentMethod:'Efectivo',paymentBreakdown:{Efectivo:5.1},people:1,employeeId:'emp_admin',cashReceived:6,cashChange:0.9}],
    cash:{isOpen:false,closings:[],movements:[]},documents:[{id:'receipt-A',type:'comprobante',createdAt:1730000002000,saleId:'sale-A',items:[{productName:'Sopa',quantity:1,unitPrice:4.5,extras:[{name:'Queso',price:0.5}],subtotal:5}]}],
    inventoryMovements:[{id:'movement-A',type:'sale',ingredientId:'ing-g',ingredientName:'Harina',quantity:-10,unit:'g',stockBefore:100,stockAfter:90,saleId:'sale-A',employeeId:'emp_admin',reason:'venta',createdAt:1730000002000}],
    audit:[{id:'audit-A',action:'venta_cerrada',employeeId:'emp_admin',createdAt:1730000002000,data:{saleId:'sale-A'}}],
    soundPresets:{cash:{type:'click'}},ingredientCategories:['Secos'],extraCategories:['Extras'],
  }
  const db=new DatabaseSync(sourcePath)
  db.exec('CREATE TABLE app_state(id INTEGER PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE employee_credentials(employee_id TEXT PRIMARY KEY, scheme TEXT, salt BLOB, password_hash BLOB, credential_state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);')
  db.prepare('INSERT INTO app_state VALUES(1,8,?,1730000000000)').run(JSON.stringify(fixture))
  db.prepare('INSERT INTO employee_credentials VALUES(?,?,?,?,?,?,?)').run('emp_admin','scrypt-v1',Buffer.alloc(16,1),Buffer.alloc(32,2),'active',1730000000000,1730000000000)
  db.close()

  const paths=validateImportPaths({sourcePath,activePath,reportPath})
  assert.equal(paths.sourcePath,sourcePath)
  assert.throws(()=>validateImportPaths({sourcePath:activePath,activePath,reportPath}),/source_matches_protected_database/)
  assert.throws(()=>validateImportPaths({sourcePath,activePath:'',reportPath}),/required/)
  assert.throws(()=>validateImportPaths({sourcePath,activePath,reportPath:activePath}),/report_must_not_overwrite_database/)
  const hardlinkActive=path.join(temp,'active-hardlink.sqlite')
  fs.linkSync(sourcePath,hardlinkActive)
  assert.throws(()=>validateImportPaths({sourcePath,activePath:hardlinkActive,reportPath}),/hardlink_to_protected_database/)
  try{const sourceAlias=path.join(temp,'source-alias.sqlite');fs.symlinkSync(sourcePath,sourceAlias);assert.throws(()=>validateImportPaths({sourcePath:sourceAlias,activePath,reportPath}),/source_must_be_existing_regular_file/)}catch(error){if(error.code!=='EPERM'&&error.code!=='EACCES'&&error.code!=='ENOTSUP')throw error}
  const snapshot=readSnapshot(sourcePath)
  assert.equal(snapshot.state.version,8)
  assert.equal(snapshot.credentials[0].password_hash.length,32)
  assert.match(snapshot.sourceSha256,/^[0-9a-f]{64}$/)
  assert.equal(snapshot.numericPrecisionAmbiguous,false)
  assert.equal(hasAmbiguousJsonNumbers('{"value":9007199254740992}'),true)
  assert.equal(hasAmbiguousJsonNumbers('{"value":0.10000000000000001}'),true)
  const validation=validateState(snapshot.state,snapshot.credentials,'COP')
  assert.deepEqual(validation.diagnostics,[])
  assert.equal(Object.hasOwn(snapshot.state.employees[0],'pin'),false)
  assert.equal(validation.counts.cashMovements,0)
  const built=buildRows('restaurant-test',snapshot.state,snapshot.credentials,validation,'COP')
  assert.equal(built.rows.restaurant_tables.data[0][1],'17')
  assert.equal(built.rows.sale_orders.data[0][2],'order-A')
  assert.equal(built.rows.sale_lines.data[0][3],null,'sales use receipt snapshots without guessing order-line identity')
  assert.equal(built.rows.sale_lines.data[0][7],'5')
  assert.equal(built.rows.inventory_movements.data[0][4],'-10')
  assert.equal(built.rows.employee_credentials.data[0][4].length,32)
  assert.equal(built.rows.audit_events.data[0][6].includes('legacy_unverified'),true)

  const bad=structuredClone(snapshot.state)
  bad.sales.push({...bad.sales[0],id:'sale-B'})
  const overlap=validateState(bad,snapshot.credentials)
  assert.ok(overlap.diagnostics.some(item=>item.code==='overlapping_sale_order_reference'))
  const orphan=structuredClone(snapshot.state)
  orphan.products[0].categoryId='missing'
  assert.ok(validateState(orphan,snapshot.credentials).diagnostics.some(item=>item.code==='missing_category'))
  const unsafeId=structuredClone(snapshot.state)
  unsafeId.tables.push({...unsafeId.tables[0],id:'user@example.com'})
  unsafeId.tables.push({...unsafeId.tables[0],id:'user@example.com'})
  const report=safeReport({sourceSha256:snapshot.sourceSha256,restaurantId:'restaurant-test',validation:validateState(unsafeId,snapshot.credentials,'COP'),dryRun:true,confirmedLegacySalesCurrency:'COP'})
  const reportText=JSON.stringify(report)
  assert.doesNotMatch(reportText,/11112222|scrypt-v1|password_hash|salt|Admin Fixture|user@example\.com/)
  assert.equal(report.status,'blocked')
  console.log('SQLite/PostgreSQL importer unit checks passed (synthetic SQLite fixture only).')
}finally{fs.rmSync(temp,{recursive:true,force:true})}
