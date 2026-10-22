import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { loadMigrations } from './postgres-migrate.mjs'
import { fileURLToPath } from 'node:url'

const { Client } = pg
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultSqlitePath = path.join(projectRoot, 'data', 'restaurante-v8.db')
const roles = new Set(['Administrador', 'Mesero', 'Cocina', 'Caja'])
const units = new Set(['g', 'kg', 'ml', 'L', 'unidad'])
const orderStatuses = new Set(['PENDIENTE', 'PREPARANDO', 'LISTO', 'ENTREGADO', 'CANCELADO'])

const fail = (code, entity = null, id = null) => ({ code, ...(entity ? { entity } : {}), ...(id !== null && /^[a-zA-Z0-9:_-]{1,80}$/.test(String(id)) ? { id: String(id) } : {}) })
const arr = value => Array.isArray(value) ? value : []
const own = (object, key) => Object.hasOwn(object || {}, key)
const textId = (id, entity) => {
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()) throw Object.assign(new Error('invalid id'), { diagnostic: fail('missing_or_invalid_id', entity) })
  if (typeof id === 'number' && !Number.isSafeInteger(id)) throw Object.assign(new Error('unsafe numeric id'), { diagnostic: fail('unsafe_numeric_id', entity) })
  return String(id)
}
const numberValue = (value, entity, id, field) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw Object.assign(new Error('invalid numeric value'), { diagnostic: fail(`invalid_${field}`, entity, id) })
  return String(value)
}
const decimalValue = (value, entity, id, field) => {
  if((typeof value!=='number'&&typeof value!=='string')||!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(String(value))||!Number.isFinite(Number(value)))throw Object.assign(new Error('invalid decimal value'),{diagnostic:fail(`invalid_${field}`,entity,id)})
  return String(value)
}
const stamp = (value, entity, id, field = 'timestamp') => {
  if(typeof value==='string'&&!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value))throw Object.assign(new Error('timezone missing'),{diagnostic:fail(`ambiguous_${field}_timezone`,entity,id)})
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (!Number.isFinite(date.getTime())) throw Object.assign(new Error('invalid timestamp'), { diagnostic: fail(`invalid_${field}`, entity, id) })
  return date.toISOString()
}
const stableId = (entity, key) => `${entity}:${createHash('sha256').update(String(key)).digest('hex').slice(0, 24)}`
const plain = value => value === undefined ? null : value
const json = value => JSON.stringify(value ?? {})

export function hasAmbiguousJsonNumbers(source){
  let inString=false,escaped=false
  for(let i=0;i<source.length;i++){
    const ch=source[i]
    if(inString){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')inString=false;continue}
    if(ch==='"'){inString=true;continue}
    if(ch==='-'||(ch>='0'&&ch<='9')){
      const match=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(i))
      if(match){const parsed=Number(match[0]);if(!Number.isFinite(parsed)||(Number.isInteger(parsed)&&!Number.isSafeInteger(parsed))||!decimalSumEquals([match[0]],String(parsed)))return true;i+=match[0].length-1}
    }
  }
  return false
}

function canonicalExistingPath(filePath) {
  try { return fs.realpathSync.native(filePath) } catch { return path.resolve(filePath) }
}

export function validateImportPaths({ sourcePath, activePath, reportPath, project = projectRoot }) {
  if (!sourcePath || !activePath || !reportPath) throw new Error('source_active_report_paths_required')
  const sourceResolved = path.resolve(sourcePath)
  const activeResolved = path.resolve(activePath)
  const protectedPaths = [activeResolved, defaultSqlitePath, process.env.DB_PATH, process.env.RESTAURANT_ACTIVE_DB_PATH].filter(Boolean)
  const sourceCanonical = canonicalExistingPath(sourceResolved).toLocaleLowerCase('en-US')
  if (protectedPaths.some(candidate => canonicalExistingPath(path.resolve(candidate)).toLocaleLowerCase('en-US') === sourceCanonical)) throw new Error('source_matches_protected_database')
  if (!fs.existsSync(sourceResolved) || !fs.statSync(sourceResolved).isFile() || fs.lstatSync(sourceResolved).isSymbolicLink()) throw new Error('source_must_be_existing_regular_file')
  if (!fs.existsSync(activeResolved) || !fs.statSync(activeResolved).isFile()) throw new Error('explicit_active_database_path_required')
  const sourceStat=fs.statSync(sourceResolved)
  for(const candidate of protectedPaths){try{const targetStat=fs.statSync(candidate);if(sourceStat.dev===targetStat.dev&&sourceStat.ino!==0&&sourceStat.ino===targetStat.ino)throw new Error('source_is_hardlink_to_protected_database')}catch(error){if(error.message==='source_is_hardlink_to_protected_database')throw error}}
  if (path.relative(path.resolve(project), sourceResolved) === '' || !path.relative(path.resolve(project), sourceResolved).startsWith('..')) throw new Error('source_must_be_outside_repository')
  const reportResolved=path.resolve(reportPath)
  if(fs.existsSync(reportResolved)&&fs.lstatSync(reportResolved).isSymbolicLink())throw new Error('report_must_not_be_symlink')
  const reportCanonical=canonicalExistingPath(reportResolved).toLocaleLowerCase('en-US')
  if(reportCanonical===sourceCanonical||protectedPaths.some(candidate=>canonicalExistingPath(path.resolve(candidate)).toLocaleLowerCase('en-US')===reportCanonical))throw new Error('report_must_not_overwrite_database')
  if(fs.existsSync(reportResolved)){const reportStat=fs.statSync(reportResolved);for(const candidate of protectedPaths){try{const candidateStat=fs.statSync(candidate);if(reportStat.dev===candidateStat.dev&&reportStat.ino!==0&&reportStat.ino===candidateStat.ino)throw new Error('report_must_not_overwrite_database')}catch(error){if(error.message==='report_must_not_overwrite_database')throw error}}}
  return { sourcePath: sourceResolved, activePath: canonicalExistingPath(activeResolved), reportPath: reportResolved }
}

export function readSnapshot(sourcePath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-p3-source-'))
  const snapshotPath = path.join(tempDir, 'snapshot.sqlite')
  try {
    const source = new DatabaseSync(sourcePath, { readOnly: true })
    try {
      const quoted = snapshotPath.replaceAll("'", "''")
      source.exec(`VACUUM INTO '${quoted}'`)
    } finally { source.close() }
    const db = new DatabaseSync(snapshotPath, { readOnly: true })
    try {
    const integrity=db.prepare('PRAGMA integrity_check').get()?.integrity_check
    if(integrity!=='ok')throw new Error('sqlite_snapshot_integrity_check_failed')
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name))
    if (!tables.has('app_state') || !tables.has('employee_credentials')) throw new Error('source_schema_must_include_app_state_and_employee_credentials')
    const appColumns=db.prepare('PRAGMA table_info(app_state)').all().map(row=>row.name).sort().join(',')
    if(appColumns!==['data','id','updated_at','version'].join(','))throw new Error('unsupported_app_state_schema')
    const stateRows = db.prepare('SELECT id, version, data, updated_at FROM app_state').all()
    if (stateRows.length !== 1 || Number(stateRows[0].id) !== 1 || Number(stateRows[0].version) !== 8) throw new Error('source_must_have_single_v8_state')
    const state = JSON.parse(stateRows[0].data)
    if (!state || Number(state.version) !== 8 || typeof state !== 'object') throw new Error('invalid_v8_state')
    const credentialColumns = db.prepare('PRAGMA table_info(employee_credentials)').all().map(row => row.name).sort().join(',')
    if (credentialColumns !== ['created_at','credential_state','employee_id','password_hash','salt','scheme','updated_at'].sort().join(',')) throw new Error('unsupported_credential_schema')
    const credentials = db.prepare('SELECT employee_id, scheme, salt, password_hash, credential_state, created_at, updated_at FROM employee_credentials ORDER BY employee_id').all().map(row=>({...row,salt:row.salt?Buffer.from(row.salt):null,password_hash:row.password_hash?Buffer.from(row.password_hash):null}))
    const sourceSha256=createHash('sha256').update(JSON.stringify({data:stateRows[0].data,credentials:credentials.map(row=>({employee_id:row.employee_id,scheme:row.scheme,salt:row.salt?.toString('hex')||null,password_hash:row.password_hash?.toString('hex')||null,credential_state:row.credential_state,created_at:row.created_at,updated_at:row.updated_at}))})).digest('hex')
    return { state, credentials, sourceVersion: 8, sourceUpdatedAt: stateRows[0].updated_at, sourceSha256, numericPrecisionAmbiguous:hasAmbiguousJsonNumbers(stateRows[0].data) }
    } finally { db.close() }
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {}
  }
}

