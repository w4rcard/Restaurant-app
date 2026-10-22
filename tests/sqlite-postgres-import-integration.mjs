import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { runMigrations } from '../server/postgres-migrate.mjs'
import { buildRows, insertOrder, runSqlitePostgresImport } from '../server/sqlite-postgres-import.mjs'

const {Client}=pg
const adminUrl=process.env.POSTGRES_INTEGRATION_TEST_URL
if(!adminUrl)throw new Error('POSTGRES_INTEGRATION_TEST_URL_required')
const admin=new URL(adminUrl),adminDb=decodeURIComponent(admin.pathname.slice(1))
if(!['postgres:','postgresql:'].includes(admin.protocol)||!['localhost','127.0.0.1','::1'].includes(admin.hostname)||!/(^|[_-])test([_-]|$)/i.test(adminDb))throw new Error('integration_requires_loopback_test_database')
const testDir=fs.mkdtempSync(path.join(os.tmpdir(),'pos-p3-pg-integration-'))
const createdDatabases=[]
const quoteIdentifier=name=>`"${name.replaceAll('"','""')}"`
const dbUrl=name=>{const url=new URL(adminUrl);url.pathname=`/${encodeURIComponent(name)}`;return url.toString()}
let sequence=0

async function adminQuery(sql){const client=new Client({connectionString:adminUrl});await client.connect();try{return await client.query(sql)}finally{await client.end()}}
async function createTarget(){const name=`pos_p3_test_${process.pid}_${++sequence}_${randomUUID().replaceAll('-','').slice(0,8)}`;if(!/^pos_p3_test_[0-9]+_[0-9]+_[a-f0-9]{8}$/.test(name))throw new Error('unsafe_generated_database_name');await adminQuery(`CREATE DATABASE ${quoteIdentifier(name)}`);createdDatabases.push(name);await runMigrations({env:{...process.env,POSTGRES_MIGRATION_DATABASE_URL:dbUrl(name)}});return{name,url:dbUrl(name)}}
async function removeTargets(){for(const name of createdDatabases)await adminQuery(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`).catch(()=>{})}
async function query(url,sql,params=[]){const client=new Client({connectionString:url});await client.connect();try{return await client.query(sql,params)}finally{await client.end()}}

const roles=[['emp-admin','Administrador'],['emp-waiter','Mesero'],['emp-kitchen','Cocina']]
function fixture({overlap=false,orphan=false,duplicate=false}={}){
  const state={version:8,config:{restaurantName:'Synthetic Fixture',currency:'COP',kitchen:{defaultEstimatedPrepTime:300}},activeEmployeeId:'emp-admin',
    employees:roles.map(([id,role])=>({id,name:`Fixture ${role}`,role,active:true,pin:'12345678'})),
    tables:[{id:17,name:'Mesa 17',active:true,shape:'round',x:1,y:2,seats:2,sizeScale:1,joinedWith:['B-2']},{id:'B-2',name:'Mesa B-2',active:true,shape:'wide',x:10,y:20,seats:4,sizeScale:1.1,joinedWith:[17]}],
    categories:[{id:'cat-soup',name:'Sopas',active:true,sortOrder:1}],
    ingredients:[{id:'ing-flour',name:'Harina',category:'Secos',unit:'g',costPerUnit:0.125,minStock:5,stock:90,baseStock:100,active:true}],
    extras:[{id:'extra-cheese',name:'Queso',category:'Extras',price:0.5,active:true,ingredientIds:['ing-flour'],ingredientUsage:{'ing-flour':10},ingredientUsageUnit:{'ing-flour':'g'}}],
    products:[{id:'prod-soup',name:'Sopa',description:'Caldo',price:4.5,categoryId:'cat-soup',isActive:true,estimatedPrepTime:300,ingredients:['ing-flour'],ingredientUsage:{'ing-flour':10},ingredientUsageUnit:{'ing-flour':'g'},extraIds:['extra-cheese'],image:''}],
    customers:[{id:'customer-A',name:'Synthetic Customer',phone:'5550101',email:'fixture@example.invalid',notes:'test only'}],
    reservations:[{id:'reservation-A',customerId:'customer-A',customerName:'Synthetic Customer',tableId:17,reservedFor:1730000000000,partySize:2,status:'confirmada',notes:'synthetic',createdAt:1729990000000}],
    orders:[
      {id:'order-A',number:21,tableId:17,tableName:'Mesa 17',orderType:'mesa',customerId:'customer-A',reservationId:'reservation-A',status:'ENTREGADO',items:[{id:'line-A',productId:'prod-soup',productName:'Sopa',basePrice:4.5,quantity:1,extras:[{id:'extra-cheese',name:'Queso',price:0.5}],removedIngredients:['onion'],note:'sin cebolla',estimatedPrepTime:300}],total:5,createdAt:1730000000000,updatedAt:1730000001000,employeeId:'emp-waiter'},
      {id:'order-B',number:22,tableId:'B-2',tableName:'Mesa B-2',orderType:'mesa',status:'ENTREGADO',items:[{id:'line-B',productId:'prod-soup',productName:'Sopa',basePrice:4.5,quantity:1,extras:[],removedIngredients:[],note:'',estimatedPrepTime:300}],total:4.5,createdAt:1730000000000,updatedAt:1730000001000,employeeId:'emp-waiter'},
    ],
    sales:[{id:'sale-A',createdAt:1730000002000,tableId:17,tableName:'Mesa 17',orderIds:overlap?['order-A','order-B']:['order-A','order-B'],customerId:'customer-A',reservationId:'reservation-A',orderType:'mesa',subtotal:9.5,discount:0.1,netTotal:9.4,tip:0.2,total:9.6,paymentMethod:'Combinado',paymentBreakdown:{Efectivo:3.3,Tarjeta:6.3},people:2,employeeId:'emp-admin',cashReceived:3.3,cashChange:0}],
    cash:{isOpen:true,openingAmount:20,openedAt:1730000000000,openedBy:'emp-admin',closings:[],movements:[{id:'cash-move-A',type:'expense',amount:1.2,reason:'fixture expense',createdAt:1730000003000,employeeId:'emp-admin',paymentMethod:'Efectivo'}]},
    documents:[{id:'receipt-A',type:'comprobante',createdAt:1730000002000,saleId:'sale-A',customerId:'customer-A',items:[{productName:'Sopa',quantity:1,unitPrice:4.5,extras:[{name:'Queso',price:0.5}],subtotal:5},{productName:'Sopa',quantity:1,unitPrice:4.5,extras:[],subtotal:4.5}],subtotal:9.5,discount:0.1,tip:0.2,total:9.6}],
    inventoryMovements:[{id:'inventory-A',type:'sale',ingredientId:orphan?'missing-ingredient':'ing-flour',ingredientName:'Harina',quantity:-10,unit:'g',stockBefore:100,stockAfter:90,saleId:'sale-A',employeeId:'emp-admin',reason:'sale consumption recorded in source',createdAt:1730000002000}],
    audit:[{id:'audit-A',action:'venta_cerrada',employeeId:'emp-admin',createdAt:1730000002000,data:{saleId:'sale-A'}}],
    soundPresets:{cash:{type:'click'}},ingredientCategories:['Secos'],extraCategories:['Extras']}
  if(overlap)state.sales.push({...state.sales[0],id:'sale-B',orderIds:['order-B']})
  if(duplicate)state.categories.push({...state.categories[0]})
  if(orphan)state.orders[0].tableId='missing-table'
  return state
}

function createSource(file,state=fixture()){
  const db=new DatabaseSync(file)
  db.exec('CREATE TABLE app_state(id INTEGER PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE employee_credentials(employee_id TEXT PRIMARY KEY, scheme TEXT, salt BLOB, password_hash BLOB, credential_state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);')
  db.prepare('INSERT INTO app_state VALUES(1,8,?,1730000000000)').run(JSON.stringify(state))
  const insert=db.prepare('INSERT INTO employee_credentials VALUES(?,?,?,?,?,?,?)')
  insert.run('emp-admin','scrypt-v1',Buffer.alloc(16,1),Buffer.alloc(32,11),'active',1730000000000,1730000000000)
  insert.run('emp-waiter','scrypt-v1',Buffer.alloc(16,2),Buffer.alloc(32,12),'must_change',1730000000000,1730000000000)
  insert.run('emp-kitchen',null,null,null,'reset_required',1730000000000,1730000000000)
  db.close()
}

function sourcePaths(label,state=fixture()){const dir=path.join(testDir,label);fs.mkdirSync(dir,{recursive:true});const source=path.join(dir,'synthetic-source.sqlite'),active=path.join(dir,'active-db-not-opened.sqlite'),report=path.join(dir,'report.json');fs.writeFileSync(active,'this sentinel is never opened as SQLite');createSource(source,state);return{sourcePath:source,activePath:active,reportPath:report}}

async function countRows(url){const result=await query(url,"SELECT (SELECT count(*) FROM restaurants) AS restaurants,(SELECT count(*) FROM employees) AS employees,(SELECT count(*) FROM sales) AS sales,(SELECT count(*) FROM legacy_import_runs) AS imports");return Object.fromEntries(Object.entries(result.rows[0]).map(([k,v])=>[k,Number(v)]))}
const importFixture=options=>runSqlitePostgresImport({...options,confirmedLegacySalesCurrency:'COP'})

try{
  const source=sourcePaths('main')
  const target=await createTarget()
  const dry=await importFixture({...source,restaurantId:'restaurant-p3-test',dryRun:true,connectionString:target.url})
  assert.equal(dry.status,'preflight_passed')
  assert.deepEqual(await countRows(target.url),{restaurants:0,employees:0,sales:0,imports:0},'preflight must not write target records')
  const report=await importFixture({...source,restaurantId:'restaurant-p3-test',connectionString:target.url})
  assert.equal(report.status,'accepted')
  assert.deepEqual(await query(target.url,"SELECT id FROM employees WHERE restaurant_id=$1 ORDER BY id",['restaurant-p3-test']).then(x=>x.rows.map(x=>x.id)),['emp-admin','emp-kitchen','emp-waiter'])
  assert.deepEqual(await query(target.url,"SELECT employee_id,credential_state FROM employee_credentials WHERE restaurant_id=$1 ORDER BY employee_id",['restaurant-p3-test']).then(x=>x.rows.map(x=>[x.employee_id,x.credential_state])),[['emp-admin','active'],['emp-kitchen','reset_required'],['emp-waiter','must_change']])
  assert.deepEqual(await query(target.url,"SELECT order_id FROM sale_orders WHERE restaurant_id=$1 ORDER BY order_id",['restaurant-p3-test']).then(x=>x.rows.map(x=>x.order_id)),['order-A','order-B'])
  assert.equal((await query(target.url,"SELECT count(*)::int AS n FROM table_group_members WHERE restaurant_id=$1",['restaurant-p3-test'])).rows[0].n,2)
  assert.deepEqual((await query(target.url,"SELECT product_id,version,created_by FROM product_recipe_versions WHERE restaurant_id=$1",['restaurant-p3-test'])).rows,[{product_id:'prod-soup',version:1,created_by:null}])
  assert.deepEqual((await query(target.url,"SELECT count(*)::int AS n FROM payments WHERE restaurant_id=$1",['restaurant-p3-test'])).rows[0].n,2)
  assert.deepEqual((await query(target.url,"SELECT id,order_number FROM orders WHERE restaurant_id=$1 ORDER BY id",['restaurant-p3-test'])).rows,[{id:'order-A',order_number:21},{id:'order-B',order_number:22}])
  assert.deepEqual((await query(target.url,"SELECT ingredient_id,sale_id,quantity_delta::text FROM inventory_movements WHERE restaurant_id=$1",['restaurant-p3-test'])).rows,[{ingredient_id:'ing-flour',sale_id:'sale-A',quantity_delta:'-10'}])
  assert.equal((await query(target.url,"SELECT total::text FROM sales WHERE restaurant_id=$1 AND id='sale-A'",['restaurant-p3-test'])).rows[0].total,'9.6')
  assert.equal((await query(target.url,"SELECT sum(amount)::text AS total FROM payments WHERE restaurant_id=$1 AND sale_id='sale-A'",['restaurant-p3-test'])).rows[0].total,'9.6')
  assert.equal((await query(target.url,"SELECT status FROM legacy_import_runs WHERE restaurant_id=$1",['restaurant-p3-test'])).rows[0].status,'completed')
  const manifestCounts=(await query(target.url,"SELECT imported_counts FROM legacy_import_runs WHERE restaurant_id=$1",['restaurant-p3-test'])).rows[0].imported_counts
  for(const table of insertOrder){const tenantColumn=table==='restaurants'?'id':'restaurant_id';const actual=Number((await query(target.url,`SELECT count(*)::int AS n FROM public."${table}" WHERE "${tenantColumn}"=$1`,['restaurant-p3-test'])).rows[0].n);assert.equal(actual,Number(manifestCounts[table]||0),`committed target count for ${table} must match the accepted import manifest`)}
  assert.equal((await query(target.url,"SELECT count(*)::int AS n FROM audit_events WHERE details->>'provenance'='legacy_unverified'")).rows[0].n,1)
  const reportText=fs.readFileSync(source.reportPath,'utf8')
  assert.doesNotMatch(reportText,/12345678|password_hash|salt|Synthetic Customer|fixture@example/)
  await assert.rejects(importFixture({...source,restaurantId:'restaurant-p3-test',connectionString:target.url}),/postgres_target_must_be_empty/)
  assert.deepEqual(await countRows(target.url),{restaurants:1,employees:3,sales:1,imports:1},'rerun must not duplicate accepted records')

  const malformedTarget=await createTarget(),malformedSource=sourcePaths('malformed-mapping')
  const malformedMapping=await importFixture({...malformedSource,restaurantId:'malformed-map-test',connectionString:malformedTarget.url,rowBuilder:(...args)=>{const built=buildRows(...args);built.rows.sales.data[0].pop();return built}})
  assert.equal(malformedMapping.status,'blocked')
  assert.ok(malformedMapping.diagnostics.some(item=>item.code==='row_column_arity_mismatch'&&item.entity==='sales'))
  assert.deepEqual(await countRows(malformedTarget.url),{restaurants:0,employees:0,sales:0,imports:0},'malformed mappings must be blocked before target transaction writes')

  const overlapSource=sourcePaths('overlap',fixture({overlap:true}))
  const blocked=await importFixture({...overlapSource,restaurantId:'blocked-test',dryRun:true,connectionString:target.url})
  assert.equal(blocked.status,'blocked')
  assert.ok(blocked.diagnostics.some(x=>x.code==='overlapping_sale_order_reference'))
  assert.doesNotMatch(fs.readFileSync(overlapSource.reportPath,'utf8'),/password_hash|salt|12345678|Synthetic Customer/)

  const orphanSource=sourcePaths('orphan',fixture({orphan:true}))
  const orphan=await importFixture({...orphanSource,restaurantId:'orphan-test',dryRun:true,connectionString:target.url})
  assert.ok(orphan.diagnostics.some(x=>x.code==='missing_table'))
  const duplicateSource=sourcePaths('duplicate',fixture({duplicate:true}))
  const duplicate=await importFixture({...duplicateSource,restaurantId:'duplicate-test',dryRun:true,connectionString:target.url})
  assert.ok(duplicate.diagnostics.some(x=>x.code==='duplicate_id_after_text_normalization'))

  const rollbackTarget=await createTarget(),rollbackSource=sourcePaths('rollback')
  class FailingClient extends Client { async query(sql,...args){const result=await super.query(sql,...args);if(typeof sql==='string'&&sql.includes('INSERT INTO public.legacy_import_runs'))await super.query('SELECT 1/0');return result} }
  await assert.rejects(importFixture({...rollbackSource,restaurantId:'rollback-test',connectionString:rollbackTarget.url,pgClient:FailingClient}),/postgres_sql_error/)
  const rollbackDiagnostic=JSON.parse(fs.readFileSync(rollbackSource.reportPath,'utf8')).diagnostics.at(-1)
  assert.equal(rollbackDiagnostic.stage,'manifest')
  assert.equal(rollbackDiagnostic.sqlstate,'22012')
  assert.doesNotMatch(JSON.stringify(rollbackDiagnostic),/SELECT|password|secret|Fixture/)
  assert.deepEqual(await countRows(rollbackTarget.url),{restaurants:0,employees:0,sales:0,imports:0},'database error after inserts must roll back all imported rows')

  const interruptedTarget=await createTarget(),interruptedSource=sourcePaths('interrupted')
  class InterruptedClient extends Client { async query(sql,...args){const result=await super.query(sql,...args);if(typeof sql==='string'&&sql.includes('INSERT INTO public.legacy_import_runs'))await super.query('SELECT pg_terminate_backend(pg_backend_pid())');return result} }
  await assert.rejects(importFixture({...interruptedSource,restaurantId:'interrupted-test',connectionString:interruptedTarget.url,pgClient:InterruptedClient}))
  assert.deepEqual(await countRows(interruptedTarget.url),{restaurants:0,employees:0,sales:0,imports:0},'disconnect during transaction must leave no partial target')
  const recovered=await importFixture({...interruptedSource,restaurantId:'interrupted-test',connectionString:interruptedTarget.url})
  assert.equal(recovered.status,'accepted','a rolled back interrupted import must be safely repeatable')
  assert.deepEqual(await countRows(interruptedTarget.url),{restaurants:1,employees:3,sales:1,imports:1})

  const concurrentTarget=await createTarget(),concurrentSource=sourcePaths('concurrent')
  const concurrent=await Promise.allSettled([1,2].map(index=>importFixture({...concurrentSource,reportPath:path.join(path.dirname(concurrentSource.reportPath),`report-${index}.json`),restaurantId:'concurrent-test',connectionString:concurrentTarget.url})))
  assert.equal(concurrent.filter(item=>item.status==='fulfilled').length,1,'exactly one concurrent import may be accepted')
  assert.deepEqual(await countRows(concurrentTarget.url),{restaurants:1,employees:3,sales:1,imports:1})

  const largeTarget=await createTarget(),largeState=fixture(),largeAmount=Number.MAX_SAFE_INTEGER
  largeState.products[0].price=largeAmount
  largeState.orders[0].items[0]={id:'line-large',productId:'prod-soup',productName:'Sopa',basePrice:largeAmount,quantity:1,extras:[],removedIngredients:[],note:'',estimatedPrepTime:300}
  largeState.orders[0].total=largeAmount
  largeState.orders[1].items[0]={id:'line-zero',productId:'prod-soup',productName:'Sopa',basePrice:0,quantity:1,extras:[],removedIngredients:[],note:'',estimatedPrepTime:300}
  largeState.orders[1].total=0
  Object.assign(largeState.sales[0],{subtotal:largeAmount,discount:0,netTotal:largeAmount,tip:0,total:largeAmount,paymentBreakdown:{Efectivo:largeAmount},cashReceived:largeAmount,cashChange:0})
  largeState.documents[0].items=[{productName:'Sopa',quantity:1,unitPrice:largeAmount,extras:[],subtotal:largeAmount},{productName:'Sopa',quantity:1,unitPrice:0,extras:[],subtotal:0}]
  const largeSource=sourcePaths('large-values',largeState)
  const largeReport=await importFixture({...largeSource,restaurantId:'large-test',connectionString:largeTarget.url})
  assert.equal(largeReport.status,'accepted')
  assert.equal((await query(largeTarget.url,"SELECT total::text FROM sales WHERE restaurant_id='large-test'")).rows[0].total,'9007199254740991')
  assert.equal((await query(largeTarget.url,"SELECT sum(amount)::text AS total FROM payments WHERE restaurant_id='large-test'")).rows[0].total,'9007199254740991')

  const empty=new Client({connectionString:adminUrl});await empty.connect();try{const version=await empty.query('SHOW server_version_num');assert.match(version.rows[0].server_version_num,/^18/)}finally{await empty.end()}
  console.log('SQLite-to-PostgreSQL importer integration passed against disposable PostgreSQL 18; all sources and targets were synthetic test fixtures.')
}finally{await removeTargets();fs.rmSync(testDir,{recursive:true,force:true})}