function uniqueEntities(items, type, diagnostics) {
  const map = new Map()
  for (const item of arr(items)) {
    try {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid')
      const id = textId(item.id, type)
      if (map.has(id)) diagnostics.push(fail('duplicate_id_after_text_normalization', type, id))
      else map.set(id, item)
    } catch (error) { diagnostics.push(error.diagnostic || fail('invalid_entity', type)) }
  }
  return map
}

function decimalParts(value){
  let raw=String(value)
  const sign=raw.startsWith('-')?-1n:1n
  raw=raw.replace(/^[+-]/,'')
  const [coefficient,exponentText]=raw.toLowerCase().split('e')
  const exponent=Number(exponentText||0)
  const [whole,fraction='']=coefficient.split('.')
  let digits=`${whole}${fraction}`.replace(/^0+(?=\d)/,'')||'0'
  let scale=fraction.length-exponent
  if(scale<0){digits+=`0`.repeat(-scale);scale=0}
  return {integer:sign*BigInt(digits),scale}
}
function decimalString(integer,scale){let rendered=(integer<0n?-integer:integer).toString();if(scale){rendered=rendered.padStart(scale+1,'0');rendered=`${rendered.slice(0,-scale)}.${rendered.slice(-scale)}`.replace(/\.?0+$/,'')};return `${integer<0n?'-':''}${rendered||'0'}`}
function decimalAggregate(values){const parts=values.map(decimalParts);const scale=Math.max(0,...parts.map(item=>item.scale));const integer=parts.reduce((sum,item)=>sum+item.integer*10n**BigInt(scale-item.scale),0n);return decimalString(integer,scale)}
function decimalAdd(values){const parts=values.map(decimalParts);const scale=Math.max(0,...parts.map(item=>item.scale));const integer=parts.reduce((sum,item)=>sum+item.integer*10n**BigInt(scale-item.scale),0n);return decimalString(integer,scale)}
function decimalMultiply(left,right){const a=decimalParts(left),b=decimalParts(right);return decimalString(a.integer*b.integer,a.scale+b.scale)}
function orderLineAmount(item){const quantity=item?.quantity,base=item?.basePrice??item?.price,extras=arr(item?.extras);if(quantity==null||base==null||![quantity,base,...extras.flatMap(extra=>[extra.price??0,extra.quantity??1])].every(value=>Number.isFinite(Number(value))))return null;return decimalMultiply(decimalAdd([base,...extras.map(extra=>decimalMultiply(extra.price??0,extra.quantity??1))]),quantity)}
function decimalSumEquals(values,expected){const parts=values.map(decimalParts),other=decimalParts(expected),scale=Math.max(other.scale,...parts.map(item=>item.scale));const sum=parts.reduce((acc,item)=>acc+item.integer*10n**BigInt(scale-item.scale),0n);return sum===other.integer*10n**BigInt(scale-other.scale)}

export function validateState(state, credentials, confirmedLegacySalesCurrency = null, numericPrecisionAmbiguous = false) {
  const diagnostics = []
  if(numericPrecisionAmbiguous)diagnostics.push(fail('json_number_precision_lost_during_javascript_parse','application_state'))
  const inspectSensitive=(value,entity,id,pathParts=[])=>{if(!value||typeof value!=='object')return;for(const [key,child] of Object.entries(value)){if(/pin|password|token|secret|credential|salt|hash/i.test(key)&&!(entity==='employees'&&key==='pin'))diagnostics.push(fail('unexpected_sensitive_field',entity,id));else if(child&&typeof child==='object')inspectSensitive(child,entity,id,[...pathParts,key])}}
  const allowedRoot=new Set(['version','config','tables','categories','products','ingredients','ingredientCategories','extras','extraCategories','orders','employees','customers','reservations','sales','cash','documents','inventoryMovements','audit','soundPresets','activeEmployeeId','workMode','updatedAt'])
  for(const key of Object.keys(state))if(!allowedRoot.has(key))diagnostics.push(fail('unsupported_root_field','application_state',key))
  inspectSensitive(state.config,'settings','config');inspectSensitive(state.soundPresets,'settings','soundPresets')
  if(!['COP','USD'].includes(state.config?.currency))diagnostics.push(fail('unknown_restaurant_currency','settings'))
  const maps = {}
  for (const key of ['employees','tables','categories','products','ingredients','extras','orders','customers','reservations','sales','documents','inventoryMovements','audit']) maps[key] = uniqueEntities(state[key], key, diagnostics)
  maps.cashMovements=uniqueEntities(state.cash?.movements,'cashMovements',diagnostics)
  const supportedFields={
    employees:['id','name','role','active','pin','createdAt','updatedAt'],
    tables:['id','name','active','shape','x','y','seats','sizeScale','joinedWith','updatedAt'],
    categories:['id','name','active','sortOrder','updatedAt'],
    products:['id','name','description','price','categoryId','isActive','active','estimatedPrepTime','ingredients','ingredientIds','ingredientUsage','ingredientUsageUnit','extraIds','image','createdAt','updatedAt'],
    ingredients:['id','name','category','categoryId','categoryName','unit','costPerUnit','minStock','stock','baseStock','active','createdAt','updatedAt'],
    extras:['id','name','category','price','active','ingredientIds','ingredients','ingredientUsage','ingredientUsageUnit','createdAt','updatedAt'],
    orders:['id','number','tableId','tableName','orderType','customerId','reservationId','deliveryAddress','status','items','total','createdAt','sentToKitchenAt','estimatedPrepTime','updatedAt','employeeId','sourceOrderId','sourceOrderNumber','completedAt','closedAt','paymentMethod','tip','discount','paidTotal','paymentBreakdown'],
    customers:['id','name','phone','email','notes','createdAt','updatedAt'],
    reservations:['id','customerId','customerName','tableId','reservedFor','date','partySize','people','status','notes','createdAt','phone'],
    sales:['id','createdAt','tableId','tableName','orderIds','customerId','reservationId','orderType','subtotal','discount','netTotal','tip','total','paymentMethod','paymentBreakdown','people','employeeId','inventoryDeducted','cashReceived','cashChange','currencyCode'],
    documents:['id','type','createdAt','saleId','customerId','orderType','restaurantName','tableName','employeeId','items','subtotal','discount','tip','total','paymentMethod','paymentBreakdown','people','cashReceived','cashChange'],
    inventoryMovements:['id','type','ingredientId','ingredientName','quantity','unit','stockBefore','stockAfter','saleId','employeeId','reason','createdAt'],
    audit:['id','action','data','employeeId','createdAt'],
    cashMovements:['id','type','amount','reason','createdAt','employeeId','paymentMethod','saleId'],
  }
  for(const [entity,entities] of Object.entries(maps))for(const [id,item] of entities){inspectSensitive(item,entity,id);for(const field of Object.keys(item))if(!(supportedFields[entity]||[]).includes(field))diagnostics.push(fail('unsupported_legacy_field',entity,`${id}_${field}`))}
  const itemFields=new Set(['id','productId','productName','basePrice','price','estimatedPrepTime','quantity','extras','removedIngredients','note','createdAt'])
  for(const [orderId,order] of maps.orders)for(const [index,item] of arr(order.items).entries()){
    for(const field of Object.keys(item||{}))if(!itemFields.has(field))diagnostics.push(fail('unsupported_order_line_field','orders',`${orderId}_${index}_${field}`))
    if(!Number.isFinite(Number(item.quantity))||Number(item.quantity)<=0||!Number.isFinite(Number(item.basePrice??item.price))||Number(item.basePrice??item.price)<0||!Array.isArray(item.removedIngredients||[]))diagnostics.push(fail('invalid_order_line_values','orders',`${orderId}_${index}`))
  }
  const extraFields=new Set(['id','extraId','name','price','quantity'])
  for(const [orderId,order] of maps.orders)for(const [index,item] of arr(order.items).entries())for(const extra of arr(item.extras))for(const field of Object.keys(extra||{}))if(!extraFields.has(field))diagnostics.push(fail('unsupported_order_modifier_field','orders',`${orderId}_${index}_${field}`))
  const receiptFields=new Set(['productName','quantity','unitPrice','extras','subtotal'])
  for(const [documentId,document] of maps.documents)for(const [index,item] of arr(document.items).entries()){
    for(const field of Object.keys(item||{}))if(!receiptFields.has(field))diagnostics.push(fail('unsupported_receipt_line_field','documents',`${documentId}_${index}_${field}`))
    if(!Number.isFinite(Number(item.quantity))||Number(item.quantity)<=0||!Number.isFinite(Number(item.unitPrice))||Number(item.unitPrice)<0||!Number.isFinite(Number(item.subtotal))||Number(item.subtotal)<0)diagnostics.push(fail('invalid_receipt_line_values','documents',`${documentId}_${index}`))
  }
  for(const [documentId,document] of maps.documents)for(const [index,item] of arr(document.items).entries())for(const extra of arr(item.extras))for(const field of Object.keys(extra||{}))if(!['id','extraId','name','price','quantity'].includes(field))diagnostics.push(fail('unsupported_receipt_modifier_field','documents',`${documentId}_${index}_${field}`))
  if(state.cash&&Object.keys(state.cash).some(field=>!['isOpen','openingAmount','openedAt','openedBy','closings','movements','updatedAt','lastClosedAt','lastDifference'].includes(field)))diagnostics.push(fail('unsupported_cash_state_field','cash'))
  for(const [index,closing] of arr(state.cash?.closings).entries())for(const field of Object.keys(closing||{}))if(!['id','createdAt','openedAt','openingAmount','expectedAmount','countedAmount','difference','closedBy','openedBy'].includes(field))diagnostics.push(fail('unsupported_cash_closing_field','cash_sessions',`${index}_${field}`))
  const credentialByEmployee = new Map()
  for (const credential of credentials) {
    const id = String(credential.employee_id)
    if (credentialByEmployee.has(id)) diagnostics.push(fail('duplicate_credential', 'employees', id))
    credentialByEmployee.set(id, credential)
    if (!['active','must_change','reset_required'].includes(credential.credential_state)) diagnostics.push(fail('unknown_credential_state', 'employees', id))
    if (credential.credential_state === 'reset_required') {
      if (credential.scheme !== null || credential.salt !== null || credential.password_hash !== null) diagnostics.push(fail('reset_required_credential_has_verifier', 'employees', id))
    } else if (credential.scheme !== 'scrypt-v1' || !credential.salt || credential.salt.length !== 16 || !credential.password_hash || credential.password_hash.length !== 32) diagnostics.push(fail('invalid_credential_verifier', 'employees', id))
  }
  for (const [id, employee] of maps.employees) {
    if (!roles.has(employee.role) || typeof employee.active !== 'boolean') diagnostics.push(fail('invalid_employee_role_or_active', 'employees', id))
    if (!credentialByEmployee.has(id)) diagnostics.push(fail('missing_credential', 'employees', id))
    if (own(employee, 'pin')) delete employee.pin
  }
  for (const id of credentialByEmployee.keys()) if (!maps.employees.has(id)) diagnostics.push(fail('orphan_credential', 'employees', id))
  for (const [id, product] of maps.products) if (!maps.categories.has(String(product.categoryId))) diagnostics.push(fail('missing_category', 'products', id))
  for(const [id,product] of maps.products)if(!Number.isFinite(Number(product.price))||Number(product.price)<0||!Number.isSafeInteger(Number(product.estimatedPrepTime))||Number(product.estimatedPrepTime)<0)diagnostics.push(fail('invalid_product_price_or_prep_time','products',id))
  for(const [id,product] of maps.products)for(const extraId of arr(product.extraIds))if(!maps.extras.has(String(extraId)))diagnostics.push(fail('missing_product_modifier','products',id))
  for(const [id,extra] of maps.extras)for(const ingredientId of arr(extra.ingredientIds||extra.ingredients))if(!maps.ingredients.has(String(ingredientId)))diagnostics.push(fail('missing_modifier_ingredient','extras',id))
  for (const [id, order] of maps.orders) {
    if (!orderStatuses.has(order.status)) diagnostics.push(fail('unknown_order_status', 'orders', id))
    if (order.tableId != null && !maps.tables.has(String(order.tableId))) diagnostics.push(fail('missing_table', 'orders', id))
    if (order.customerId != null && !maps.customers.has(String(order.customerId))) diagnostics.push(fail('missing_customer', 'orders', id))
    if (order.reservationId != null && !maps.reservations.has(String(order.reservationId))) diagnostics.push(fail('missing_reservation', 'orders', id))
    if (order.employeeId != null && !maps.employees.has(String(order.employeeId))) diagnostics.push(fail('missing_employee', 'orders', id))
    if (order.sourceOrderId != null && !maps.orders.has(String(order.sourceOrderId))) diagnostics.push(fail('missing_source_order', 'orders', id))
    if (!['mesa','pickup','delivery'].includes(order.orderType)) diagnostics.push(fail('unknown_order_type','orders',id))
    if (!Array.isArray(order.items)) diagnostics.push(fail('order_items_not_array', 'orders', id))
    else {const lineAmounts=order.items.map(orderLineAmount);if(lineAmounts.some(value=>value===null)||!decimalSumEquals(lineAmounts,order.total))diagnostics.push(fail('order_line_totals_mismatch','orders',id))}
  }
  const orderNumbers=new Map();for(const [id,order] of maps.orders){const n=Number(order.number);if(!Number.isSafeInteger(n)||n<1)diagnostics.push(fail('invalid_order_number','orders',id));else if(orderNumbers.has(n))diagnostics.push(fail('duplicate_order_number','orders',id));else orderNumbers.set(n,id)}
  const claimedOrders = new Map()
  for (const [saleId, sale] of maps.sales) {
    const orderIds = arr(sale.orderIds).map(String)
    if (!orderIds.length) diagnostics.push(fail('sale_without_order_reference', 'sales', saleId))
    for (const orderId of orderIds) {
      if (!maps.orders.has(orderId)) diagnostics.push(fail('missing_order_reference', 'sales', saleId))
      if (claimedOrders.has(orderId)) diagnostics.push(fail('overlapping_sale_order_reference', 'sales', saleId))
      else claimedOrders.set(orderId, saleId)
    }
    const subtotal = Number(sale.subtotal), discount = Number(sale.discount || 0), net = Number(sale.netTotal), tip = Number(sale.tip || 0), total = Number(sale.total)
    if (![subtotal,discount,net,tip,total].every(Number.isFinite) || !decimalSumEquals([sale.subtotal,-Number(sale.discount||0)],sale.netTotal) || !decimalSumEquals([sale.netTotal||0,sale.tip||0],sale.total)) diagnostics.push(fail('inconsistent_sale_totals', 'sales', saleId))
    if(subtotal<0||discount<0||net<0||tip<0||total<0||discount>subtotal||!Number.isSafeInteger(Number(sale.people))||Number(sale.people)<1)diagnostics.push(fail('invalid_sale_values','sales',saleId))
    const breakdown = Object.values(sale.paymentBreakdown || {}).map(Number)
    if (breakdown.some(v => !Number.isFinite(v) || v < 0) || (breakdown.length && !decimalSumEquals(Object.values(sale.paymentBreakdown),sale.total))) diagnostics.push(fail('inconsistent_payment_breakdown', 'sales', saleId))
    if(sale.currencyCode!=null&&!['COP','USD'].includes(sale.currencyCode))diagnostics.push(fail('unknown_sale_currency','sales',saleId))
    if(sale.employeeId!=null&&!maps.employees.has(String(sale.employeeId)))diagnostics.push(fail('missing_employee','sales',saleId))
    if(sale.tableId!=null&&!maps.tables.has(String(sale.tableId)))diagnostics.push(fail('missing_table','sales',saleId))
    if(sale.customerId!=null&&!maps.customers.has(String(sale.customerId)))diagnostics.push(fail('missing_customer','sales',saleId))
    if(sale.reservationId!=null&&!maps.reservations.has(String(sale.reservationId)))diagnostics.push(fail('missing_reservation','sales',saleId))
    if(sale.currencyCode==null&&confirmedLegacySalesCurrency==null)diagnostics.push(fail('historical_sale_currency_requires_explicit_reconciliation','sales',saleId))
    if(!sale.paymentBreakdown||typeof sale.paymentBreakdown!=='object'||Array.isArray(sale.paymentBreakdown)||Object.keys(sale.paymentBreakdown).length===0)diagnostics.push(fail('historical_payment_breakdown_missing','sales',saleId))
    const receipts=[...maps.documents.values()].filter(document=>String(document.saleId)===saleId&&Array.isArray(document.items))
    if(!receipts.length)diagnostics.push(fail('sale_missing_accepted_item_snapshot','sales',saleId))
    if(receipts.length>1)diagnostics.push(fail('multiple_sale_item_snapshots_ambiguous','sales',saleId))
    if(receipts.length===1&&!decimalSumEquals(receipts[0].items.map(item=>item.subtotal),sale.subtotal))diagnostics.push(fail('receipt_sale_subtotal_mismatch','sales',saleId))
  }
  for (const [id, movement] of maps.inventoryMovements) {
    if (!maps.ingredients.has(String(movement.ingredientId))) diagnostics.push(fail('missing_ingredient', 'inventoryMovements', id))
    if (movement.saleId != null && !maps.sales.has(String(movement.saleId))) diagnostics.push(fail('missing_sale', 'inventoryMovements', id))
    if (!units.has(movement.unit) || !Number.isFinite(Number(movement.quantity)) || Number(movement.quantity) === 0) diagnostics.push(fail('unsupported_inventory_movement', 'inventoryMovements', id))
    if (movement.type === 'sale' && !movement.saleId) diagnostics.push(fail('sale_movement_missing_sale_source', 'inventoryMovements', id))
    if(maps.ingredients.has(String(movement.ingredientId))&&movement.unit!==maps.ingredients.get(String(movement.ingredientId)).unit)diagnostics.push(fail('inventory_movement_unit_mismatch','inventoryMovements',id))
  }
  for (const [id, doc] of maps.documents) if (doc.saleId == null || !maps.sales.has(String(doc.saleId))) diagnostics.push(fail('missing_sale', 'documents', id))
  for(const [id,event] of maps.audit)if(event.employeeId!=null&&!maps.employees.has(String(event.employeeId)))diagnostics.push(fail('missing_employee','audit',id))
  for(const [id,movement] of maps.cashMovements){if(!['expense','income'].includes(movement.type))diagnostics.push(fail('unknown_cash_movement_type','cash_movements',id));if(movement.employeeId!=null&&!maps.employees.has(String(movement.employeeId)))diagnostics.push(fail('missing_employee','cash_movements',id));if(movement.saleId!=null&&!maps.sales.has(String(movement.saleId)))diagnostics.push(fail('missing_sale','cash_movements',id))}
  for (const [id, reservation] of maps.reservations) {
    if (reservation.customerId != null && !maps.customers.has(String(reservation.customerId))) diagnostics.push(fail('missing_customer', 'reservations', id))
    if (reservation.tableId != null && !maps.tables.has(String(reservation.tableId))) diagnostics.push(fail('missing_table', 'reservations', id))
    if(reservation.status!=null&&!['pending','confirmed','seated','cancelled','pendiente','confirmada','atendida','cancelada'].includes(reservation.status))diagnostics.push(fail('unknown_reservation_status','reservations',id))
  }
  for(const [id,table] of maps.tables)if(!Number.isSafeInteger(Number(table.seats))||Number(table.seats)<1||Number(table.seats)>12||!Number.isFinite(Number(table.x))||!Number.isFinite(Number(table.y))||!Number.isFinite(Number(table.sizeScale??1))||Number(table.sizeScale??1)<=0)diagnostics.push(fail('invalid_table_dimensions','tables',id))
  for(const [id,ingredient] of maps.ingredients)if(!units.has(ingredient.unit)||!Number.isFinite(Number(ingredient.stock))||Number(ingredient.stock)<0||Number(ingredient.minStock||0)<0||Number(ingredient.costPerUnit||0)<0)diagnostics.push(fail('invalid_ingredient_values','ingredients',id))
  for (const [id, table] of maps.tables) {
    if(!['round','wide','square','oval','large'].includes(table.shape||'round'))diagnostics.push(fail('unknown_table_shape','tables',id))
    for (const sibling of arr(table.joinedWith)) if (!maps.tables.has(String(sibling)) || !arr(maps.tables.get(String(sibling))?.joinedWith).map(String).includes(id)) diagnostics.push(fail('invalid_or_nonreciprocal_table_group', 'tables', id))
  }
  for(const [id,order] of maps.orders)for(const [index,item] of arr(order.items).entries()){
    if(item.productId!=null&&!maps.products.has(String(item.productId)))diagnostics.push(fail('missing_product','order_lines',item.id??`${id}_${index}`))
    for(const extra of arr(item.extras))if(extra.id!=null&&!maps.extras.has(String(extra.id))&&extra.extraId!=null&&!maps.extras.has(String(extra.extraId)))diagnostics.push(fail('missing_modifier','order_lines',item.id??`${id}_${index}`))
  }
  for(const closing of arr(state.cash?.closings))if(!closing.openedBy)diagnostics.push(fail('cash_session_opening_employee_ambiguous','cash_sessions',closing.id))
  for(const closing of arr(state.cash?.closings))if(!decimalSumEquals([closing.expectedAmount,-Number(closing.countedAmount)],-Number(closing.difference)))diagnostics.push(fail('cash_session_difference_mismatch','cash_sessions',closing.id))
  if(state.cash?.isOpen&&(!state.cash.openedBy||!state.cash.openedAt))diagnostics.push(fail('open_cash_session_incomplete','cash_sessions'))
  if(maps.cashMovements.size&&(arr(state.cash?.closings).length+(state.cash?.isOpen?1:0))!==1)diagnostics.push(fail('cash_movement_session_ambiguous','cash_movements'))
  const counts = Object.fromEntries(Object.entries(maps).filter(([key])=>key!=='cashMovements').map(([key, value]) => [key, value.size]))
  counts.cashMovements=maps.cashMovements.size;counts.credentials = credentials.length
  const credentialStates = Object.fromEntries(['active','must_change','reset_required'].map(key=>[key,credentials.filter(item=>item.credential_state===key).length]))
  if(maps.sales.size&&confirmedLegacySalesCurrency!=null&&!['COP','USD'].includes(confirmedLegacySalesCurrency))diagnostics.push(fail('invalid_confirmed_sales_currency','sales'))
  const relationshipCounts={categoryProducts:[...maps.products.values()].length,orderLines:[...maps.orders.values()].reduce((sum,item)=>sum+arr(item.items).length,0),selectedModifiers:[...maps.orders.values()].reduce((sum,item)=>sum+arr(item.items).reduce((inner,line)=>inner+arr(line.extras).length,0),0),saleOrders:[...maps.sales.values()].reduce((sum,item)=>sum+arr(item.orderIds).length,0),reservations:maps.reservations.size,inventoryMovements:maps.inventoryMovements.size,documents:maps.documents.size,cashMovements:maps.cashMovements.size}
  return { diagnostics, maps, counts, credentialStates, claimedOrders, relationshipCounts }
}

export function safeReport({ sourceSha256, restaurantId, validation, dryRun, importedCounts = {}, confirmedLegacySalesCurrency = null }) {
  return {
    format: 'pos-legacy-import-report-v1', restaurantId, sourceSha256,
    status: validation.diagnostics.length ? 'blocked' : dryRun ? 'preflight_passed' : 'accepted',
    dryRun, sourceCounts: validation.counts, importedCounts,
    preservedIdCounts: validation.counts,
    credentialStateCounts: validation.credentialStates,
    reconciliationDecisions: confirmedLegacySalesCurrency?{legacySalesCurrency:confirmedLegacySalesCurrency}: {},
    relationshipCounts: validation.relationshipCounts,
    diagnostics: validation.diagnostics,
    guarantees: ['no_source_payload_or_customer_details', 'no_credential_material', 'legacy_audit_is_unverified_history'],
  }
}

const safeSqlIdentifier = value => typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value) ? value : null
export function classifyPostgresError(error, stage) {
  const sqlstate = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null
  const codes = { '23505': 'postgres_unique_violation', '23503': 'postgres_foreign_key_violation', '23514': 'postgres_check_violation', '42601': 'postgres_syntax_error', '40001': 'postgres_serialization_failure' }
  const diagnostic = {
    code: sqlstate ? (codes[sqlstate] || 'postgres_sql_error') : 'postgres_operation_failed',
    stage: safeSqlIdentifier(stage) || 'postgres_operation',
  }
  if (sqlstate) diagnostic.sqlstate = sqlstate
  for (const key of ['constraint', 'table', 'column']) {
    const value = safeSqlIdentifier(error?.[key])
    if (value) diagnostic[key] = value
  }
  return diagnostic
}

export function validateRowMappings(built, requiredTables) {
  if (!Array.isArray(requiredTables) || new Set(requiredTables).size !== requiredTables.length) {
    throw Object.assign(new Error('invalid row mapping set'), { diagnostic: fail('invalid_row_mapping_set') })
  }
  for (const table of requiredTables) {
    const mapping = built?.rows?.[table]
    if (!mapping || !Array.isArray(mapping.cols) || mapping.cols.length === 0 || !Array.isArray(mapping.data)) {
      throw Object.assign(new Error('invalid row mapping'), { diagnostic: fail('missing_or_invalid_row_mapping', table) })
    }
    for (const [index, row] of mapping.data.entries()) {
      if (!Array.isArray(row) || row.length !== mapping.cols.length) {
        throw Object.assign(new Error('row column arity mismatch'), { diagnostic: fail('row_column_arity_mismatch', table, index) })
      }
    }
  }
  if (Object.keys(built.rows).length !== requiredTables.length) {
    throw Object.assign(new Error('unexpected row mapping'), { diagnostic: fail('invalid_row_mapping_set') })
  }
  if (!Array.isArray(built.idmap) || built.idmap.some(row => !Array.isArray(row) || row.length !== 5)) {
    throw Object.assign(new Error('entity map arity mismatch'), { diagnostic: fail('entity_map_arity_mismatch', 'legacy_import_entity_map') })
  }
  return true
}

async function assertTargetReady(client) {
  const migrations = await loadMigrations()
  const applied = await client.query('SELECT version, name, checksum FROM public.schema_migrations ORDER BY version')
  if (applied.rowCount !== migrations.length || applied.rows.some((row,index)=>row.version!==migrations[index].version || row.name!==migrations[index].name || row.checksum.trim()!==migrations[index].checksum)) throw Object.assign(new Error('postgres_schema_migration_history_mismatch'),{diagnostic:fail('postgres_schema_migration_history_mismatch')})
  const names=['restaurants','employees','employee_credentials','employee_sessions','login_attempts','security_events','restaurant_tables','table_groups','table_group_members','customers','reservations','categories','products','modifier_categories','ingredient_categories','ingredients','inventory_balances','product_recipe_versions','product_recipe_ingredients','modifiers','modifier_ingredients','product_modifiers','orders','order_lines','order_line_modifiers','order_status_events','preparation_events','inventory_movements','cash_sessions','sales','sale_orders','sale_lines','sale_documents','payment_attempts','payments','refunds','sale_adjustments','cash_movements','idempotency_records','entity_revisions','audit_events','outbox_events','legacy_import_runs','legacy_import_entity_map']
  const counts=await client.query(names.map((name,index)=>`SELECT '${name}' AS table_name,count(*)::bigint AS rows FROM public."${name}"${index===names.length-1?'':' UNION ALL '}`).join(''))
  if(counts.rows.some(row=>BigInt(row.rows)>0n))throw Object.assign(new Error('postgres_target_must_be_empty'),{diagnostic:fail('postgres_target_must_be_empty')})
}

async function insert(client, table, columns, values) {
  if (!values.length) return 0
  const colSql = columns.map(name => `"${name}"`).join(',')
  let total = 0
  for (let i=0;i<values.length;i+=250) {
    const batch = values.slice(i,i+250)
    const params=[]
    const tuples=batch.map(row=>`(${row.map(value=>{params.push(value);return `$${params.length}`}).join(',')})`).join(',')
    await client.query(`INSERT INTO public."${table}" (${colSql}) VALUES ${tuples}`,params)
    total += batch.length
  }
  return total
}

async function verifyImportedTarget(client,restaurantId,built,source){
  const tables=['employees','employee_credentials','restaurant_tables','table_groups','table_group_members','categories','ingredient_categories','ingredients','inventory_balances','modifier_categories','modifiers','modifier_ingredients','products','product_recipe_versions','product_recipe_ingredients','product_modifiers','customers','reservations','orders','order_lines','order_line_modifiers','sales','sale_orders','sale_lines','payments','sale_documents','inventory_movements','cash_sessions','cash_movements','audit_events','legacy_import_entity_map']
  for(const table of tables){const result=await client.query(`SELECT count(*)::text AS count FROM public."${table}" WHERE restaurant_id=$1`,[restaurantId]);const expected=table==='legacy_import_entity_map'?built.idmap.length:built.rows[table]?.data.length??0;if(BigInt(result.rows[0].count)!==BigInt(expected))throw Object.assign(new Error('target count mismatch'),{diagnostic:fail('target_count_mismatch',table)})}
  const financial=await client.query('SELECT count(*)::text AS sales,coalesce(sum(subtotal),0)::text AS subtotal,coalesce(sum(discount),0)::text AS discount,coalesce(sum(net_total),0)::text AS net_total,coalesce(sum(tip),0)::text AS tip,coalesce(sum(total),0)::text AS total FROM public.sales WHERE restaurant_id=$1',[restaurantId])
  const expectedSales=arr(source.state.sales)
  const expected={sales:expectedSales.length,subtotal:decimalAggregate(expectedSales.map(item=>item.subtotal)),discount:decimalAggregate(expectedSales.map(item=>item.discount||0)),net_total:decimalAggregate(expectedSales.map(item=>item.netTotal)),tip:decimalAggregate(expectedSales.map(item=>item.tip||0)),total:decimalAggregate(expectedSales.map(item=>item.total))}
  for(const key of Object.keys(expected))if(key==='sales'?BigInt(financial.rows[0][key])!==BigInt(expected[key]):!decimalSumEquals([financial.rows[0][key]],expected[key]))throw Object.assign(new Error('financial reconciliation mismatch'),{diagnostic:fail(`financial_${key}_mismatch`,'sales')})
  return {source:expected,target:{sales:Number(financial.rows[0].sales),subtotal:financial.rows[0].subtotal,discount:financial.rows[0].discount,netTotal:financial.rows[0].net_total,tip:financial.rows[0].tip,total:financial.rows[0].total}}
}

export function buildRows(restaurantId, state, credentials, validation, confirmedLegacySalesCurrency = null) {
  const r=restaurantId, maps=validation.maps, idmap=[], rows={}
  const mapped=(type, sourceId, targetId=sourceId, generated=false)=>{idmap.push([r,type,String(sourceId),String(targetId),generated])}
  const array=(name, cols, data)=>{ rows[name]={cols,data} }
  const entities=key=>[...maps[key].entries()]
  const asId=(entity,id)=>id==null?null:textId(id,entity)
  const seconds=value=>{const n=Number(value||0);if(!Number.isSafeInteger(n)||n<0)throw Object.assign(new Error('bad prep time'),{diagnostic:fail('invalid_prep_time','products')});return n}

  array('employees',['restaurant_id','id','name','role','active'],entities('employees').map(([id,e])=>{mapped('employees',id);return[r,id,String(e.name||'').trim(),e.role,e.active]}))
  array('employee_credentials',['restaurant_id','employee_id','scheme','salt','password_hash','credential_state','created_at','updated_at'],credentials.map(c=>{mapped('employee_credentials',String(c.employee_id));return[r,String(c.employee_id),c.scheme,c.salt,c.password_hash,c.credential_state,stamp(c.created_at,'credential',c.employee_id),stamp(c.updated_at,'credential',c.employee_id)]}))
  array('restaurant_tables',['restaurant_id','id','name','active','shape','x','y','seats','size_scale'],entities('tables').map(([id,t])=>{mapped('tables',id);return[r,id,String(t.name||id),t.active!==false,t.shape,numberValue(Number(t.x),'tables',id,'x'),numberValue(Number(t.y),'tables',id,'y'),Number(t.seats),numberValue(Number(t.sizeScale??1),'tables',id,'size_scale')]}))
  const groups=new Map()
  for(const [id,t] of entities('tables'))if(arr(t.joinedWith).length){const ids=[id,...arr(t.joinedWith).map(String)].sort();const group=stableId('legacy-group',ids.join('\0'));groups.set(group,ids)}
  array('table_groups',['restaurant_id','id'],[...groups.keys()].map(id=>{mapped('table_groups',id,id,true);for(const member of groups.get(id))mapped('table_group_members',`${id}/${member}`,`${id}/${member}`,true);return[r,id]}))
  array('table_group_members',['restaurant_id','group_id','table_id'],[...groups].flatMap(([group,ids])=>ids.map(id=>[r,group,id])))
  array('categories',['restaurant_id','id','name','active','sort_order'],entities('categories').map(([id,c],i)=>{mapped('categories',id);return[r,id,String(c.name||'').trim(),c.active!==false,Number(c.sortOrder??i)]}))

  const ingredientCategoryNames=new Set([...arr(state.ingredientCategories).map(String),...entities('ingredients').map(([,v])=>String(v.category||v.categoryName||'').trim()).filter(Boolean)])
  const ingredientCategoryIds=new Map([...ingredientCategoryNames].map(name=>[name,stableId('ingredient-category',name.toLocaleLowerCase())]))
  array('ingredient_categories',['restaurant_id','id','name'],[...ingredientCategoryIds].map(([name,id])=>{mapped('ingredient_categories',name,id,true);return[r,id,name]}))
  array('ingredients',['restaurant_id','id','name','category_id','category_name_snapshot','stock_unit','cost_per_unit','min_stock','active'],entities('ingredients').map(([id,g])=>{mapped('ingredients',id);const cat=String(g.category||g.categoryName||'').trim();return[r,id,String(g.name||'').trim(),ingredientCategoryIds.get(cat)||null,cat,units.has(g.unit)?g.unit:'unidad',numberValue(Number(g.costPerUnit||0),'ingredients',id,'cost'),numberValue(Number(g.minStock||0),'ingredients',id,'min_stock'),g.active!==false]}))
  array('inventory_balances',['restaurant_id','ingredient_id','quantity','revision','updated_at'],entities('ingredients').map(([id,g])=>[r,id,numberValue(Number(g.stock||0),'ingredients',id,'stock'),0,stamp(g.updatedAt||state.updatedAt||Date.now(),'ingredients',id)]))

  const extraCategoryNames=new Set([...arr(state.extraCategories).map(String),...entities('extras').map(([,e])=>String(e.category||'General').trim()||'General')])
  const extraCategoryIds=new Map([...extraCategoryNames].map(name=>[name,stableId('modifier-category',name.toLocaleLowerCase())]))
  array('modifier_categories',['restaurant_id','id','name','active'],[...extraCategoryIds].map(([name,id])=>{mapped('modifier_categories',name,id,true);return[r,id,name,true]}))
  array('modifiers',['restaurant_id','id','category_id','name','price','active'],entities('extras').map(([id,e])=>{mapped('extras',id);const cat=String(e.category||'General').trim()||'General';return[r,id,extraCategoryIds.get(cat),String(e.name||'').trim(),numberValue(Number(e.price||0),'extras',id,'price'),e.active!==false]}))
  const modifierIngredients=[]
  for(const [extraId,e] of entities('extras')) for(const ingredientId of arr(e.ingredientIds||e.ingredients)){const amount=Number(e.ingredientUsage?.[ingredientId]??0);if(amount>0)modifierIngredients.push([r,extraId,String(ingredientId),numberValue(amount,'extras',extraId,'ingredient_usage'),e.ingredientUsageUnit?.[ingredientId]||maps.ingredients.get(String(ingredientId))?.unit||'unidad'])}
  array('modifier_ingredients',['restaurant_id','modifier_id','ingredient_id','quantity','unit'],modifierIngredients)
  const recipes=[], recipeIngredients=[], productModifiers=[]
  for(const [productId,p] of entities('products')){
    const ingredients=arr(p.ingredients||p.ingredientIds)
    if(ingredients.length){const recipeId=stableId('legacy-recipe',productId);mapped('product_recipe_versions',productId,recipeId,true);recipes.push([r,recipeId,productId,1,null]);for(const ingredientId of ingredients){const quantity=Number(p.ingredientUsage?.[ingredientId]??0);if(quantity>0)recipeIngredients.push([r,recipeId,String(ingredientId),numberValue(quantity,'products',productId,'recipe_quantity'),p.ingredientUsageUnit?.[ingredientId]||maps.ingredients.get(String(ingredientId))?.unit||'unidad'])}}
    for(const extraId of arr(p.extraIds))productModifiers.push([r,productId,String(extraId)])
  }
  array('products',['restaurant_id','id','category_id','name','description','price','active','image','estimated_prep_seconds'],entities('products').map(([id,p])=>{mapped('products',id);return[r,id,String(p.categoryId),String(p.name||'').trim(),String(p.description||''),numberValue(Number(p.price),'products',id,'price'),p.isActive!==false&&p.active!==false,String(p.image||''),seconds(p.estimatedPrepTime)]}))
  array('product_recipe_versions',['restaurant_id','id','product_id','version','created_by'],recipes)
  array('product_recipe_ingredients',['restaurant_id','recipe_version_id','ingredient_id','quantity','unit'],recipeIngredients)
  array('product_modifiers',['restaurant_id','product_id','modifier_id'],productModifiers)

  array('customers',['restaurant_id','id','name','phone','email','notes'],entities('customers').map(([id,c])=>{mapped('customers',id);return[r,id,String(c.name||'').trim(),plain(c.phone),plain(c.email),plain(c.notes)]}))
  array('reservations',['restaurant_id','id','customer_id','customer_name_snapshot','table_id','reserved_for','party_size','status','notes','created_at'],entities('reservations').map(([id,x])=>{mapped('reservations',id);return[r,id,asId('customers',x.customerId),String(x.customerName||maps.customers.get(String(x.customerId))?.name||'Cliente'),asId('tables',x.tableId),stamp(x.reservedFor||x.date,'reservations',id),Number(x.partySize||x.people||1),({pending:'pendiente',confirmed:'confirmada',seated:'atendida',cancelled:'cancelada'})[x.status]||x.status||'pendiente',String(x.notes||''),stamp(x.createdAt||x.reservedFor||x.date,'reservations',id,'created_at')]}))

  let maxOrderNumber=0
  for(const [,o] of entities('orders')) maxOrderNumber=Math.max(maxOrderNumber,Number(o.number)||0)
  const orderRows=[],lineRows=[],lineModifierRows=[],lineIdLookup=new Map()
  for(const [id,o] of entities('orders')){
    mapped('orders',id);const orderNum=Number(o.number);if(!Number.isSafeInteger(orderNum)||orderNum<1)throw Object.assign(new Error('invalid order number'),{diagnostic:fail('invalid_order_number','orders',id)})
    const type=o.orderType||'mesa';if(!['mesa','pickup','delivery'].includes(type))throw Object.assign(new Error('invalid order type'),{diagnostic:fail('unknown_order_type','orders',id)})
    orderRows.push([r,id,orderNum,type,o.status,asId('tables',o.tableId),String(o.tableName||''),asId('customers',o.customerId),asId('reservations',o.reservationId),String(o.deliveryAddress||''),asId('orders',o.sourceOrderId),asId('employees',o.employeeId),numberValue(Number(o.total||0),'orders',id,'subtotal'),stamp(o.createdAt,'orders',id),stamp(o.updatedAt||o.createdAt,'orders',id,'updated_at'),plain(o.sentToKitchenAt?stamp(o.sentToKitchenAt,'orders',id):null),plain(o.completedAt?stamp(o.completedAt,'orders',id):null),plain(o.closedAt?stamp(o.closedAt,'orders',id):null)])
    for(let index=0;index<o.items.length;index++){
      const item=o.items[index],lineId=textId(item.id??stableId(`line-${id}`,index),'order_lines');lineIdLookup.set(`${id}/${index}`,lineId);mapped('order_lines',`${id}/${index}`,lineId,item.id==null)
      const quantity=Number(item.quantity),price=Number(item.basePrice??item.price),lineTotal=orderLineAmount(item)
      lineRows.push([r,lineId,id,asId('products',item.productId),String(item.productName||'Producto'),numberValue(quantity,'order_lines',lineId,'quantity'),numberValue(price,'order_lines',lineId,'unit_price'),decimalValue(lineTotal,'order_lines',lineId,'line_total'),null,json(arr(item.removedIngredients)),String(item.note||''),seconds(item.estimatedPrepTime??o.estimatedPrepTime),stamp(item.createdAt||o.createdAt,'order_lines',lineId,'created_at')])
      for(let j=0;j<arr(item.extras).length;j++){const extra=item.extras[j],modifierLineId=stableId(`line-modifier-${lineId}`,j);mapped('order_line_modifiers',`${lineId}/${j}`,modifierLineId,true);lineModifierRows.push([r,modifierLineId,lineId,asId('extras',extra.id??extra.extraId),String(extra.name||''),numberValue(Number(extra.price||0),'order_line_modifiers',lineId,'modifier_price'),numberValue(Number(extra.quantity||1),'order_line_modifiers',lineId,'quantity')])}
    }
  }
  array('orders',['restaurant_id','id','order_number','order_type','status','table_id','table_name_snapshot','customer_id','reservation_id','delivery_address','source_order_id','employee_id','subtotal','created_at','updated_at','sent_to_kitchen_at','completed_at','closed_at'],orderRows)
  array('order_lines',['restaurant_id','id','order_id','product_id','product_name_snapshot','quantity','unit_price_snapshot','line_total_snapshot','recipe_version_id','removed_ingredients','note','estimated_prep_seconds','created_at'],lineRows)
  array('order_line_modifiers',['restaurant_id','id','order_line_id','modifier_id','name_snapshot','unit_price_snapshot','quantity'],lineModifierRows)

  const saleRows=[],saleOrderRows=[],saleLines=[],paymentRows=[],documents=[]
  for(const [saleId,s] of entities('sales')){
    mapped('sales',saleId);const orderIds=arr(s.orderIds).map(String);saleRows.push([r,saleId,s.currencyCode||confirmedLegacySalesCurrency,numberValue(Number(s.subtotal),'sales',saleId,'subtotal'),numberValue(Number(s.discount||0),'sales',saleId,'discount'),numberValue(Number(s.netTotal),'sales',saleId,'net_total'),numberValue(Number(s.tip||0),'sales',saleId,'tip'),numberValue(Number(s.total),'sales',saleId,'total'),String(s.paymentMethod||'Desconocido'),Number(s.people||1),asId('employees',s.employeeId),asId('tables',s.tableId),String(s.tableName||''),asId('customers',s.customerId),asId('reservations',s.reservationId),s.orderType||'mesa',numberValue(Number(s.cashReceived||0),'sales',saleId,'cash_received'),numberValue(Number(s.cashChange||0),'sales',saleId,'cash_change'),stamp(s.createdAt,'sales',saleId)])
    for(const orderId of orderIds)saleOrderRows.push([r,saleId,orderId])
    const receipt=[...maps.documents.values()].find(document=>String(document.saleId)===saleId&&Array.isArray(document.items))
    if(receipt)for(let index=0;index<receipt.items.length;index++){const item=receipt.items[index],qty=Number(item.quantity||1),price=Number(item.unitPrice),modifiers=arr(item.extras),lineId=stableId(`sale-line-${saleId}`,index);mapped('sale_lines',`${receipt.id}/${index}`,lineId,true);saleLines.push([r,lineId,saleId,null,String(item.productName||'Producto'),numberValue(qty,'sale_lines',saleId,'quantity'),numberValue(price,'sale_lines',saleId,'unit_price'),numberValue(Number(item.subtotal),'sale_lines',saleId,'line_total'),json(modifiers.map(x=>({name:x.name,price:x.price,quantity:Number(x.quantity||1)})))])}
    for(const [method,amount] of Object.entries(s.paymentBreakdown||{})){if(Number(amount)>0){const paymentId=stableId(`payment-${saleId}`,method);mapped('payments',`${saleId}/${method}`,paymentId,true);paymentRows.push([r,paymentId,saleId,null,String(method),numberValue(Number(amount),'payments',saleId,'amount'),asId('employees',s.employeeId),stamp(s.createdAt,'payments',saleId)])}}
  }
  for(const [id,d] of entities('documents')){mapped('documents',id);documents.push([r,id,String(d.saleId),String(d.type||'receipt'),json(d),stamp(d.createdAt,'documents',id)])}
  array('sales',['restaurant_id','id','currency_code','subtotal','discount','net_total','tip','total','payment_method','people','employee_id','table_id','table_name_snapshot','customer_id','reservation_id','order_type','cash_received','cash_change','created_at'],saleRows)
  array('sale_orders',['restaurant_id','sale_id','order_id'],saleOrderRows)
  array('sale_lines',['restaurant_id','id','sale_id','order_line_id','product_name_snapshot','quantity','unit_price_snapshot','line_total_snapshot','modifiers_snapshot'],saleLines)
  array('payments',['restaurant_id','id','sale_id','attempt_id','payment_method','amount','employee_id','recorded_at'],paymentRows)
  array('sale_documents',['restaurant_id','id','sale_id','document_type','payload','created_at'],documents)

  array('inventory_movements',['restaurant_id','id','ingredient_id','movement_type','quantity_delta','unit','stock_before','stock_after','sale_id','employee_id','reason','occurred_at'],entities('inventoryMovements').map(([id,m])=>{mapped('inventory_movements',id);const type=m.type==='sale'?'sale':m.type==='purchase'?'purchase':'adjustment';const quantity=Number(m.quantity);return[r,id,String(m.ingredientId),type,numberValue(quantity,'inventory_movements',id,'quantity'),m.unit,plain(m.stockBefore==null?null:numberValue(Number(m.stockBefore),'inventory_movements',id,'stock_before')),plain(m.stockAfter==null?null:numberValue(Number(m.stockAfter),'inventory_movements',id,'stock_after')),asId('sales',m.saleId),asId('employees',m.employeeId),String(m.reason||''),stamp(m.createdAt,'inventory_movements',id)]}))
  const auditRows=[]
  for(const [id,a] of entities('audit')){mapped('audit_events',id);auditRows.push([r,id,asId('employees',a.employeeId),String(a.action||'legacy_event'),null,null,json({provenance:'legacy_unverified',data:a.data||{}}),stamp(a.createdAt,'audit_events',id)])}
  array('audit_events',['restaurant_id','id','employee_id','action','entity_type','entity_id','details','occurred_at'],auditRows)

  const sessions=[],cashMovements=[];const cash=state.cash||{}
  for(const closing of arr(cash.closings)){const sid=textId(closing.id,'cash_sessions');mapped('cash_sessions',sid);sessions.push([r,sid,String(closing.openedBy||'') ,stamp(closing.openedAt,'cash_sessions',sid),numberValue(Number(closing.openingAmount||0),'cash_sessions',sid,'opening_amount'),String(closing.closedBy||''),stamp(closing.createdAt,'cash_sessions',sid),numberValue(Number(closing.expectedAmount),'cash_sessions',sid,'expected_amount'),numberValue(Number(closing.countedAmount),'cash_sessions',sid,'counted_amount'),numberValue(Number(closing.difference),'cash_sessions',sid,'difference')])}
  if(cash.isOpen){const sid='legacy:cash:open';sessions.push([r,sid,String(cash.openedBy||''),stamp(cash.openedAt,'cash_sessions',sid),numberValue(Number(cash.openingAmount||0),'cash_sessions',sid,'opening_amount'),null,null,null,null,null]);mapped('cash_sessions',sid,sid,true)}
  array('cash_sessions',['restaurant_id','id','opened_by','opened_at','opening_amount','closed_by','closed_at','expected_amount','counted_amount','difference'],sessions)
  const allCashSessions=sessions.map(row=>row[1])
  for(const [id,m] of entities('cashMovements')){mapped('cash_movements',id);if(allCashSessions.length!==1)throw Object.assign(new Error('cash movement session ambiguous'),{diagnostic:fail('cash_movement_session_ambiguous','cash_movements',id)});cashMovements.push([r,id,allCashSessions[0],m.type==='expense'?'expense':'income',numberValue(Number(m.amount),'cash_movements',id,'amount'),String(m.reason||''),String(m.paymentMethod||'Efectivo'),asId('sales',m.saleId),asId('employees',m.employeeId),stamp(m.createdAt,'cash_movements',id)])}
  array('cash_movements',['restaurant_id','id','cash_session_id','direction','amount','reason','payment_method','sale_id','employee_id','occurred_at'],cashMovements)

  array('restaurants',['id','name','currency_code','settings'],[[r,String(state.config?.restaurantName||'Restaurante'),state.config?.currency==='USD'?'USD':'COP',json({config:state.config||{},soundPresets:state.soundPresets||{}})]])
  return {rows,idmap}
}

export const insertOrder=['restaurants','employees','employee_credentials','restaurant_tables','table_groups','table_group_members','categories','ingredient_categories','ingredients','inventory_balances','modifier_categories','modifiers','modifier_ingredients','products','product_recipe_versions','product_recipe_ingredients','product_modifiers','customers','reservations','orders','order_lines','order_line_modifiers','sales','sale_orders','sale_lines','payments','sale_documents','inventory_movements','cash_sessions','cash_movements','audit_events']

export async function runSqlitePostgresImport({sourcePath,activePath,reportPath,restaurantId,dryRun=false,confirmedLegacySalesCurrency=null,connectionString=process.env.POSTGRES_IMPORT_DATABASE_URL,pgClient=Client,rowBuilder=buildRows}){
  const paths=validateImportPaths({sourcePath,activePath,reportPath})
  if(!restaurantId||typeof restaurantId!=='string'||restaurantId.trim()!==restaurantId)throw new Error('explicit_restaurant_id_required')
  const source=readSnapshot(paths.sourcePath)
  const digest=source.sourceSha256
  const validation=validateState(source.state,source.credentials,confirmedLegacySalesCurrency,source.numericPrecisionAmbiguous)
  let built=null
  if(!validation.diagnostics.length){try{built=rowBuilder(restaurantId,source.state,source.credentials,validation,confirmedLegacySalesCurrency);validateRowMappings(built,insertOrder)}catch(error){if(error.diagnostic)validation.diagnostics.push(error.diagnostic);else throw error}}
  const proposedCounts=built?Object.fromEntries([...Object.entries(built.rows).map(([table,entry])=>[table,entry.data.length]),['legacy_import_entity_map',built.idmap.length]]):{}
  let report=safeReport({sourceSha256:digest,restaurantId,validation,dryRun,confirmedLegacySalesCurrency,importedCounts:proposedCounts})
  if(validation.diagnostics.length){fs.writeFileSync(paths.reportPath,JSON.stringify(report,null,2),{mode:0o600});return report}
  const writeReport=()=>fs.writeFileSync(paths.reportPath,JSON.stringify(report,null,2),{mode:0o600})
  if(!connectionString){report=safeReport({sourceSha256:digest,restaurantId,validation:{...validation,diagnostics:[fail('POSTGRES_IMPORT_DATABASE_URL_required')]},dryRun,confirmedLegacySalesCurrency});writeReport();throw new Error('POSTGRES_IMPORT_DATABASE_URL_required')}
  let url
  try{url=new URL(connectionString)}catch{report=safeReport({sourceSha256:digest,restaurantId,validation:{...validation,diagnostics:[fail('invalid_postgres_target_url')]},dryRun,confirmedLegacySalesCurrency});writeReport();throw new Error('invalid_postgres_target_url')}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','::1'].includes(url.hostname)||!/(^|[_-])(test|import)([_-]|$)/i.test(decodeURIComponent(url.pathname.slice(1)))){report=safeReport({sourceSha256:digest,restaurantId,validation:{...validation,diagnostics:[fail('postgres_target_must_be_loopback_test_or_import_database')]},dryRun,confirmedLegacySalesCurrency});writeReport();throw new Error('postgres_target_must_be_loopback_test_or_import_database')}
  const client=new pgClient({connectionString,application_name:'pos-p3-sqlite-import',connectionTimeoutMillis:5000})
  const importId=randomUUID()
  let connected=false
  let stage='connect'
  try{
    await client.connect();connected=true
    stage='begin'
    await client.query(dryRun?'BEGIN READ ONLY':'BEGIN ISOLATION LEVEL SERIALIZABLE')
    stage='lock'
    if(!dryRun)await client.query("SELECT pg_advisory_xact_lock(hashtext('pos-p3-import'),hashtext($1))",[restaurantId])
    stage='target_check'
    await assertTargetReady(client)
    if(dryRun){await client.query('ROLLBACK');fs.writeFileSync(paths.reportPath,JSON.stringify(report,null,2),{mode:0o600});return report}
    const importedCounts={}
    for(const table of insertOrder){stage=`insert_${table}`;const entry=built.rows[table];importedCounts[table]=await insert(client,table,entry.cols,entry.data)}
    importedCounts.cashMovements=importedCounts.cash_movements||0
    stage='manifest'
    await client.query('INSERT INTO public.legacy_import_runs (restaurant_id,id,source_sha256,status,source_state_version,source_counts,imported_counts,relationship_counts,credential_state_counts,reconciliation) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb)',[restaurantId,importId,digest,'staging',source.sourceVersion,JSON.stringify(validation.counts),JSON.stringify(importedCounts),JSON.stringify({saleOrders:validation.claimedOrders.size,tableGroups:built.rows.table_groups.data.length}),JSON.stringify(validation.credentialStates),JSON.stringify({status:'staging',blockers:[],limitations:['legacy_audit_unverified','recipe_versions_for_historical_orders_not_reconstructed']})])
    stage='entity_map'
    for(const [type,sourceId,targetId,generated] of built.idmap){await client.query('INSERT INTO public.legacy_import_entity_map (restaurant_id,import_id,entity_type,source_id,target_id,generated) VALUES ($1,$2,$3,$4,$5,$6)',[restaurantId,importId,type,sourceId,targetId,generated])}
    stage='verify'
    const financialReconciliation=await verifyImportedTarget(client,restaurantId,built,source)
    stage='complete'
    await client.query("UPDATE public.legacy_import_runs SET status='completed', reconciliation=$3::jsonb WHERE restaurant_id=$1 AND id=$2",[restaurantId,importId,JSON.stringify({status:'accepted',blockers:[],financialAggregates:financialReconciliation,limitations:['legacy_audit_unverified','recipe_versions_for_historical_orders_not_reconstructed']})])
    stage='commit'
    await client.query('COMMIT')
    report=safeReport({sourceSha256:digest,restaurantId,validation,dryRun:false,importedCounts,confirmedLegacySalesCurrency})
    report.importId=importId
    fs.writeFileSync(paths.reportPath,JSON.stringify(report,null,2),{mode:0o600})
    return report
  }catch(error){if(connected)try{await client.query('ROLLBACK')}catch{};const diagnostic=error.diagnostic?{...error.diagnostic,stage}:classifyPostgresError(error,stage);report=safeReport({sourceSha256:digest,restaurantId,validation:{...validation,diagnostics:[...validation.diagnostics,diagnostic]},dryRun,confirmedLegacySalesCurrency});writeReport();const safeError=new Error(diagnostic.code);safeError.diagnostic=diagnostic;throw safeError}
  finally{if(connected)await client.end().catch(()=>{})}
}

function parseArgs(args){const result={};for(let i=0;i<args.length;i++){const key=args[i];if(!key.startsWith('--'))throw new Error('invalid_argument');if(key==='--dry-run'){result.dryRun=true;continue}if(result[key.slice(2)]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw new Error('missing_or_duplicate_argument');result[key.slice(2)]=args[++i]};return result}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const args=parseArgs(process.argv.slice(2));const report=await runSqlitePostgresImport({sourcePath:args.source,activePath:args['active-db'],reportPath:args.report,restaurantId:args['restaurant-id'],confirmedLegacySalesCurrency:args['confirmed-sales-currency'],dryRun:Boolean(args.dryRun)});console.log(JSON.stringify({status:report.status,sourceCounts:report.sourceCounts,diagnostics:report.diagnostics,reportPath:path.resolve(args.report)}));if(report.status==='blocked')process.exitCode=2}
  catch(error){const diagnostic=error.diagnostic;if(diagnostic){const safe=Object.fromEntries(['code','stage','sqlstate','entity','id','constraint','table','column'].filter(key=>diagnostic[key]!=null).map(key=>[key,diagnostic[key]]));console.error(JSON.stringify(safe))}else console.error(/^[a-z0-9_]+$/.test(error.message||'')?error.message:'import_failed');process.exitCode=1}
}
