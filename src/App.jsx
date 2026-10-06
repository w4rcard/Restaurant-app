import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { calculateEstimatedPrepTime, getDueKitchenAlerts, getKitchenTiming } from './lib/kitchen'
import { itemSubtotal, makeId, makeOrderItem, orderTotal, STATUS, statusLabel } from './lib/pos'
import { broadcastStore, createInitialStore, createServerEventSource, createSyncChannel, defaultEmployees, defaultExtras, defaultExtraCategories, defaultIngredientCategories, defaultIngredients, fetchServerStore, hasPendingSync, loadStore, mergeStores, migrateStoreToV8, markPendingSync, nowStamp, saveStore, seedServerStore } from './lib/db'
import { compatibleUnits, defaultUsageUnit, deductInventoryForSale, reconcileInventoryStocks, validateInventoryForSale } from './lib/inventory'
import { buildReceiptPdf } from './lib/documents'
import { buildPaymentBreakdownFromParts, clampSplitPeople, distributeSplitTotal, resizeSplitPeople, sumSplitParts } from './lib/payments'

const ORDER_TYPES = { mesa:'Mesa', pickup:'Para llevar', delivery:'Domicilio' }

const CATEGORY_SEED = [
  { id: 'hamburguesas', name: 'Hamburguesas', active: true },
  { id: 'combos', name: 'Combos', active: true },
  { id: 'acompanamientos', name: 'Acompañamientos', active: true },
  { id: 'bebidas', name: 'Bebidas', active: true },
  { id: 'postres', name: 'Postres', active: true },
]

const PRODUCT_SEED = [
  ['prod-1', 'Hamburguesa Clásica', 'Carne, tomate, lechuga y salsa casera.', 22000, 'hamburguesas', 15, ['ing-carne','ing-pan','ing-queso','ing-lechuga','ing-tomate','ing-cebolla']],
  ['prod-2', 'Hamburguesa BBQ', 'Carne, queso, cebolla caramelizada y BBQ.', 24500, 'hamburguesas', 16, ['ing-carne','ing-pan','ing-queso','ing-cebolla','ing-pepinillos']],
  ['prod-3', 'Hamburguesa Doble', 'Doble carne, doble queso y pan brioche.', 29000, 'hamburguesas', 18, ['ing-carne','ing-pan','ing-queso','ing-lechuga','ing-tomate']],
  ['prod-4', 'Combo Clásico', 'Hamburguesa clásica + papas + bebida.', 33000, 'combos', 20, ['ing-carne','ing-pan','ing-queso','ing-lechuga','ing-tomate','ing-papas']],
  ['prod-5', 'Combo BBQ', 'Hamburguesa BBQ + papas + bebida.', 36000, 'combos', 21, ['ing-carne','ing-pan','ing-queso','ing-cebolla','ing-papas']],
  ['prod-6', 'Papas Fritas', 'Crispantes y doradas.', 9000, 'acompanamientos', 7, ['ing-papas']],
  ['prod-7', 'Papas con Queso', 'Papas gratinadas con queso.', 11500, 'acompanamientos', 8, ['ing-papas','ing-queso']],
  ['prod-8', 'Nuggets', 'Croquetas de pollo con salsa.', 12000, 'acompanamientos', 9, []],
  ['prod-9', 'Coca-Cola', 'Lata 330 ml.', 4500, 'bebidas', 2, []],
  ['prod-10', 'Sprite', 'Refrescante de limón.', 4500, 'bebidas', 2, []],
  ['prod-11', 'Agua', 'Agua mineral sin gas.', 3000, 'bebidas', 1, []],
  ['prod-12', 'Limonada', 'Limonada fresca.', 6000, 'bebidas', 4, []],
  ['prod-13', 'Malteada', 'Vainilla o chocolate.', 11000, 'bebidas', 6, []],
  ['prod-14', 'Brownie', 'Brownie de chocolate.', 9500, 'postres', 6, []],
  ['prod-15', 'Helado', 'Helado artesanal.', 10500, 'postres', 3, []],
]

const tableDefaults = Array.from({ length: 8 }, (_, i) => ({
  id: i + 1,
  name: `Mesa ${i + 1}`,
  shape: ['round','wide','square','oval'][i % 4],
  seats: [2,4,4,6][i % 4],
  x: [12, 38, 65, 12, 38, 65, 38, 65][i % 8],
  y: [16, 16, 16, 50, 50, 50, 78, 78][i % 8],
  joinedWith: [],
  active: true,
}))

const money = (value, currency = 'COP') => new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(value) || 0)
const duration = seconds => `${String(Math.floor(Math.max(0, seconds) / 60)).padStart(2, '0')}:${String(Math.max(0, seconds) % 60).padStart(2, '0')}`
const orderStatusClass = status => `status ${status === STATUS.PENDING ? 'pending' : status === STATUS.PREPARING ? 'preparing' : status === STATUS.READY ? 'ready' : status === STATUS.DELIVERED ? 'delivered' : 'cancelled'}`
const kitchenStatusClass = status => status === STATUS.PREPARING ? 'preparing' : status === STATUS.READY ? 'ready' : status === STATUS.DELIVERED ? 'delivered' : status === STATUS.CANCELLED ? 'cancelled' : 'pending'
const getCategoryName = (categories, id) => categories.find(category => category.id === id)?.name || 'Sin categoría'
const dateLabel = timestamp => new Date(timestamp).toLocaleString('es-CO', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })

function normalizedProducts(products, ingredients, extras) {
  return products.map(product => ({
    ...product,
    ingredients: Array.isArray(product.ingredients) ? product.ingredients : [],
    extras: Array.isArray(product.extras) ? product.extras : [],
    isActive: product.isActive !== false,
    estimatedPrepTime: Number(product.estimatedPrepTime) || 900,
    ingredientUsage: product.ingredientUsage || Object.fromEntries((product.ingredients || []).map(id => [id, 1])),
    ingredientUsageUnit: product.ingredientUsageUnit || Object.fromEntries((product.ingredients || []).map(id => [id, defaultUsageUnit(ingredients.find(entry => entry.id === id)?.unit || 'unidad')])),
    extraIds: product.extraIds || (product.extras || []).map(extra => extra.id).filter(Boolean),
  })).map(product => ({
    ...product,
    extras: product.extraIds.map(id => extras.find(extra => extra.id === id)).filter(Boolean),
    ingredients: product.ingredients.filter(id => ingredients.some(ingredient => ingredient.id === id)),
  }))
}

function seedStore() {
  const products = PRODUCT_SEED.map(([id,name,description,price,categoryId,minutes,ingredientIds]) => ({
    id,name,description,price,categoryId,isActive:true,image:'',estimatedPrepTime:minutes*60,
    ingredients: ingredientIds,
    ingredientUsage: Object.fromEntries(ingredientIds.map(id => [id, id.includes('carne') ? 150 : id === 'ing-pan' ? 1 : 25])),
    ingredientUsageUnit: Object.fromEntries(ingredientIds.map(id => [id, defaultUsageUnit(defaultIngredients.find(entry => entry.id === id)?.unit || 'unidad')])),
    extraIds: ingredientIds.length ? ['ext-queso','ext-tocino','ext-huevo'] : [],
  }))
  const legacyTables = tableDefaults
  const legacyProducts = products
  const legacyOrders = [
    { id:'order-demo-101', number:101, tableId:2, tableName:'Mesa 2', status:STATUS.PENDING, items:[], total:0, createdAt:Date.now()-11*60000, sentToKitchenAt:Date.now()-11*60000, estimatedPrepTime:15*60, updatedAt:Date.now()-11*60000, employeeId:'emp-mesero' },
    { id:'order-demo-102', number:102, tableId:5, tableName:'Mesa 5', status:STATUS.PREPARING, items:[], total:0, createdAt:Date.now()-18*60000, sentToKitchenAt:Date.now()-18*60000, estimatedPrepTime:15*60, updatedAt:Date.now()-18*60000, employeeId:'emp-mesero' },
  ]
  return createInitialStore({
    tables: legacyTables,
    categories: CATEGORY_SEED,
    products: legacyProducts,
    orders: legacyOrders,
    ingredients: defaultIngredients,
    extras: defaultExtras,
  })
}


const trackedEntityArrays = ['tables','categories','products','orders','ingredients','extras','employees','customers','reservations']
const cloneWithoutUpdatedAt = value => {
  if (!value || typeof value !== 'object') return value
  const clone = { ...value }
  delete clone.updatedAt
  return clone
}
function stampStoreChanges(previous, next, timestamp = Date.now()) {
  const result = { ...next }
  for (const key of trackedEntityArrays) {
    const prevList = Array.isArray(previous?.[key]) ? previous[key] : []
    const nextList = Array.isArray(next?.[key]) ? next[key] : []
    const prevMap = new Map(prevList.filter(item => item?.id != null).map(item => [String(item.id), item]))
    result[key] = nextList.map(item => {
      if (!item || item.id == null) return item
      const prev = prevMap.get(String(item.id))
      if (!prev || JSON.stringify(cloneWithoutUpdatedAt(prev)) !== JSON.stringify(cloneWithoutUpdatedAt(item))) {
        return { ...item, updatedAt: timestamp }
      }
      return item
    })
  }
  if (previous?.config !== next?.config) {
    const previousConfig = previous?.config || {}
    const nextConfig = next?.config || {}
    const fieldMeta = { ...(previousConfig._updatedAtByField || {}) }
    const keys = new Set([...Object.keys(previousConfig), ...Object.keys(nextConfig)])
    keys.delete('updatedAt'); keys.delete('_updatedAtByField'); keys.delete('kitchen')
    for (const key of keys) {
      if (JSON.stringify(previousConfig[key]) !== JSON.stringify(nextConfig[key])) fieldMeta[key] = timestamp
    }
    const previousKitchen = previousConfig.kitchen || {}
    const nextKitchen = nextConfig.kitchen || {}
    const kitchenKeys = new Set([...Object.keys(previousKitchen), ...Object.keys(nextKitchen)])
    for (const key of kitchenKeys) {
      if (JSON.stringify(previousKitchen[key]) !== JSON.stringify(nextKitchen[key])) fieldMeta[`kitchen.${key}`] = timestamp
    }
    result.config = { ...nextConfig, _updatedAtByField: fieldMeta, updatedAt: timestamp }
  }
  if (previous?.cash !== next?.cash) result.cash = { ...(next.cash || {}), updatedAt: timestamp }
  result.ingredients = reconcileInventoryStocks(result.ingredients || [], result.inventoryMovements || [])
  return result
}

function migrateLegacyProducts(rawProducts, ingredientList, extraList) {
  return (rawProducts || []).map(product => {
    const ingredientIds = (product.ingredients || []).map(value => {
      if (ingredientList.some(item => item.id === value)) return value
      return ingredientList.find(item => item.name.toLowerCase() === String(value).toLowerCase())?.id
    }).filter(Boolean)
    const extraIds = (product.extraIds || product.extras || []).map(value => {
      if (typeof value === 'string' && extraList.some(item => item.id === value)) return value
      const name = typeof value === 'string' ? value : value?.name
      return extraList.find(item => item.name.toLowerCase() === String(name || '').toLowerCase())?.id
    }).filter(Boolean)
    return {
      ...product,
      ingredients: ingredientIds,
      ingredientUsage: product.ingredientUsage || Object.fromEntries(ingredientIds.map(id => [id, 25])),
      ingredientUsageUnit: product.ingredientUsageUnit || Object.fromEntries(ingredientIds.map(id => [id, defaultUsageUnit(ingredientList.find(entry => entry.id === id)?.unit || 'unidad')])),
      extraIds,
      isActive: product.isActive !== false,
      estimatedPrepTime: Number(product.estimatedPrepTime) || 900,
    }
  })
}

function migrateLegacyOrders(rawOrders, migratedProducts, extraList) {
  const productMap = Object.fromEntries(migratedProducts.map(product => [product.id, product]))
  return (rawOrders || []).map(order => {
    const items = (order.items || []).map(item => {
      const product = productMap[item.productId]
      const extras = (item.extras || []).map(extra => {
        if (typeof extra === 'object' && extra.id) return extra
        return extraList.find(entry => entry.name.toLowerCase() === String(extra).toLowerCase())
      }).filter(Boolean)
      return {
        ...item,
        id:item.id || makeId('item'),
        productName:item.productName || product?.name || 'Producto eliminado',
        basePrice:Number(item.basePrice) || Number(product?.price) || 0,
        estimatedPrepTime:Number(item.estimatedPrepTime) || Number(product?.estimatedPrepTime) || 900,
        extras,
        removedIngredients:Array.isArray(item.removedIngredients)?item.removedIngredients:[],
        note:item.note || '',
        quantity:Number(item.quantity)||1,
      }
    })
    return {
      ...order,
      id:order.id || makeId('order'),
      items,
      total:order.total ?? orderTotal(items),
      updatedAt:order.updatedAt || order.createdAt || Date.now(),
      sentToKitchenAt:order.sentToKitchenAt || order.createdAt || Date.now(),
      estimatedPrepTime:Number(order.estimatedPrepTime) || Math.max(900, ...items.map(item=>item.estimatedPrepTime||900)),
      tableName:order.tableName || `Mesa ${order.tableId || ''}`,
      orderType:order.orderType || 'mesa',
      customerId:order.customerId || null,
      reservationId:order.reservationId || null,
      deliveryAddress:order.deliveryAddress || '',
    }
  })
}

function ensureStoreData() {
  const fallback = seedStore()
  const existing = loadStore(fallback)
  const ingredientList = existing.ingredients?.length ? existing.ingredients : fallback.ingredients
  const extraList = existing.extras?.length ? existing.extras : fallback.extras
  const migratedProducts = migrateLegacyProducts(existing.products?.length ? existing.products : fallback.products, ingredientList, extraList)
  const migratedOrders = migrateLegacyOrders(existing.orders || [], migratedProducts, extraList)
  return {
    ...fallback,
    ...existing,
    categories: existing.categories?.length ? existing.categories : fallback.categories,
    ingredients: ingredientList,
    extras: extraList,
    products: migratedProducts.length ? migratedProducts : fallback.products,
    tables: existing.tables?.length ? existing.tables : fallback.tables,
    orders: migratedOrders,
    sales: existing.sales || [],
    cash: existing.cash || fallback.cash,
    employees: existing.employees?.length ? existing.employees : defaultEmployees,
    soundPresets: existing.soundPresets || fallback.soundPresets,
    audit: existing.audit || [],
    ingredientCategories: existing.ingredientCategories?.length ? existing.ingredientCategories : fallback.ingredientCategories,
    extraCategories: existing.extraCategories?.length ? existing.extraCategories : fallback.extraCategories,
    customers: existing.customers || [],
    reservations: existing.reservations || [],
  }
}

function TableShape({ table, status, selected, onClick, onPointerDown, dragging }) {
  const seats = Math.max(0, Number(table.seats) || 0)
  return <button draggable={false} onPointerDown={onPointerDown} className={`restaurant-table table-${table.shape} table-${status} ${selected ? 'table-selected' : ''} ${dragging ? 'table-dragging' : ''}`} style={{ left:`${table.x}%`, top:`${table.y}%` }} onClick={onClick} aria-label={`${table.name}, ${status}`}>
    {Array.from({ length: seats }).map((_, index) => <span key={index} className="seat-dot" style={{ transform:`translate(-50%, -50%) rotate(${index * (360 / seats)}deg) translateY(-48px)` }} />)}
    <span className="table-surface"><strong>{table.name.replace('Mesa ','')}</strong><small>{seats} puestos</small></span>
  </button>
}

function ProductCard({ product, categories, currency, onAdd }) {
  return <button className="pos-product-card" onClick={() => onAdd(product)}>
    <div className="pos-product-top"><span className="product-avatar">{product.name.slice(0,1)}</span><span className="mini-time">{Math.max(1, Math.round(product.estimatedPrepTime / 60))} min</span></div>
    <div><strong>{product.name}</strong><small>{getCategoryName(categories, product.categoryId)}</small></div>
    <span className="product-price">{money(product.price, currency)}</span>
  </button>
}

function OrderItems({ order, currency, compact = false }) {
  if (!order?.items?.length) return <div className="empty-inline">Sin productos cargados.</div>
  return <div className={`order-items ${compact ? 'compact' : ''}`}>{order.items.map(item => <div className="order-item-row" key={item.id}>
    <div><strong>{item.quantity} × {item.productName}</strong>{item.extras?.length ? <small>+ {item.extras.map(extra => extra.name).join(', ')}</small> : null}{item.removedIngredients?.length ? <small className="danger-text">Sin {item.removedIngredients.join(', ')}</small> : null}{item.note ? <small>Nota: {item.note}</small> : null}</div>
    <strong>{money(itemSubtotal(item), currency)}</strong>
  </div>)}</div>
}

function StatCard({ label, value, hint, accent = false }) {
  return <article className={`metric-card ${accent ? 'accent' : ''}`}><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</article>
}

export default function App() {
  const [store, setStore] = useState(() => ensureStoreData())
  const [view, setView] = useState('home')
  const [toast, setToast] = useState('')
  const [selectedTableId, setSelectedTableId] = useState(null)
  const [orderScreen, setOrderScreen] = useState(null)
  const [checkoutScreen, setCheckoutScreen] = useState(null)
  const [categoryTab, setCategoryTab] = useState('all')
  const [tableFilter, setTableFilter] = useState('all')
  const [orderSearch, setOrderSearch] = useState('')
  const [customizing, setCustomizing] = useState(null)
  const [cart, setCart] = useState([])
  const [historyTab, setHistoryTab] = useState('all')
  const [historySearch, setHistorySearch] = useState('')
  const [historyEmployee, setHistoryEmployee] = useState('all')
  const [historyTable, setHistoryTable] = useState('all')
  const [summaryTab, setSummaryTab] = useState('ventas')
  const [summarySearch, setSummarySearch] = useState('')
  const [menuSection, setMenuSection] = useState('productos')
  const [menuSearch, setMenuSearch] = useState('')
  const [menuCategory, setMenuCategory] = useState('all')
  const [ingredientCategory, setIngredientCategory] = useState('all')
  const [extraCategory, setExtraCategory] = useState('all')
  const [entityCategoryEditor, setEntityCategoryEditor] = useState(null)
  const [productEditor, setProductEditor] = useState(null)
  const [ingredientEditor, setIngredientEditor] = useState(null)
  const [extraEditor, setExtraEditor] = useState(null)
  const [categoryEditor, setCategoryEditor] = useState(null)
  const [soundEditor, setSoundEditor] = useState(false)
  const [systemNow, setSystemNow] = useState(Date.now())
  const [tableConfigMode, setTableConfigMode] = useState(false)
  const [draggingTableId, setDraggingTableId] = useState(null)
  const [joinSource, setJoinSource] = useState(null)
  const [employeeEditor, setEmployeeEditor] = useState(null)
  const [employeePrompt, setEmployeePrompt] = useState(null)
  const [cashAmount, setCashAmount] = useState('')
  const [cashCounted, setCashCounted] = useState('')
  const [expenseEditor, setExpenseEditor] = useState(null)
  const [detailOrder, setDetailOrder] = useState(null)
  const [cancelTarget, setCancelTarget] = useState(null)
  const [cancelReason, setCancelReason] = useState('')
  const [audioReady, setAudioReady] = useState(false)
  const [serverOnline, setServerOnline] = useState(false)
  const [activeEmployeeId, setActiveEmployeeId] = useState(() => localStorage.getItem('restaurant-active-employee') || 'emp-mesero')
  const [workMode, setWorkMode] = useState(() => localStorage.getItem('restaurant-work-mode') === '1')
  const [newOrderPickerOpen, setNewOrderPickerOpen] = useState(false)
  const [newOrderType, setNewOrderType] = useState('mesa')
  const [inventorySearch, setInventorySearch] = useState('')
  const [inventoryFilter, setInventoryFilter] = useState('all')
  const [inventoryMovementSearch, setInventoryMovementSearch] = useState('')
  const [inventoryMovementDateFilter, setInventoryMovementDateFilter] = useState('today')
  const [analyticsRange, setAnalyticsRange] = useState('7d')
  const [inventoryMoveEditor, setInventoryMoveEditor] = useState(null)
  const [customerSearch, setCustomerSearch] = useState('')
  const [customerEditor, setCustomerEditor] = useState(null)
  const [reservationFilter, setReservationFilter] = useState('today')
  const [reservationEditor, setReservationEditor] = useState(null)
  const [globalSearch, setGlobalSearch] = useState('')
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false)
  const [qrTable, setQrTable] = useState(null)
  const [receiptPreview, setReceiptPreview] = useState(null)
  const channelRef = useRef(null)
  const syncingRef = useRef(false)
  const hydratedRef = useRef(false)
  const audioRef = useRef(null)
  const storeRef = useRef(store)
  const orderSubmitLockRef = useRef(false)
  const checkoutSubmitLockRef = useRef(false)
  const cashActionLockRef = useRef(false)
  const inventoryActionLockRef = useRef(false)
  const tableDragRef = useRef(null)
  const knownOrderIdsRef = useRef(null)

  const categories = useMemo(() => store.categories || [], [store.categories])
  const ingredients = useMemo(() => store.ingredients || [], [store.ingredients])
  const extras = useMemo(() => store.extras || [], [store.extras])
  const products = useMemo(() => normalizedProducts(store.products || [], ingredients, extras), [store.products, ingredients, extras])
  const tables = useMemo(() => store.tables || [], [store.tables])
  const orders = useMemo(() => store.orders || [], [store.orders])
  const employees = useMemo(() => store.employees || [], [store.employees])
  const customers = useMemo(() => store.customers || [], [store.customers])
  const reservations = useMemo(() => store.reservations || [], [store.reservations])
  const ingredientCategories = store.ingredientCategories?.length ? store.ingredientCategories : defaultIngredientCategories
  const extraCategories = store.extraCategories?.length ? store.extraCategories : defaultExtraCategories
  const activeEmployee = employees.find(employee => employee.id === activeEmployeeId) || employees.find(employee => employee.active) || employees[0]
  const currentCurrency = store.config?.currency || 'COP'
  const kitchenSettings = useMemo(() => store.config?.kitchen || {}, [store.config?.kitchen])
  const canManageCash = ['Administrador','Caja'].includes(activeEmployee?.role)
  const canManageInventory = activeEmployee?.role === 'Administrador'
  const canManageCatalog = activeEmployee?.role === 'Administrador'

  useEffect(() => { storeRef.current = store }, [store])
  useEffect(() => {
    if (employees.some(employee => employee.id === activeEmployeeId && employee.active)) return
    const fallbackEmployee = employees.find(employee => employee.active)
    if (fallbackEmployee) { setActiveEmployeeId(fallbackEmployee.id); localStorage.setItem('restaurant-active-employee', fallbackEmployee.id) }
  }, [employees, activeEmployeeId])
  useEffect(() => { localStorage.setItem('restaurant-work-mode', workMode ? '1' : '0') }, [workMode])
  
  useEffect(() => {
    let mounted = true
    channelRef.current = createSyncChannel()
    const applyRemoteStore = async remoteStore => {
      if (!mounted || !remoteStore) return
      const pending = hasPendingSync()
      const local = storeRef.current
      const merged = migrateStoreToV8(pending ? mergeStores(local, remoteStore) : remoteStore, seedStore())
      syncingRef.current = true
      hydratedRef.current = true
      setStore(merged)
      if (pending) await saveStore(merged)
    }

    const onMessage = event => {
      if (event.data?.type === 'STATE' && event.data.store) void applyRemoteStore(event.data.store)
    }
    channelRef.current?.addEventListener('message', onMessage)

    const onStorage = event => {
      if (event.key !== 'restaurant-db-v8' || !event.newValue) return
      try {
        void applyRemoteStore(JSON.parse(event.newValue))
      } catch {}
    }
    window.addEventListener('storage', onStorage)

    const serverEvents = createServerEventSource(storeFromServer => {
      setServerOnline(true)
      void applyRemoteStore(storeFromServer)
    }, () => setServerOnline(false))

    const hydrate = async () => {
      const [serverStore, health] = await Promise.all([fetchServerStore(), fetch('/api/health', { cache: 'no-store' }).then(response => response.ok).catch(() => false)])
      setServerOnline(health)
      if (!mounted) return
      if (serverStore?.version >= 5) {
        await applyRemoteStore(serverStore)
      } else {
        await seedServerStore(storeRef.current)
        hydratedRef.current = true
      }
    }
    hydrate()
    const reconnectTimer = setInterval(async () => {
      const ok = await fetch('/api/health', { cache:'no-store' }).then(response => response.ok).catch(() => false)
      setServerOnline(ok)
      if (ok) {
        const fresh = await fetchServerStore()
        if (fresh) await applyRemoteStore(fresh)
      }
    }, 10000)
    const onlineHandler = () => {
      fetchServerStore().then(fresh => { if (fresh) { setServerOnline(true); return applyRemoteStore(fresh) } })
    }
    const offlineHandler = () => setServerOnline(false)
    window.addEventListener('online', onlineHandler)
    window.addEventListener('offline', offlineHandler)

    return () => {
      mounted = false
      channelRef.current?.removeEventListener('message', onMessage)
      channelRef.current?.close()
      serverEvents?.close()
      clearInterval(reconnectTimer)
      window.removeEventListener('online', onlineHandler)
      window.removeEventListener('offline', offlineHandler)
      window.removeEventListener('storage', onStorage)
    }
  // Initial hydration intentionally happens once; subsequent changes are persisted below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveTimerRef = useRef(null)

  useEffect(() => {
    if (!hydratedRef.current) return
    if (syncingRef.current) { syncingRef.current = false; return }
    broadcastStore(channelRef.current, store)
    markPendingSync(store)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      const ok = await saveStore(store)
      setServerOnline(ok)
    }, 180)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [store])

  useEffect(() => {
    const timer = setInterval(() => setSystemNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 2600)
    return () => clearTimeout(timer)
  }, [toast])

  const patchStore = updater => setStore(previous => stampStoreChanges(previous, typeof updater === 'function' ? updater(previous) : { ...previous, ...updater }))
  const pushAudit = (action, data = {}) => patchStore(previous => ({ ...previous, audit:[{ id:makeId('audit'), action, data, employeeId:activeEmployeeId, createdAt:nowStamp() }, ...(previous.audit || [])].slice(0, 500) }))

  const unlockAudio = async (testType = 'cash') => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) throw new Error('Audio no soportado')
      const context = audioRef.current || new AC()
      audioRef.current = context
      await context.resume()
      setAudioReady(true)
      patchStore(previous => ({ ...previous, config:{ ...previous.config, kitchen:{ ...previous.config.kitchen, soundEnabled:true } } }))
      const config = store.soundPresets?.[testType]
      if (config?.customDataUrl) {
        const audio = new Audio(config.customDataUrl)
        audio.volume = store.config?.kitchen?.volume || 0.45
        audio.play().catch(() => playTone(testType))
      } else {
        playTone(testType)
      }
      setToast('Sonidos activados')
    } catch { setToast('No se pudo activar el sonido') }
  }

  const playTone = useCallback((type) => {
    if (!audioRef.current) return
    const context = audioRef.current
    const preset = store.soundPresets?.[type]?.type || 'ping'
    const patterns = { click:[660], ping:[880], double:[660,880], triple:[660,880,1047] }
    const notes = patterns[preset] || patterns.ping
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      gain.gain.value = (kitchenSettings.volume || 0.45) * 0.18
      oscillator.connect(gain).connect(context.destination)
      const start = context.currentTime + index * 0.12
      oscillator.start(start)
      oscillator.stop(start + 0.1)
    })
  }, [kitchenSettings.volume, store.soundPresets])

  const playConfiguredSound = useCallback((type) => {
    if (!audioReady && type !== 'cash') return
    const config = store.soundPresets?.[type]
    if (config?.customDataUrl) {
      const audio = new Audio(config.customDataUrl)
      audio.volume = kitchenSettings.volume || 0.45
      audio.play().catch(() => playTone(type))
    } else playTone(type)
  }, [audioReady, kitchenSettings.volume, playTone, store.soundPresets])

  useEffect(() => {
    if (!kitchenSettings.soundEnabled || !audioReady) return
    const due = getDueKitchenAlerts(orders, systemNow, kitchenSettings)
    if (!due.length) return
    playConfiguredSound('delayed')
    const dueIds = new Set(due.map(item => item.order.id))
    patchStore(previous => ({
      ...previous,
      orders: previous.orders.map(order => dueIds.has(order.id) ? { ...order, lastKitchenAlertAt: systemNow } : order),
    }))
  }, [systemNow, audioReady, kitchenSettings, orders, playConfiguredSound])

  useEffect(() => {
    const currentIds = new Set(orders.map(order => order.id))
    if (knownOrderIdsRef.current == null) { knownOrderIdsRef.current = currentIds; return }
    const incoming = orders.filter(order => currentIds.has(order.id) && !knownOrderIdsRef.current.has(order.id) && ![STATUS.DELIVERED, STATUS.CANCELLED].includes(order.status))
    if (incoming.length && kitchenSettings.soundEnabled && audioReady) playConfiguredSound('newOrder')
    knownOrderIdsRef.current = currentIds
  }, [orders, audioReady, kitchenSettings.soundEnabled, playConfiguredSound])

  const tablesView = useMemo(() => tables.filter(table => table.active !== false).map(table => {
    const relatedIds = new Set([table.id, ...(table.joinedWith || [])])
    const relatedOrders = orders.filter(order => relatedIds.has(order.tableId) && ![STATUS.DELIVERED, STATUS.CANCELLED].includes(order.status))
    const status = relatedOrders.some(order => order.status === STATUS.READY) ? 'ready' : relatedOrders.some(order => order.status === STATUS.PREPARING) ? 'preparing' : relatedOrders.length ? 'occupied' : 'available'
    return { ...table, status, orders: relatedOrders, total:relatedOrders.reduce((sum, order) => sum + Number(order.total || 0), 0) }
  }), [tables, orders])

  const selectedTable = tablesView.find(table => table.id === selectedTableId) || null
  const checkoutEntity = useMemo(() => {
    if (!checkoutScreen) return null
    if (checkoutScreen.externalOrderId) {
      const order = orders.find(item => item.id === checkoutScreen.externalOrderId)
      return order ? { id:null, name:order.tableName, seats:1, joinedWith:[], orders:[order], total:Number(order.total||0) } : null
    }
    return tablesView.find(table => table.id === checkoutScreen.tableId) || null
  }, [checkoutScreen, orders, tablesView])
  const activeOrders = useMemo(() => orders.filter(order => ![STATUS.DELIVERED, STATUS.CANCELLED].includes(order.status)).sort((a,b) => (a.sentToKitchenAt || a.createdAt) - (b.sentToKitchenAt || b.createdAt)), [orders])
  const kitchenQueue = useMemo(() => activeOrders.map(order => ({ order, timing:getKitchenTiming(order, systemNow, kitchenSettings) })).sort((a,b) => b.timing.delayTime - a.timing.delayTime || a.order.createdAt - b.order.createdAt), [activeOrders, kitchenSettings, systemNow])
  const delayedOrders = kitchenQueue.filter(item => item.timing.alertLevel === 'delayed')
  const readyOrders = orders.filter(order => order.status === STATUS.READY)
  const deliveredOrders = orders.filter(order => order.status === STATUS.DELIVERED)
  const cancelledOrders = orders.filter(order => order.status === STATUS.CANCELLED)
  const todayStart = new Date(); todayStart.setHours(0,0,0,0)
  const todaySales = store.sales.filter(sale => sale.createdAt >= todayStart.getTime())
  const todayDelivered = deliveredOrders.filter(order => (order.closedAt || order.updatedAt || order.createdAt) >= todayStart.getTime())
  const totalSales = todaySales.reduce((sum, sale) => sum + Number(sale.netTotal ?? Math.max(0, Number(sale.total || 0) - Number(sale.tip || 0))), 0)
  const totalTips = todaySales.reduce((sum, sale) => sum + (Number(sale.tip) || 0), 0)
  const totalDiscounts = todaySales.reduce((sum, sale) => sum + (Number(sale.discount) || 0), 0)
  const totalPeople = todaySales.reduce((sum, sale) => sum + Number(sale.people || 0), 0)
  const avgDelivery = todayDelivered.length ? todayDelivered.reduce((sum, order) => sum + Math.max(0, (order.completedAt || order.updatedAt || order.createdAt) - (order.sentToKitchenAt || order.createdAt)), 0) / todayDelivered.length / 1000 : 0
  const paymentTotals = todaySales.reduce((acc, sale) => {
    const breakdown = sale.paymentBreakdown || { [sale.paymentMethod || 'Efectivo']: Number(sale.total || 0) }
    const gross = Object.values(breakdown).reduce((sum, amount) => sum + (Number(amount) || 0), 0)
    const net = Number(sale.netTotal ?? Math.max(0, Number(sale.total || 0) - Number(sale.tip || 0))) || 0
    const divisor = gross > 0 ? gross : 1
    Object.entries(breakdown).forEach(([method, amount]) => { acc[method] = (acc[method] || 0) + net * ((Number(amount) || 0) / divisor) })
    return acc
  }, {})
  const cashSessionStart = store.cash.isOpen ? Number(store.cash.openedAt || todayStart.getTime()) : Number(store.cash.lastClosedAt || todayStart.getTime())
  const cashMovements = (store.cash.movements || []).filter(item => item.createdAt >= cashSessionStart)
  const sessionCashSales = store.sales.filter(sale => sale.createdAt >= cashSessionStart)
  const sessionCashSalesTotal = sessionCashSales.reduce((sum, sale) => sum + Number((sale.paymentBreakdown || {}).Efectivo || (sale.paymentMethod === 'Efectivo' ? sale.netTotal ?? sale.total : 0) || 0), 0)
  const cashExpenses = cashMovements.filter(item => item.type === 'expense').reduce((sum,item) => sum + Number(item.amount || 0),0)
  const cashIncome = cashMovements.filter(item => item.type === 'income').reduce((sum,item) => sum + Number(item.amount || 0),0)
  const cashExpected = Number(store.cash.openingAmount || 0) + sessionCashSalesTotal + cashIncome - cashExpenses
  const analyticsStart = useMemo(() => {
    const start = new Date(todayStart)
    if (analyticsRange === '7d') start.setDate(start.getDate() - 6)
    else if (analyticsRange === '30d') start.setDate(start.getDate() - 29)
    else if (analyticsRange === 'all') start.setTime(0)
    return start.getTime()
  }, [analyticsRange, todayStart])
  const analyticsSales = useMemo(() => store.sales.filter(sale => Number(sale.createdAt || 0) >= analyticsStart), [store.sales, analyticsStart])
  const analyticsOrders = useMemo(() => orders.filter(order => Number(order.createdAt || 0) >= analyticsStart), [orders, analyticsStart])
  const analyticsProductRows = useMemo(() => {
    const byProduct = new Map()
    for (const sale of analyticsSales) {
      for (const orderId of sale.orderIds || []) {
        const order = orders.find(item => item.id === orderId)
        for (const item of order?.items || []) {
          const quantity = Number(item.quantity || 0)
          const revenue = Number(itemSubtotal(item) || 0)
          const row = byProduct.get(item.productId) || { productId:item.productId, name:item.productName || 'Producto', quantity:0, revenue:0 }
          row.quantity += quantity; row.revenue += revenue; byProduct.set(item.productId, row)
        }
      }
    }
    return [...byProduct.values()].sort((a,b)=>b.quantity-a.quantity || b.revenue-a.revenue)
  }, [analyticsSales, orders])
  const analyticsLowStock = ingredients.filter(item => Number(item.stock || 0) <= Number(item.minStock || 0))
  const analyticsStockValue = ingredients.reduce((sum,item)=>sum + Number(item.stock || 0) * Number(item.costPerUnit || 0), 0)
  const analyticsDelayed = analyticsOrders.filter(order => { const expected = Number(order.estimatedPrepTime || 0); const elapsed = Math.max(0, Number(order.completedAt || order.closedAt || systemNow) - Number(order.sentToKitchenAt || order.createdAt || systemNow)); return expected > 0 && elapsed > expected }).length
  const analyticsDelayRate = analyticsOrders.length ? analyticsDelayed / analyticsOrders.length * 100 : 0
  const analyticsInsights = useMemo(() => {
    const insights = []
    const top = analyticsProductRows[0]
    if (top) insights.push({ title:'Producto con más movimiento', text:`${top.name} · ${top.quantity} vendidos.` })
    if (analyticsLowStock.length) insights.push({ title:'Stock para revisar', text:`${analyticsLowStock.length} insumo${analyticsLowStock.length===1?'':'s'} en nivel bajo.` })
    if (analyticsDelayRate >= 20) insights.push({ title:'Cocina', text:`${Math.round(analyticsDelayRate)}% de los pedidos del periodo superaron su tiempo.` })
    if (analyticsSales.length < 5) insights.push({ title:'Datos', text:'Aún hay pocos cierres para hacer una predicción sólida.' })
    else if (!insights.length) insights.push({ title:'Operación estable', text:'No se detectaron señales fuertes en el periodo seleccionado.' })
    return insights.slice(0,4)
  }, [analyticsProductRows, analyticsLowStock.length, analyticsDelayRate, analyticsSales.length])
  const analyticsNextDemand = useMemo(() => {
    if (analyticsSales.length < 5) return null
    const weekday = new Date(systemNow).getDay()
    const sameDay = analyticsSales.filter(sale => new Date(sale.createdAt).getDay() === weekday)
    if (!sameDay.length) return null
    return Math.round(sameDay.length / Math.max(1, analyticsRange === 'all' ? 8 : analyticsRange === '30d' ? 4 : 1))
  }, [analyticsSales, analyticsRange, systemNow])

  const downloadAnalyticsCsv = () => {
    const rows = [['Producto','Unidades','Ingresos'], ...analyticsProductRows.map(row=>[row.name,row.quantity,Math.round(row.revenue)])]
    const csv = rows.map(row=>row.map(value=>`"${String(value).replaceAll('"','""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob); const link=document.createElement('a'); link.href=url; link.download='analisis-v8.csv'; link.click(); URL.revokeObjectURL(url)
    setToast('Análisis exportado')
  }


  const inventoryMovementStart = useMemo(() => {
    const date = new Date(systemNow); date.setHours(0,0,0,0)
    if (inventoryMovementDateFilter === 'yesterday') date.setDate(date.getDate()-1)
    if (inventoryMovementDateFilter === '7d') date.setDate(date.getDate()-6)
    if (inventoryMovementDateFilter === 'all') date.setTime(0)
    return date.getTime()
  }, [inventoryMovementDateFilter, systemNow])
  const inventoryMovementEnd = inventoryMovementDateFilter === 'yesterday' ? inventoryMovementStart + 86400000 : inventoryMovementDateFilter === 'all' ? Number.POSITIVE_INFINITY : Date.now() + 1000
  const visibleInventoryMovements = useMemo(() => {
    const q = inventoryMovementSearch.trim().toLowerCase()
    return (store.inventoryMovements || []).filter(move => {
      const dateMatch = Number(move.createdAt || 0) >= inventoryMovementStart && Number(move.createdAt || 0) <= inventoryMovementEnd
      const ingredientName = move.ingredientName || ingredients.find(item=>item.id===move.ingredientId)?.name || ''
      const text = `${ingredientName} ${move.reason || ''} ${move.type || ''}`.toLowerCase()
      return dateMatch && (!q || text.includes(q))
    }).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0))
  }, [store.inventoryMovements, inventoryMovementSearch, inventoryMovementStart, inventoryMovementEnd, ingredients])

  const activeOrdersFiltered = activeOrders.filter(order => {
    const query = orderSearch.toLowerCase().trim()
    return !query || `${order.number} ${order.tableName} ${order.items.map(item=>item.productName).join(' ')}`.toLowerCase().includes(query)
  })

  const historyOrders = useMemo(() => orders.filter(order => historyTab === 'all' ? [STATUS.DELIVERED,STATUS.CANCELLED].includes(order.status) : historyTab === 'cancelled' ? order.status === STATUS.CANCELLED : order.status === STATUS.DELIVERED).filter(order => historySearch === '' || `${order.number} ${order.tableName} ${order.items.map(item=>item.productName).join(' ')}`.toLowerCase().includes(historySearch.toLowerCase())).filter(order => historyEmployee === 'all' || order.employeeId === historyEmployee).filter(order => historyTable === 'all' || String(order.tableId) === String(historyTable)).sort((a,b) => (b.closedAt || b.updatedAt || b.createdAt) - (a.closedAt || a.updatedAt || a.createdAt)), [orders, historyTab, historySearch, historyEmployee, historyTable])

  const summaryOrders = useMemo(() => orders.filter(order => [STATUS.DELIVERED,STATUS.CANCELLED].includes(order.status)).filter(order => summarySearch === '' || `${order.number} ${order.tableName} ${order.items.map(item=>item.productName).join(' ')}`.toLowerCase().includes(summarySearch.toLowerCase())).sort((a,b)=>(b.closedAt || b.updatedAt || b.createdAt)-(a.closedAt || a.updatedAt || a.createdAt)), [orders, summarySearch])

  const changeTableCount = rawValue => {
    if (!canManageCatalog) return setToast('Solo Administrador puede cambiar la cantidad de mesas.')
    const count = Math.max(1, Math.min(40, Number(rawValue) || 1))
    const removedTables = tables.filter(table => Number(table.id) > count && table.active !== false)
    const occupiedRemoved = removedTables.find(table => tablesView.find(item => item.id === table.id)?.orders?.length)
    if (occupiedRemoved) return setToast(`${occupiedRemoved.name} tiene pedidos activos; ciérrala antes de reducir el número de mesas.`)
    patchStore(previous => {
      let nextTables = [...previous.tables]
      if (count > nextTables.filter(table => table.active !== false).length) {
        const inactive = nextTables.filter(table => table.active === false).sort((a,b)=>Number(a.id)-Number(b.id))
        let remaining = count - nextTables.filter(table => table.active !== false).length
        nextTables = nextTables.map(table => {
          if (remaining > 0 && inactive.some(item => item.id === table.id)) { remaining -= 1; return { ...table, active:true } }
          return table
        })
        const currentMax = Math.max(0, ...nextTables.map(table => Number(table.id) || 0))
        if (remaining > 0) nextTables = [...nextTables, ...Array.from({ length: remaining }, (_, index) => ({ ...tableDefaults[(currentMax + index) % tableDefaults.length], id:currentMax + index + 1, name:`Mesa ${currentMax + index + 1}`, active:true }))]
      } else {
        nextTables = nextTables.map(table => Number(table.id) > count ? { ...table, active:false, joinedWith:[] } : table)
      }
      return { ...previous, config:{ ...previous.config, tableCount:count }, tables:nextTables }
    })
  }

  const openOrderComposer = table => {
    setSelectedTableId(table.id)
    setCart([])
    setOrderScreen({ tableId:table.id, tableName:table.name, orderId:null, orderType:'mesa', customerId:null, reservationId:null, deliveryAddress:'' })
    setCategoryTab(categories[0]?.id || 'all')
    setCustomizing(null)
  }

  const openExternalOrderComposer = type => {
    setNewOrderPickerOpen(false)
    setView('orders')
    setSelectedTableId(null)
    setCart([])
    setOrderScreen({ tableId:null, tableName:ORDER_TYPES[type] || 'Pedido externo', orderId:null, orderType:type, customerId:null, reservationId:null, deliveryAddress:'' })
    setCategoryTab(categories[0]?.id || 'all')
    setCustomizing(null)
  }

  const openNewOrderFromPicker = table => {
    setNewOrderPickerOpen(false)
    setView('tables')
    openOrderComposer(table)
  }

  const editOrder = order => {
    if (order.status !== STATUS.PENDING) return setToast('Solo puedes editar una comanda que aún no ha empezado en cocina.')
    setCart(order.items || [])
    setSelectedTableId(order.tableId || null)
    setOrderScreen({ tableId:order.tableId || null, tableName:order.tableName, orderId:order.id, orderType:order.orderType || 'mesa', customerId:order.customerId || null, reservationId:order.reservationId || null, deliveryAddress:order.deliveryAddress || '' })
    setCategoryTab(categories[0]?.id || 'all')
  }

  const addProductToCart = product => {
    if (product.ingredients?.length || product.extras?.length) {
      setCustomizing({ product, extras:[], removedIngredients:[], note:'', quantity:1 })
      return
    }
    setCart(items => [...items, makeOrderItem(product)])
    setToast(`${product.name} agregado`)
  }

  const finishCustomizing = () => {
    const { product, extrasSelected, removedIngredients, note, quantity } = customizing
    const item = makeOrderItem(product, { extras:extrasSelected || [], removedIngredients:removedIngredients || [], note, quantity:Number(quantity)||1 })
    setCart(items => [...items, item])
    setCustomizing(null)
  }

  const saveOrder = () => {
    if (orderSubmitLockRef.current) return
    if (!orderScreen || !cart.length) return setToast('Agrega al menos un producto.')
    const tableCheck = orderScreen.orderType === 'mesa' ? tablesView.find(item => item.id === orderScreen.tableId) : null
    if (orderScreen.orderType === 'mesa' && !tableCheck) return setToast('La mesa ya no está disponible.')
    if (orderScreen.orderType === 'mesa' && !orderScreen.orderId && tableCheck.orders.length) return setToast('La mesa ya tiene una cuenta abierta.')
    orderSubmitLockRef.current = true
    const stamp = nowStamp()
    const table = tableCheck || { id:null, name:ORDER_TYPES[orderScreen.orderType] || 'Pedido externo', orders:[] }
    const estimatedPrepTime = calculateEstimatedPrepTime(cart, products, store.config.kitchen)
    const employeeId = activeEmployeeId
    patchStore(previous => {
      const number = Math.max(100, ...previous.orders.map(order => Number(order.number) || 0)) + 1
      if (orderScreen.orderId) {
        const existing = previous.orders.find(order => order.id === orderScreen.orderId)
        const replacement = existing?.status === STATUS.PREPARING ? {
          id:makeId('order'), number, tableId:table.id, tableName:table.name, orderType:orderScreen.orderType || 'mesa', customerId:orderScreen.customerId || null, reservationId:orderScreen.reservationId || null, deliveryAddress:orderScreen.deliveryAddress || '', status:STATUS.PENDING, items:cart, total:orderTotal(cart), createdAt:stamp, sentToKitchenAt:stamp, estimatedPrepTime, updatedAt:stamp, employeeId, sourceOrderId:existing.id, sourceOrderNumber:existing.number,
        } : null
        return { ...previous, orders:replacement ? [replacement, ...previous.orders] : previous.orders.map(order => order.id === orderScreen.orderId ? { ...order, items:cart, total:orderTotal(cart), estimatedPrepTime, updatedAt:stamp, employeeId, customerId:orderScreen.customerId || null, reservationId:orderScreen.reservationId || null, orderType:orderScreen.orderType || order.orderType || 'mesa', deliveryAddress:orderScreen.deliveryAddress || '' } : order) }
      }
      return { ...previous, orders:[{ id:makeId('order'), number, tableId:table.id, tableName:table.name, orderType:orderScreen.orderType || 'mesa', customerId:orderScreen.customerId || null, reservationId:orderScreen.reservationId || null, deliveryAddress:orderScreen.deliveryAddress || '', status:STATUS.PENDING, items:cart, total:orderTotal(cart), createdAt:stamp, sentToKitchenAt:stamp, estimatedPrepTime, updatedAt:stamp, employeeId }, ...previous.orders] }
    })
    setToast(`Pedido enviado a cocina · ${table.name}`)
    setCart([]); setOrderScreen(null); setView('tables')
    pushAudit(orderScreen.orderId ? 'pedido_editado' : 'pedido_creado', { tableId:table.id, orderId:orderScreen.orderId || null, total:orderTotal(cart) })
    window.setTimeout(() => { orderSubmitLockRef.current = false }, 600)
  }

  const updateOrderStatus = (id, status) => {
    const current = orders.find(order => order.id === id)
    if (!current) return
    const allowed = {
      [STATUS.PENDING]: [STATUS.PREPARING, STATUS.CANCELLED],
      [STATUS.PREPARING]: [STATUS.READY, STATUS.CANCELLED],
      [STATUS.READY]: [STATUS.DELIVERED, STATUS.CANCELLED],
      [STATUS.DELIVERED]: [],
      [STATUS.CANCELLED]: [],
    }
    if (!allowed[current.status]?.includes(status)) return setToast(`No se puede pasar ${statusLabel(current.status).toLowerCase()} a ${statusLabel(status).toLowerCase()}.`)
    const stamp = nowStamp()
    patchStore(previous => ({ ...previous, orders:previous.orders.map(order => order.id === id ? { ...order, status, updatedAt:stamp, completedAt:[STATUS.READY,STATUS.DELIVERED,STATUS.CANCELLED].includes(status) ? stamp : order.completedAt, employeeId:order.employeeId || activeEmployeeId } : order) }))
    if (status === STATUS.READY) playConfiguredSound('ready')
    pushAudit('pedido_estado', { orderId:id, status })
    setToast(`Pedido ${statusLabel(status).toLowerCase()}`)
  }

  const requestCancel = order => { setCancelTarget(order); setCancelReason('') }
  const confirmCancel = () => {
    if (!cancelTarget) return
    const stamp = nowStamp()
    patchStore(previous => ({ ...previous, orders:previous.orders.map(order => order.id === cancelTarget.id ? { ...order, status:STATUS.CANCELLED, cancelReason:cancelReason.trim() || 'Sin motivo especificado', cancelledAt:stamp, completedAt:stamp, updatedAt:stamp, employeeId:order.employeeId || activeEmployeeId } : order) }))
    setCancelTarget(null); setDetailOrder(null); setCancelReason(''); pushAudit('pedido_cancelado', { orderId:cancelTarget.id, reason:cancelReason.trim() || 'Sin motivo especificado' }); setToast('Pedido pasado a Cancelados; no se eliminó el registro.')
  }

  const joinTable = targetId => {
    if (!joinSource || joinSource === targetId) return
    patchStore(previous => {
      const source = previous.tables.find(table => table.id === joinSource)
      const target = previous.tables.find(table => table.id === targetId)
      const groupIds = new Set([joinSource, targetId, ...(source?.joinedWith || []), ...(target?.joinedWith || [])])
      return { ...previous, tables:previous.tables.map(table => groupIds.has(table.id) ? { ...table, joinedWith:[...groupIds].filter(id => id !== table.id) } : table) }
    })
    setJoinSource(null); setToast('Mesas unidas. Sus pedidos siguen separados.')
  }

  const splitTable = tableId => patchStore(previous => {
    const target = previous.tables.find(table => table.id === tableId)
    const linked = new Set([tableId, ...(target?.joinedWith || [])])
    return { ...previous, tables:previous.tables.map(table => linked.has(table.id) ? { ...table, joinedWith:[] } : table) }
  })

  const openCheckout = table => {
    if (!table?.orders?.length) return setToast('La mesa no tiene una cuenta abierta.')
    setCheckoutScreen({ tableId:table.id, method:'Efectivo', tip:'0', discount:'0', people:1, splitType:'total', paidCash:'', mixedSplitMode:'methods', mixedFirstMethod:'Efectivo', mixedFirstAmount:'', mixedSecondMethod:'Tarjeta', mixedSecondAmount:'', mixedPeopleParts:resizeSplitPeople(2) })
  }

  const openExternalCheckout = order => {
    if (!order) return
    setCheckoutScreen({ tableId:null, externalOrderId:order.id, method:'Efectivo', tip:'0', discount:'0', people:1, splitType:'total', paidCash:'', mixedSplitMode:'methods', mixedFirstMethod:'Efectivo', mixedFirstAmount:'', mixedSecondMethod:'Tarjeta', mixedSecondAmount:'', mixedPeopleParts:resizeSplitPeople(2) })
  }

  const getCheckoutTotals = checkout => {
    const entity = checkout?.externalOrderId ? orders.find(item=>item.id===checkout.externalOrderId) : tablesView.find(item=>item.id===checkout?.tableId)
    const subtotal = checkout?.externalOrderId ? Number(entity?.total||0) : (entity?.total || 0)
    const discount = Math.min(subtotal, Math.max(0, Number(checkout?.discount) || 0))
    const tip = Math.max(0, Number(checkout?.tip) || 0)
    const netTotal = Math.max(0, subtotal - discount)
    return { subtotal, discount, tip, netTotal, total:netTotal + tip }
  }

  const closeTable = () => {
    if (checkoutSubmitLockRef.current) return
    if (!checkoutScreen) return
    const checkoutTable = checkoutEntity
    if (!checkoutTable) return setToast('El pedido o la mesa ya no está disponible.')
    const subtotal = checkoutTable.total
    const discount = Math.min(subtotal, Math.max(0, Number(checkoutScreen.discount) || 0))
    const tip = Math.max(0, Number(checkoutScreen.tip) || 0)
    const netTotal = Math.max(0, subtotal - discount)
    const total = netTotal + tip
    const paidCash = Math.max(0, Number(checkoutScreen.paidCash) || 0)
    let paymentBreakdown = {}
    let cashPortion = 0
    let cashChange = 0
    if (checkoutScreen.method === 'Efectivo') {
      if (!store.cash.isOpen) return setToast('Abre la caja antes de registrar un pago en efectivo.')
      if (paidCash < total) return setToast(`Faltan ${money(total-paidCash,currentCurrency)} para completar el pago.`)
      paymentBreakdown = { Efectivo: total }
      cashPortion = total
      cashChange = paidCash - total
    } else if (checkoutScreen.method === 'Mixto') {
      if (checkoutScreen.mixedSplitMode === 'people') {
        const peopleCount = clampSplitPeople(checkoutScreen.people)
        const parts = (checkoutScreen.mixedPeopleParts || []).slice(0, peopleCount)
        if (parts.length !== peopleCount) return setToast(`Configura las ${peopleCount} partes del pago.`)
        const combinedAmount = sumSplitParts(parts)
        if (parts.some(part => Math.max(0, Number(part.amount) || 0) <= 0)) return setToast('Cada persona debe tener un monto mayor que 0.')
        if (Math.abs(combinedAmount-total) > 0.5) return setToast(`Las partes deben sumar exactamente ${money(total,currentCurrency)}.`)
        paymentBreakdown = buildPaymentBreakdownFromParts(parts)
        cashPortion = (paymentBreakdown.Efectivo || 0)
        if (cashPortion > 0) {
          if (!store.cash.isOpen) return setToast('Abre la caja antes de registrar la parte en efectivo.')
          if (paidCash < cashPortion) return setToast(`Faltan ${money(cashPortion-paidCash,currentCurrency)} de efectivo recibido.`)
          cashChange = paidCash - cashPortion
        }
      } else {
        const firstMethod = checkoutScreen.mixedFirstMethod || 'Efectivo'
        const secondMethod = checkoutScreen.mixedSecondMethod || 'Tarjeta'
        const firstAmount = Math.max(0, Number(checkoutScreen.mixedFirstAmount) || 0)
        const secondAmount = Math.max(0, Number(checkoutScreen.mixedSecondAmount) || 0)
        const combinedAmount = firstAmount + secondAmount
        if (firstMethod === secondMethod) return setToast('Elige dos métodos diferentes para combinar el pago.')
        if (firstAmount <= 0 || secondAmount <= 0) return setToast('Indica cuánto vas a pagar con cada método.')
        if (Math.abs(combinedAmount-total) > 0.5) return setToast(`Los dos pagos deben sumar exactamente ${money(total,currentCurrency)}. Faltan ${money(Math.max(0,total-combinedAmount),currentCurrency)}.`)
        paymentBreakdown = { [firstMethod]: firstAmount, [secondMethod]: secondAmount }
        cashPortion = (firstMethod === 'Efectivo' ? firstAmount : 0) + (secondMethod === 'Efectivo' ? secondAmount : 0)
        if (cashPortion > 0) {
          if (!store.cash.isOpen) return setToast('Abre la caja antes de registrar la parte en efectivo.')
          if (paidCash < cashPortion) return setToast(`Faltan ${money(cashPortion-paidCash,currentCurrency)} de efectivo recibido.`)
          cashChange = paidCash - cashPortion
        }
      }
    } else paymentBreakdown = { [checkoutScreen.method]: total }

    const allItems = checkoutTable.orders.flatMap(order => order.items || [])
    const inventoryCheck = getInventoryForItems(allItems)
    if (!inventoryCheck.ok) {
      const message = inventoryCheck.shortages.slice(0,3).map(item => `${item.ingredientName}: faltan ${item.missing}${item.unit}`).join(' · ')
      return setToast(`Stock insuficiente · ${message}`)
    }

    checkoutSubmitLockRef.current = true
    const stamp = nowStamp()
    const paymentMethod = checkoutScreen.method === 'Mixto' ? 'Combinado' : checkoutScreen.method
    const sale = { id:makeId('sale'), createdAt:stamp, tableId:checkoutTable.id, tableName:checkoutTable.name, orderIds:checkoutTable.orders.map(order=>order.id), customerId:checkoutTable.orders.find(order=>order.customerId)?.customerId || null, reservationId:checkoutTable.orders.find(order=>order.reservationId)?.reservationId || null, orderType:checkoutTable.orders.find(order=>order.orderType)?.orderType || 'mesa', subtotal, discount, netTotal, tip, total, paymentMethod, paymentBreakdown, people:Number(checkoutScreen.people)||1, employeeId:activeEmployeeId, inventoryDeducted:true, cashReceived:cashPortion ? paidCash : 0, cashChange:cashPortion ? cashChange : 0 }
    const receipt = { id:makeId('doc'), type:'comprobante', createdAt:stamp, saleId:sale.id, customerId:sale.customerId, orderType:sale.orderType, restaurantName:store.config.restaurantName, tableName:checkoutTable.name, employeeId:activeEmployeeId, items:allItems.map(item=>({ productName:item.productName, quantity:item.quantity, unitPrice:Number(item.basePrice||0), extras:(item.extras||[]).map(extra=>({name:extra.name,price:Number(extra.price||0)})), subtotal:itemSubtotal(item) })), subtotal, discount, tip, total, paymentMethod, paymentBreakdown, people:Number(checkoutScreen.people)||1, cashReceived:cashPortion ? paidCash : 0, cashChange:cashPortion ? cashChange : 0 }
    const deduction = deductInventoryForSale(store.ingredients, inventoryCheck.requirements, sale.id, activeEmployeeId, stamp)
    patchStore(previous => ({
      ...previous,
      sales:[sale, ...(previous.sales || [])],
      documents:[receipt, ...(previous.documents || [])],
      ingredients:deduction.ingredients,
      inventoryMovements:[...deduction.movements, ...(previous.inventoryMovements || [])],
      orders:previous.orders.map(order => checkoutTable.orders.some(tableOrder => tableOrder.id === order.id) ? { ...order, status:STATUS.DELIVERED, updatedAt:stamp, completedAt:stamp, closedAt:stamp, paymentMethod, tip, discount, paidTotal:total, paymentBreakdown, employeeId:order.employeeId || activeEmployeeId } : order),
      tables:previous.tables.map(table => table.id === checkoutTable.id || checkoutTable.joinedWith?.includes(table.id) ? { ...table, joinedWith:[] } : table),
    }))
    playConfiguredSound('cash')
    setCheckoutScreen(null); setSelectedTableId(null); setReceiptPreview(receipt)
    pushAudit('venta_cerrada', { saleId:sale.id, tableId:checkoutTable.id, total, paymentMethod })
    window.setTimeout(() => { checkoutSubmitLockRef.current = false }, 800)
    setToast(`${checkoutScreen.externalOrderId ? 'Pedido cerrado' : 'Mesa cerrada'} · ${money(total,currentCurrency)}`)
  }

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
  const receiptHtml = receipt => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Comprobante ${escapeHtml(receipt.id)}</title>
<style>body{font-family:Arial,sans-serif;max-width:720px;margin:32px auto;padding:20px;color:#18241d}h1{margin:0 0 6px}table{width:100%;border-collapse:collapse;margin-top:18px}td{padding:8px 0;border-bottom:1px solid #ddd}.right{text-align:right}.total{font-size:22px;font-weight:800}.meta{color:#68756d;font-size:12px;line-height:1.6}@media print{body{margin:0;max-width:none}}</style>
</head>
<body>
<h1>${escapeHtml(receipt.restaurantName)}</h1>
<div class="meta">Comprobante · ${escapeHtml(receipt.tableName)} · ${new Date(receipt.createdAt).toLocaleString('es-CO')}<br>Atendido por: ${escapeHtml(employees.find(employee=>employee.id===receipt.employeeId)?.name || 'Sin asignar')}</div>
<table>${receipt.items.map(item=>`<tr>
<td>${item.quantity} × ${escapeHtml(item.productName)}${item.extras?.length?`<div class="meta">+ ${item.extras.map(extra=>escapeHtml(extra.name)).join(', ')}</div>`:''}</td>
<td class="right">${money(item.subtotal,currentCurrency)}</td>
</tr>`).join('')}</table>
<p>Subtotal: <strong>${money(receipt.subtotal,currentCurrency)}</strong>
<br>Descuento: <strong>${money(receipt.discount,currentCurrency)}</strong>
<br>Propina: <strong>${money(receipt.tip,currentCurrency)}</strong>
<br>Método: <strong>${escapeHtml(receipt.paymentMethod)}</strong>${receipt.paymentBreakdown && Object.keys(receipt.paymentBreakdown).length?`<br>${Object.entries(receipt.paymentBreakdown).map(([method,amount])=>`${escapeHtml(method)}: <strong>${money(amount,currentCurrency)}</strong>`).join('<br>')}`:''}${receipt.cashChange?`<br>Cambio: <strong>${money(receipt.cashChange,currentCurrency)}</strong>`:''}</p>
<p class="total">Total: ${money(receipt.total,currentCurrency)}</p>
<p class="meta">Este documento es un comprobante generado por el sistema.</p>
</body>
</html>`
  const printReceipt = receipt => { const popup=window.open('', '_blank', 'width=760,height=900'); if(!popup) return setToast('El navegador bloqueó la ventana de impresión.'); popup.document.write(receiptHtml(receipt)); popup.document.close(); popup.focus(); popup.print() }
  const downloadReceiptPdf = receipt => { const blob=new Blob([buildReceiptPdf(receipt,currentCurrency)],{type:'application/pdf'}); const url=URL.createObjectURL(blob); const link=document.createElement('a'); link.href=url; link.download=`comprobante-${receipt.tableName.replace(/\s+/g,'-').toLowerCase()}-${receipt.id}.pdf`; link.click(); URL.revokeObjectURL(url); setToast('PDF descargado') }

  const openCash = () => {
    if (!canManageCash) return setToast('Solo Caja o Administrador puede abrir la caja.')
    if (cashActionLockRef.current) return
    if (store.cash.isOpen) return setToast('La caja ya está abierta.')
    cashActionLockRef.current = true
    const amount = Math.max(0, Number(cashAmount) || 0)
    patchStore(previous => ({ ...previous, cash:{ ...previous.cash, isOpen:true, openingAmount:amount, openedAt:nowStamp(), openedBy:activeEmployeeId } }))
    setCashAmount(''); pushAudit('caja_abierta', { amount }); setToast('Caja abierta'); window.setTimeout(() => { cashActionLockRef.current = false }, 700)
  }

  const closeCash = () => {
    if (!canManageCash) return setToast('Solo Caja o Administrador puede cerrar la caja.')
    if (cashActionLockRef.current) return
    if (!store.cash.isOpen) return setToast('La caja ya está cerrada.')
    const counted = Math.max(0, Number(cashCounted) || 0)
    if (!cashCounted.trim()) return setToast('Ingresa el dinero contado para cerrar la caja.')
    cashActionLockRef.current = true
    const closing = { id:makeId('closing'), createdAt:nowStamp(), openedAt:store.cash.openedAt, openingAmount:store.cash.openingAmount, expectedAmount:cashExpected, countedAmount:counted, difference:counted-cashExpected, closedBy:activeEmployeeId }
    patchStore(previous => ({ ...previous, cash:{ ...previous.cash, isOpen:false, closings:[closing, ...(previous.cash.closings||[])], lastClosedAt:closing.createdAt, lastDifference:closing.difference } }))
    setCashCounted(''); pushAudit('caja_cerrada', { closingId:closing.id, difference:closing.difference }); setToast(`Caja cerrada · diferencia ${money(closing.difference, currentCurrency)}`); window.setTimeout(() => { cashActionLockRef.current = false }, 900)
  }

  const addCashMovement = type => {
    if (!canManageCash) return setToast('Solo Caja o Administrador puede registrar movimientos.')
    if (cashActionLockRef.current) return
    if (!expenseEditor) return
    if (!store.cash.isOpen) return setToast('Abre la caja antes de registrar un movimiento.')
    const amount = Math.max(0, Number(expenseEditor.amount) || 0)
    if (!amount || !expenseEditor.reason.trim()) return setToast('Completa monto y motivo.')
    cashActionLockRef.current = true
    const movement = { id:makeId(type), type, amount, reason:expenseEditor.reason.trim(), createdAt:nowStamp(), employeeId:activeEmployeeId, paymentMethod:expenseEditor.method || 'Efectivo' }
    patchStore(previous => ({ ...previous, cash:{ ...previous.cash, movements:[movement, ...(previous.cash.movements||[])] } }))
    setExpenseEditor(null); pushAudit(type === 'expense' ? 'gasto_registrado' : 'ingreso_registrado', { amount, reason:movement.reason }); setToast(type === 'expense' ? 'Gasto registrado' : 'Ingreso de caja registrado'); window.setTimeout(() => { cashActionLockRef.current = false }, 600)
  }

  const getInventoryForItems = items => validateInventoryForSale(items, products, ingredients)

  const saveInventoryMovement = () => {
    if (!canManageInventory) return setToast('Solo Administrador puede modificar el inventario.')
    if (inventoryActionLockRef.current) return
    if (!inventoryMoveEditor) return
    const ingredient = ingredients.find(item => item.id === inventoryMoveEditor.ingredientId)
    if (!ingredient) return setToast('Selecciona un ingrediente.')
    const quantity = Number(inventoryMoveEditor.quantity)
    const validQuantity = inventoryMoveEditor.type === 'adjust' ? Number.isFinite(quantity) && quantity >= 0 : Number.isFinite(quantity) && quantity > 0
    if (!validQuantity) return setToast(inventoryMoveEditor.type === 'adjust' ? 'Ingresa un stock de 0 o mayor.' : 'Ingresa una cantidad mayor a 0.')
    inventoryActionLockRef.current = true
    const stamp = nowStamp()
    const nextStock = inventoryMoveEditor.type === 'adjust' ? quantity : Number(ingredient.stock || 0) + quantity
    const movement = { id:makeId('inv'), type:inventoryMoveEditor.type === 'adjust' ? 'adjustment' : 'purchase', ingredientId:ingredient.id, ingredientName:ingredient.name, quantity:inventoryMoveEditor.type === 'adjust' ? nextStock - Number(ingredient.stock || 0) : quantity, unit:ingredient.unit, stockBefore:Number(ingredient.stock||0), stockAfter:nextStock, reason:inventoryMoveEditor.reason.trim() || (inventoryMoveEditor.type === 'adjust' ? 'Ajuste manual' : 'Entrada de inventario'), employeeId:activeEmployeeId, createdAt:stamp }
    patchStore(previous => ({ ...previous, ingredients:previous.ingredients.map(item=>item.id===ingredient.id?{...item,stock:nextStock,updatedAt:stamp}:item), inventoryMovements:[movement,...(previous.inventoryMovements||[])] }))
    setInventoryMoveEditor(null); pushAudit('inventario_movimiento', { movementId:movement.id, ingredientId:ingredient.id, type:movement.type, quantity:movement.quantity }); setToast('Inventario actualizado'); window.setTimeout(() => { inventoryActionLockRef.current = false }, 650)
  }

  const toggleWorkMode = () => { setWorkMode(value => { const next = !value; localStorage.setItem('restaurant-work-mode', next ? '1' : '0'); return next }); }

  const requestEmployeeChange = employeeId => {
    const target = employees.find(employee => employee.id === employeeId)
    if (!target || !target.active) return
    if (!target.pin) return setToast('Ese empleado no tiene PIN configurado.')
    setEmployeePrompt({ employeeId: target.id, pin: '' })
  }

  const confirmEmployeeChange = () => {
    if (!employeePrompt) return
    const target = employees.find(employee => employee.id === employeePrompt.employeeId)
    if (!target || employeePrompt.pin !== target.pin) return setToast('PIN incorrecto.')
    setActiveEmployeeId(target.id)
    localStorage.setItem('restaurant-active-employee', target.id)
    setEmployeePrompt(null)
    setToast(`Sesión activa: ${target.name}`)
  }

  const openCashFromIndicator = () => {
    if (!canManageCash) return setToast('Solo Caja o Administrador puede gestionar la caja.')
    if (store.cash.isOpen) { setView('summary'); setSummaryTab('caja'); return }
    setCashAmount(''); setView('summary'); setSummaryTab('caja')
  }

  const openNewIngredient = () => {
    if (!canManageCatalog) return setToast('Solo Administrador puede agregar ingredientes.')
    setIngredientEditor({ id:null, name:'', category:ingredientCategories[0] || '', unit:'g', costPerUnit:0, stock:0, minStock:0, active:true })
  }

  const saveCustomer = draft => {
    const name = String(draft.name || '').trim()
    if (!name) return setToast('Escribe el nombre del cliente.')
    const id = draft.id || makeId('customer')
    patchStore(previous => ({ ...previous, customers:previous.customers.some(item=>item.id===id) ? previous.customers.map(item=>item.id===id ? { ...item, ...draft, id, name } : item) : [{ ...draft, id, name, createdAt:nowStamp() }, ...previous.customers] }))
    setCustomerEditor(null)
    setToast(draft.id ? 'Cliente actualizado' : 'Cliente creado')
  }

  const openReservationOperation = reservation => {
    if (!reservation.tableId) return setToast('Asigna una mesa para abrir la comanda desde la reserva.')
    const table = tablesView.find(item=>String(item.id)===String(reservation.tableId))
    if (!table) return setToast('La mesa de la reserva ya no existe.')
    setView('tables')
    openOrderComposer(table)
    setOrderScreen(previous=>({...previous,customerId:reservation.customerId||null,reservationId:reservation.id}))
  }

  const saveReservation = draft => {
    const customer = customers.find(item=>item.id===draft.customerId)
    if (!draft.date || !draft.time || !draft.people || !customer) return setToast('Completa fecha, hora, personas y cliente.')
    const id = draft.id || makeId('reservation')
    patchStore(previous => ({ ...previous, reservations:previous.reservations.some(item=>item.id===id) ? previous.reservations.map(item=>item.id===id?{ ...item, ...draft, id, customerName:customer.name }:item) : [{ ...draft, id, customerName:customer.name, status:draft.status || 'pendiente', createdAt:nowStamp() }, ...previous.reservations] }))
    setReservationEditor(null)
    setToast(draft.id ? 'Reserva actualizada' : 'Reserva creada')
  }

    const saveIngredient = draft => {
    if (!canManageCatalog) return setToast('Solo Administrador puede modificar el catálogo.')
    const existing = Boolean(draft.id)
    const stock = existing ? Number(ingredients.find(item => item.id === draft.id)?.stock || 0) : Math.max(0, Number(draft.stock) || 0)
    const ingredient = { ...draft, id:draft.id || makeId('ingredient'), name:draft.name.trim(), costPerUnit:Math.max(0, Number(draft.costPerUnit) || 0), minStock:Math.max(0, Number(draft.minStock) || 0), stock, active:draft.active !== false }
    if (!ingredient.name) return setToast('Escribe el nombre del ingrediente.')
    if (existing) patchStore(previous => ({ ...previous, ingredients:previous.ingredients.map(item=>item.id===ingredient.id?{...item,...ingredient}:item) }))
    else patchStore(previous => ({ ...previous, ingredients:[ingredient,...previous.ingredients] }))
    setIngredientEditor(null); setToast(existing ? 'Ingrediente actualizado' : 'Ingrediente creado')
  }

  const saveProduct = draft => {
    if (!canManageCatalog) return setToast('Solo Administrador puede modificar el catálogo.')
    const product = {
      id:draft.id || makeId('product'), name:draft.name.trim(), description:draft.description.trim(), price:Math.max(0, Number(draft.price)||0), categoryId:draft.categoryId,
      isActive:draft.isActive, estimatedPrepTime:Math.max(60, Number(draft.estimatedPrepTime)||900), ingredients:draft.ingredientIds || [], ingredientUsage:draft.ingredientUsage || {}, ingredientUsageUnit:draft.ingredientUsageUnit || {}, extraIds:draft.extraIds || [], image:draft.image || '',
    }
    if (!product.name || !product.price || !product.categoryId) return setToast('Completa nombre, precio y categoría.')
    patchStore(previous => ({ ...previous, products:product.id && previous.products.some(item=>item.id===product.id) ? previous.products.map(item=>item.id===product.id?product:item) : [product,...previous.products] }))
    setProductEditor(null); setToast('Producto guardado')
  }

  const toggleProductActive = product => {
    if (!canManageCatalog) return setToast('Solo Administrador puede modificar el catálogo.')
    patchStore(previous=>({...previous,products:previous.products.map(item=>item.id===product.id?{...item,isActive:!item.isActive}:item)}))
  }

  const duplicateProduct = product => {
    if (!canManageCatalog) return setToast('Solo Administrador puede modificar el catálogo.')
    patchStore(previous => ({ ...previous, products:[{ ...product, id:makeId('product'), name:`${product.name} copia` }, ...previous.products] }))
    setToast('Producto duplicado')
  }

  const saveEntity = (type, entity, close) => {
    if (!canManageCatalog && !['employees'].includes(type)) return setToast('Solo Administrador puede modificar este apartado.')
    if (type === 'employees' && activeEmployee?.role !== 'Administrador') return setToast('Solo Administrador puede gestionar empleados.')
    if ((type === 'employees') && (!entity.name?.trim() || !/^\d{4,6}$/.test(entity.pin || ''))) return setToast('El empleado necesita un PIN de 4 a 6 dígitos.')
    const id = entity.id || makeId(type.slice(0,-1))
    patchStore(previous => ({ ...previous, [type]:previous[type].some(item=>item.id===id) ? previous[type].map(item=>item.id===id?{...entity,id}:item) : [{...entity,id},...previous[type]] }))
    close(null); setToast('Guardado')
  }

  const deleteCategory = categoryId => {
    if (!canManageCatalog) return setToast('Solo Administrador puede modificar categorías.')
    const used = products.some(product => product.categoryId === categoryId)
    if (used) return setToast('Primero mueve los productos de esta categoría.')
    patchStore(previous => ({ ...previous, categories:previous.categories.map(category=>category.id===categoryId?{...category,active:false,updatedAt:nowStamp()}:category) }))
  }

  const setSoundPreset = (type, preset) => {
    if (!canManageCatalog) return setToast('Solo Administrador puede personalizar sonidos.')
    patchStore(previous => ({ ...previous, soundPresets:{ ...previous.soundPresets, [type]:{ type:preset, customDataUrl:'' } } }))
  }

  const uploadSound = (type, file) => {
    if (!canManageCatalog) return setToast('Solo Administrador puede personalizar sonidos.')
    if (!file) return
    if (!file.type.startsWith('audio/')) return setToast('Selecciona un archivo de audio.')
    if (file.size > 1_500_000) return setToast('El archivo de sonido no puede superar 1.5 MB.')
    const audio = document.createElement('audio')
    const url = URL.createObjectURL(file)
    audio.src = url
    audio.onerror = () => { URL.revokeObjectURL(url); setToast('No se pudo leer el archivo de audio.') }
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(url)
      if (!Number.isFinite(audio.duration) || audio.duration > 2) return setToast('El sonido debe durar máximo 2 segundos.')
      const reader = new FileReader()
      reader.onload = () => {
        patchStore(previous => ({ ...previous, soundPresets:{ ...previous.soundPresets, [type]:{ type:'custom', customDataUrl:reader.result } } }))
        setToast('Sonido personalizado guardado')
      }
      reader.readAsDataURL(file)
    }
  }

  const handleTablePointerDown = (event, tableId) => {
    if (!tableConfigMode || !canManageCatalog) return
    event.preventDefault(); event.stopPropagation()
    const board = event.currentTarget.closest('.salon-board')
    if (!board) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    tableDragRef.current = { tableId, pointerId:event.pointerId, board }
    setSelectedTableId(tableId); setDraggingTableId(tableId)
  }

  const handleTablePointerMove = event => {
    const drag = tableDragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    const rect = drag.board.getBoundingClientRect()
    const x = Math.min(92, Math.max(8, ((event.clientX - rect.left) / rect.width) * 100))
    const y = Math.min(90, Math.max(10, ((event.clientY - rect.top) / rect.height) * 100))
    patchStore(previous => ({ ...previous, tables:previous.tables.map(table => table.id === drag.tableId ? { ...table, x, y } : table) }))
  }

  const handleTablePointerUp = event => {
    if (!tableDragRef.current || event.pointerId !== tableDragRef.current.pointerId) return
    tableDragRef.current = null; setDraggingTableId(null)
  }

  const addSalonTable = () => {
    if (!canManageCatalog) return setToast('Solo Administrador puede agregar mesas.')
    patchStore(previous => {
      const usedIds = new Set(previous.tables.map(table=>Number(table.id)||0))
      let id = Math.max(0,...usedIds) + 1; while (usedIds.has(id)) id += 1
      const activeCount = previous.tables.filter(table=>table.active !== false).length
      return { ...previous, config:{ ...previous.config, tableCount:activeCount+1 }, tables:[...previous.tables, { id, name:`Mesa ${id}`, shape:'round', seats:2, x:50, y:50, joinedWith:[], active:true, updatedAt:nowStamp() }] }
    })
    setTableConfigMode(true); setToast('Mesa agregada')
  }


  const addEntityCategory = (type, value, setter) => {
    if (!canManageCatalog) return setToast('Solo Administrador puede crear categorías.')
    const name = value.trim()
    if (!name) return setToast('Escribe un nombre para la categoría.')
    const key = type === 'ingredient' ? 'ingredientCategories' : 'extraCategories'
    patchStore(previous => ({ ...previous, [key]:[...new Set([...(previous[key] || []), name])] }))
    setter(name)
    setEntityCategoryEditor(null)
    setToast('Categoría agregada')
  }

  const requestBackup = async () => {
    if (!canManageCatalog) return setToast('Solo Administrador puede descargar respaldos.')
    try {
      const response = await fetch('/api/backup', { cache:'no-store' })
      if (!response.ok) throw new Error()
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'restaurante-v8-backup.db'
      link.click()
      URL.revokeObjectURL(url)
      setToast('Respaldo SQLite descargado')
    } catch { setToast('No se pudo descargar el respaldo') }
  }

  const resetLayout = () => {
    if (!canManageCatalog) return setToast('Solo Administrador puede configurar el salón.')
    if (!window.confirm('¿Restaurar la distribución del salón?')) return
    patchStore(previous => ({ ...previous, tables:previous.tables.map((table,index)=>({ ...table, x:[12,38,65,12,38,65,38,65][index%8], y:[16,16,16,50,50,50,78,78][index%8], shape:['round','wide','square','oval'][index%4], seats:[2,4,4,6][index%4] })) }))
  }

  const tableStatuses = { available:tablesView.filter(t=>t.status==='available').length, occupied:tablesView.filter(t=>t.status==='occupied').length, preparing:tablesView.filter(t=>t.status==='preparing').length, ready:tablesView.filter(t=>t.status==='ready').length }

  const nav = [
    ['home','Inicio','⌂'],['tables','Mesas','▦'],['kitchen','Cocina','◒'],['orders','Pedidos','≡'],['history','Historial','◷'],['summary','Resumen','◫'],['analytics','Análisis','◔'],['customers','Clientes','◯'],['reservations','Reservas','⌚'],['inventory','Inventario','▤'],['menu','Menú','✦'],['config','Configuración','⚙'],
  ]
  const visibleNav = workMode ? nav.filter(([key]) => activeEmployee?.role === 'Cocina' ? ['kitchen'].includes(key) : activeEmployee?.role === 'Caja' ? ['tables','summary','analytics','history'].includes(key) : activeEmployee?.role === 'Mesero' ? ['tables','orders','history','customers','reservations'].includes(key) : ['home','tables','kitchen','orders','summary','analytics','history','customers','reservations','inventory','menu','config'].includes(key)) : nav

  return <div className={`app-shell ${workMode?'work-mode':''}`}>
    <aside className="sidebar">
      <div className="brand-block"><div className="logo-mark">V</div><div><span className="eyebrow">POS LOCAL · V8</span><h1>{store.config.restaurantName}</h1></div></div>
      <label className="employee-switch"><span>Empleado activo</span><select value={activeEmployeeId} onChange={event=>requestEmployeeChange(event.target.value)}>{employees.filter(employee=>employee.active).map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label><button className={`work-mode-toggle ${workMode?'active':''}`} onClick={toggleWorkMode}>{workMode?'Modo trabajo activo':'Modo trabajo'}</button>
      <button className="secondary-btn full-width" onClick={()=>setGlobalSearchOpen(true)}>⌕ Buscar en todo</button>
      <nav className="sidebar-nav">{visibleNav.map(([key,label,icon])=><button key={key} className={`nav-item ${view===key?'active':''}`} onClick={()=>setView(key)}><span className="nav-icon">{icon}</span><span>{label}</span></button>)}</nav>
      <div className="sidebar-footer">
<button className={`system-status system-status-button ${store.cash.isOpen?'ok':''}`} onClick={openCashFromIndicator}>
<span className="status-dot"/>
<div>
<strong>{store.cash.isOpen?'Caja abierta':'Caja cerrada'}</strong>
<small>{store.cash.isOpen ? money(cashExpected,currentCurrency) : 'Toca para abrir caja'}</small>
</div>
<span className="status-arrow">→</span>
</button>
<div className="sync-status">
<span className={`pulse-dot ${serverOnline?'online':'offline'}`}/>{serverOnline?'SQLite + sincronización activa':'Modo local · servidor desconectado'}</div>
</div>
    </aside>

    <main className="main-panel">
      <header className="topbar">
<div>
<span className="topbar-kicker">Operación actual</span>
<h2>{view==='tables'?'Salón y mesas':view==='kitchen'?'Control de cocina':view==='orders'?'Pedidos activos':view==='history'?'Historial':view==='summary'?'Resumen del negocio':view==='analytics'?'Análisis inteligente':view==='customers'?'Clientes':view==='reservations'?'Reservas':view==='menu'?'Menú y catálogo':view==='inventory'?'Inventario':view==='config'?'Administración':'Centro de operación'}</h2>
</div>
<div className="topbar-actions">
<button className="secondary-btn" onClick={toggleWorkMode}>{workMode?'Salir de modo trabajo':'Modo trabajo'}</button>
<button className="secondary-btn" onClick={()=>setView('tables')}>Mesas</button>
<button className="primary-btn" onClick={()=>setNewOrderPickerOpen(true)}>+ Nueva comanda</button>
</div>
</header>
      {toast && <div className="toast" role="status">{toast}</div>}

      {newOrderPickerOpen && (
        <div className="modal-backdrop">
          <div className="entity-editor large">
            <div className="modal-header">
              <div>
                <span className="eyebrow">Nueva comanda</span>
                <h3>¿En qué mesa?</h3>
                <p className="muted-copy">Elige el tipo de pedido y luego la mesa o el canal correspondiente.</p>
                <div className="tab-strip">
                  <button className={newOrderType === 'mesa' ? 'selected' : ''} onClick={() => setNewOrderType('mesa')}>En mesa</button>
                  <button className={newOrderType === 'pickup' ? 'selected' : ''} onClick={() => setNewOrderType('pickup')}>Para llevar</button>
                  <button className={newOrderType === 'delivery' ? 'selected' : ''} onClick={() => setNewOrderType('delivery')}>Domicilio</button>
                </div>
              </div>
              <button className="icon-btn" onClick={() => setNewOrderPickerOpen(false)}>×</button>
            </div>

            {newOrderType !== 'mesa' && (
              <div className="new-order-table-grid">
                <button className="primary-btn full-width" onClick={() => openExternalOrderComposer(newOrderType)}>
                  Crear {ORDER_TYPES[newOrderType]}
                </button>
              </div>
            )}

            {newOrderType === 'mesa' && (
              <div className="new-order-table-grid">
                {tablesView.filter(table => table.status === 'available').map(table => (
                  <button key={table.id} className="new-order-table-option" onClick={() => openNewOrderFromPicker(table)}>
                    <strong>{table.name}</strong>
                    <span>{table.seats} puestos</span>
                    <small>Libre</small>
                  </button>
                ))}
                {!tablesView.some(table => table.status === 'available') && (
                  <div className="empty-state wide">
                    <strong>No hay mesas libres</strong>
                    <span>Primero libera una mesa o abre una nueva.</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {employeePrompt && <div className="modal-backdrop">
<div className="entity-editor">
<div className="modal-header">
<div>
<span className="eyebrow">Cambio de empleado</span>
<h3>Confirma el PIN</h3>
<p className="muted-copy">{employees.find(employee=>employee.id===employeePrompt.employeeId)?.name || 'Empleado'}</p>
</div>
<button className="icon-btn" onClick={()=>setEmployeePrompt(null)}>×</button>
</div>
<label>PIN<input autoFocus inputMode="numeric" type="password" maxLength={6} value={employeePrompt.pin} onChange={event=>setEmployeePrompt(previous=>({...previous,pin:event.target.value.replace(/\D/g,'').slice(0,6)}))} onKeyDown={event=>{if(event.key==='Enter')confirmEmployeeChange()}}/>
</label>
<div className="modal-footer">
<button className="secondary-btn" onClick={()=>setEmployeePrompt(null)}>Cancelar</button>
<button className="primary-btn" onClick={confirmEmployeeChange}>Entrar</button>
</div>
</div>
</div>}

      {view==='home' && <section className="screen home-screen">
        <div className="hero-panel">
<div>
<span className="eyebrow accent">V8 · Operación local</span>
<h3>Fácil para el equipo. Potente por dentro.</h3>
<p>Mesas visuales, comandas rápidas, inventario real, tiempos por plato, caja y sincronización preparados para trabajar sin perder el ritmo.</p>
</div>
<div className="hero-actions">
<button className="primary-btn" onClick={()=>setView('tables')}>Abrir salón</button>
<button className="secondary-btn" onClick={()=>setView('summary')}>Ver resumen</button>
</div>
</div>
        <div className="metrics-grid"><StatCard label="Ventas de hoy" value={money(totalSales,currentCurrency)} hint={`${todaySales.length} cierres`} accent/><StatCard label="Propinas" value={money(totalTips,currentCurrency)} hint="Separadas de ventas"/><StatCard label="Personas" value={totalPeople || 0} hint="Comensales atendidos"/><StatCard label="Promedio entrega" value={avgDelivery ? duration(Math.round(avgDelivery)) : '—'} hint={`${todayDelivered.length} pedidos entregados`}/></div>
        <div className="home-grid">
<article className="panel highlight-panel">
<div className="panel-heading">
<div>
<span className="eyebrow">Salón ahora</span>
<h4>{tableStatuses.available} libres · {tableStatuses.preparing} preparando · {tableStatuses.ready} listas</h4>
</div>
<button className="link-btn" onClick={()=>setView('tables')}>Abrir mesas →</button>
</div>
<div className="status-strip">{[['available','Disponibles'],['occupied','Ocupadas'],['preparing','Preparando'],['ready','Listas']].map(([key,label])=>
<span key={key}>
<i className={`dot-${key}`}/>{label} <strong>{tableStatuses[key]}</strong>
</span>)}</div>
</article>
<article className="panel alert-panel">
<div className="panel-heading">
<div>
<span className="eyebrow">Alertas</span>
<h4>{delayedOrders.length ? `${delayedOrders.length} pedido${delayedOrders.length>1?'s':''} retrasado${delayedOrders.length>1?'s':''}` : 'Sin retrasos'}</h4>
</div>
<button className="link-btn" onClick={()=>setView('kitchen')}>Ver cocina →</button>
</div>{delayedOrders.slice(0,3).map(({order,timing})=>
<div className="alert-list-row" key={order.id}>
<strong>#{order.number}</strong>
<span>{order.tableName}</span>
<b>+{duration(timing.delayTime)}</b>
</div>)}</article>
</div>
        <div className="module-grid">
<button className="module-card" onClick={()=>setView('menu')}>
<span>Menú</span>
<strong>{products.length} productos</strong>
<small>Productos, categorías, ingredientes y extras</small>
</button>
<button className="module-card" onClick={()=>setView('summary')}>
<span>Caja</span>
<strong>{store.cash.isOpen?'Abierta':'Cerrada'}</strong>
<small>Venta, propina, gastos y apertura/cierre</small>
</button>
<button className="module-card" onClick={()=>setView('analytics')}><span>Análisis</span><strong>{analyticsProductRows[0]?.name || 'Sin datos'}</strong><small>Ventas, cocina e inventario</small></button>
<button className="module-card" onClick={()=>setView('history')}>
<span>Historial</span>
<strong>{deliveredOrders.length + cancelledOrders.length} registros</strong>
<small>Consulta, filtros y cancelados separados</small>
</button>
</div>
      </section>}

      {view==='tables' && <section className="screen tables-screen">
        <div className="section-header">
<div>
<span className="eyebrow">Mesas · centro de operación</span>
<h3>{workMode?'Selecciona una mesa.':'El salón es lo principal.'}</h3>
</div>
<div className="header-tools">
<button className={`secondary-btn ${tableConfigMode?'active-tool':''}`} onClick={()=>setTableConfigMode(value=>!value)}>{tableConfigMode?'✓ Listo':'Configurar salón'}</button>
<button className="secondary-btn" onClick={resetLayout}>Restaurar</button>
</div>
</div>
        <div className="table-status-pills">{[['all','Todas',tablesView.length],['available','Libres',tableStatuses.available],['occupied','Ocupadas',tableStatuses.occupied],['preparing','Preparando',tableStatuses.preparing],['ready','Listas',tableStatuses.ready]].map(([key,label,count])=><button key={key} className="status-pill" onClick={()=>setTableFilter(key)}><span>{label}</span><strong>{count}</strong></button>)}</div>
        <div className="tables-workspace">
          <div className="salon-board" onClick={event=>{if(event.target===event.currentTarget&&!tableConfigMode)setSelectedTableId(null)}} onPointerMove={handleTablePointerMove} onPointerUp={handleTablePointerUp} onPointerCancel={handleTablePointerUp}>
            <div className="salon-label salon-label-1">Entrada</div><div className="salon-label salon-label-2">Barra / caja</div><div className="salon-label salon-label-3">Cocina</div>
            {tablesView.map(table => (tableFilter==='all' || tableFilter===table.status) && <TableShape key={table.id} table={table} status={table.status} selected={selectedTableId===table.id} dragging={draggingTableId===table.id} onClick={()=>setSelectedTableId(table.id)} onPointerDown={event=>handleTablePointerDown(event,table.id)} />)}
          </div>
          {tableConfigMode && <aside className="salon-config-panel">
<div className="panel-heading"><div><span className="eyebrow">Configurar salón</span><h4>{selectedTable ? selectedTable.name : 'Selecciona una mesa'}</h4></div><button className="primary-btn" onClick={addSalonTable}>+ Mesa</button></div>
{selectedTable ? <div className="config-editor-stack">
<label>Nombre<input value={selectedTable.name} onChange={event=>patchStore(previous=>({...previous,tables:previous.tables.map(table=>table.id===selectedTable.id?{...table,name:event.target.value}:table)}))}/></label>
<div className="shape-picker">{[['round','Redonda'],['wide','Recta'],['square','Cuadrada'],['oval','Ovalada'],['large','Grande']].map(([shape,label])=><button key={shape} className={selectedTable.shape===shape?'selected':''} onClick={()=>patchStore(previous=>({...previous,tables:previous.tables.map(table=>table.id===selectedTable.id?{...table,shape}:table)}))}>{label}</button>)}</div>
<label>Puestos<input type="number" min="1" max="12" value={selectedTable.seats} onChange={event=>patchStore(previous=>({...previous,tables:previous.tables.map(table=>table.id===selectedTable.id?{...table,seats:Math.max(1,Number(event.target.value)||1)}:table)}))}/></label>
<div className="config-editor-actions"><button className="secondary-btn" onClick={()=>setSelectedTableId(null)}>Quitar selección</button><button className="ghost-btn" onClick={resetLayout}>Restaurar salón</button></div>
<small>Arrastra cualquier mesa. No se crean copias: solo cambia su posición.</small>
</div> : <div className="empty-panel"><strong>Selecciona una mesa</strong><span>Muévela, cambia su forma o sus puestos desde aquí.</span></div>}
</aside>}
          {selectedTable && !tableConfigMode && <aside className="table-quick-panel">
<div className="quick-table-head">
<div>
<span className={`table-status-badge ${selectedTable.status}`}>{selectedTable.status==='available'?'Disponible':selectedTable.status==='occupied'?'Ocupada':selectedTable.status==='preparing'?'Preparando':'Pedido listo'}</span>
<h3>{selectedTable.name}</h3>
<small>{selectedTable.seats} puestos</small>
</div>
<button className="icon-btn" onClick={()=>setSelectedTableId(null)}>×</button>
</div>
<div className="quick-total">
<span>Cuenta actual</span>
<strong>{money(selectedTable.total,currentCurrency)}</strong>
</div>{selectedTable.orders.length ? <div className="quick-order-list">{selectedTable.orders.map(order=>
<button key={order.id} onClick={()=>setDetailOrder(order)}>
<span>
<strong>Pedido #{order.number}</strong>
<small>{order.items.length} productos · {statusLabel(order.status)}</small>
</span>
<b>{money(order.total,currentCurrency)}</b>
</button>)}</div> : <div className="empty-panel">
<strong>Mesa disponible</strong>
<span>Aún no hay comandas abiertas.</span>
</div>}<div className="quick-actions-stack">
<button className="primary-btn full-width" onClick={()=>openOrderComposer(selectedTable)}>{selectedTable.orders.length?'Agregar pedido':'Abrir mesa'}</button>{selectedTable.orders.length>0 && <button className="secondary-btn full-width" onClick={()=>openCheckout(selectedTable)}>Cerrar mesa · cobrar</button>}{selectedTable.joinedWith?.length ? <button className="ghost-btn" onClick={()=>splitTable(selectedTable.id)}>Separar mesas</button> : <><button className="ghost-btn" onClick={()=>setQrTable(selectedTable)}>QR mesa</button><button className="ghost-btn" onClick={()=>setJoinSource(selectedTable.id)}>Unir mesa</button></>}</div>{joinSource===selectedTable.id && <div className="join-picker">
<span>Selecciona la otra mesa</span>{tablesView.filter(table=>table.id!==selectedTable.id).map(table=>
<button key={table.id} onClick={()=>joinTable(table.id)}>{table.name}</button>)}</div>}</aside>}
        </div>
      </section>}

      {view==='kitchen' && <section className="screen kitchen-screen">
        <div className="section-header"><div><span className="eyebrow">Cocina · cola viva</span><h3>Estados y tiempos de un vistazo.</h3></div><div className="header-tools"><span className="live-indicator"><i/> En vivo</span><button className="secondary-btn" onClick={unlockAudio}>{audioReady?'Sonido listo':'Activar sonidos'}</button></div></div>
        {delayedOrders.length>0 && <div className="delayed-banner"><div><span className="eyebrow">Atención</span><h4>{delayedOrders.length} pedidos superaron su tiempo por plato</h4><p>La alerta se calcula con el tiempo configurado en cada producto del pedido.</p></div><button className="primary-btn" onClick={()=>playConfiguredSound('delayed')}>Probar alerta</button></div>}
        <div className="kitchen-grid">
<div className="kitchen-queue">
<div className="panel-heading">
<div>
<span className="eyebrow">Cola de producción</span>
<h4>{kitchenQueue.length} pedidos activos</h4>
</div>
</div>{kitchenQueue.length ? kitchenQueue.map(({order,timing})=>
<article className={`kitchen-card ${timing.alertLevel} kitchen-${kitchenStatusClass(order.status)} ${timing.alertLevel==='delayed'?'kitchen-delayed':''}`} key={order.id}>
<div className="kitchen-card-head">
<div>
<span className="order-number">#{order.number}</span>
<h4>{order.tableName}</h4>
</div>
<span className={`kitchen-status-label ${kitchenStatusClass(order.status)} ${timing.alertLevel==='delayed'?'delayed':''}`}>{timing.alertLevel==='delayed'?'Retrasado':statusLabel(order.status)}</span>
</div>
<div className="kitchen-timer">
<strong>{duration(timing.elapsedTime)}</strong>
<span>/ {duration(timing.estimatedPrepTime)}</span>{timing.delayTime>0 && <b>+{duration(timing.delayTime)}</b>}</div>
<OrderItems order={order} currency={currentCurrency} compact/>
<div className="kitchen-actions">{order.status===STATUS.PENDING && <button className="secondary-btn" onClick={()=>updateOrderStatus(order.id,STATUS.PREPARING)}>Empezar</button>}{order.status===STATUS.PREPARING && <button className="primary-btn" onClick={()=>updateOrderStatus(order.id,STATUS.READY)}>Marcar listo</button>}<button className="ghost-btn" onClick={()=>setDetailOrder(order)}>Ver</button>
</div>
</article>) : <div className="empty-state">
<strong>Cocina despejada</strong>
<span>No hay pedidos pendientes.</span>
</div>}</div>
<div className="ready-column">
<div className="panel-heading">
<div>
<span className="eyebrow">Listos</span>
<h4>Entregar</h4>
</div>
<strong>{readyOrders.length}</strong>
</div>{readyOrders.map(order=>
<article className="ready-card" key={order.id}>
<div>
<span className="order-number">#{order.number}</span>
<h4>{order.tableName}</h4>
</div>
<OrderItems order={order} currency={currentCurrency} compact/>
<button className="primary-btn full-width" onClick={()=>updateOrderStatus(order.id,STATUS.DELIVERED)}>Entregar pedido</button>
</article>)}{!readyOrders.length && <div className="empty-state">
<strong>Nada listo</strong>
<span>Los pedidos aparecerán aquí.</span>
</div>}</div>
</div>
      </section>}

      {view==='orders' && <section className="screen orders-screen">
<div className="section-header">
<div>
<span className="eyebrow">Pedidos activos</span>
<h3>Seguimiento sin mezclarlo con el historial.</h3>
</div>
<label className="search-control">⌕<input value={orderSearch} onChange={event=>setOrderSearch(event.target.value)} placeholder="Buscar pedido, mesa o plato…"/>
</label>
</div>
<div className="orders-grid">{activeOrdersFiltered.map(order=>
<article className="order-card" key={order.id}>
<div className="order-card-head">
<div>
<span className="eyebrow">Pedido #{order.number}</span>
<h4>{order.tableName}</h4>
<small>{dateLabel(order.createdAt)} · {employees.find(employee=>employee.id===order.employeeId)?.name || 'Sin asignar'}</small>
</div>
<span className={orderStatusClass(order.status)}>{statusLabel(order.status)}</span>
</div>
<OrderItems order={order} currency={currentCurrency}/>
<div className="order-card-footer">
<strong>{money(order.total,currentCurrency)}</strong>
<div className="inline-actions">{order.status===STATUS.PENDING && <button className="secondary-btn" onClick={()=>updateOrderStatus(order.id,STATUS.PREPARING)}>Preparar</button>}{order.status===STATUS.PREPARING && <button className="primary-btn" onClick={()=>updateOrderStatus(order.id,STATUS.READY)}>Listo</button>}{order.status===STATUS.READY && <button className="primary-btn" onClick={()=>updateOrderStatus(order.id,STATUS.DELIVERED)}>Entregar</button>}<button className="ghost-btn" onClick={()=>editOrder(order)}>Editar</button>{order.orderType!=='mesa' && <button className="secondary-btn" onClick={()=>openExternalCheckout(order)}>Cobrar</button>}
<button className="danger-link" onClick={()=>requestCancel(order)}>Cancelar</button>
</div>
</div>
</article>)}{!activeOrdersFiltered.length && <div className="empty-state wide">
<strong>No hay pedidos activos</strong>
<span>Las nuevas comandas aparecerán aquí.</span>
</div>}</div>
</section>}

      {view==='history' && <section className="screen history-screen">
<div className="section-header">
<div>
<span className="eyebrow">Historial · consulta</span>
<h3>Compacto, filtrable y con cancelaciones separadas.</h3>
</div>
<label className="search-control">⌕<input value={historySearch} onChange={event=>setHistorySearch(event.target.value)} placeholder="Buscar pedido, mesa o producto…"/>
</label>
</div>
<div className="history-toolbar">
<div className="tab-strip">{[['all','Todos'],['delivered','Entregados'],['cancelled','Cancelados']].map(([key,label])=>
<button key={key} className={historyTab===key?'selected':''} onClick={()=>setHistoryTab(key)}>{label}</button>)}</div>
<select value={historyEmployee} onChange={event=>setHistoryEmployee(event.target.value)}>
<option value="all">Todos los empleados</option>{employees.map(employee=>
<option key={employee.id} value={employee.id}>{employee.name}</option>)}</select>
<select value={historyTable} onChange={event=>setHistoryTable(event.target.value)}>
<option value="all">Todas las mesas</option>{tables.map(table=>
<option key={table.id} value={table.id}>{table.name}</option>)}</select>
</div>
<div className="history-list">{historyOrders.map(order=>
<button className="history-row" key={order.id} onClick={()=>setDetailOrder(order)}>
<span className="history-number">#{order.number}</span>
<span className="history-main">
<strong>{order.tableName}</strong>
<small>{dateLabel(order.closedAt || order.updatedAt || order.createdAt)} · {employees.find(employee=>employee.id===order.employeeId)?.name || 'Sin asignar'}</small>
</span>
<span className="history-status">
<b className={orderStatusClass(order.status)}>{statusLabel(order.status)}</b>{order.status===STATUS.CANCELLED&&<small>{order.cancelReason}</small>}</span>
<strong>{money(order.paidTotal ?? order.total,currentCurrency)}</strong>
<span className="history-arrow">→</span>
</button>)}{!historyOrders.length&&<div className="empty-state">
<strong>No hay registros</strong>
<span>Prueba otro filtro.</span>
</div>}</div>
</section>}

      {view==='summary' && <section className="screen summary-screen">
<div className="section-header">
<div>
<span className="eyebrow">Resumen · administración</span>
<h3>Una vista económica con módulos pequeños arriba.</h3>
</div>
<div className="summary-period">Hoy · {new Date().toLocaleDateString('es-CO')}</div>
</div>
<div className="summary-tabs">{[['ventas','Ventas'],['propinas','Propinas'],['pedidos','Pedidos'],['caja','Caja'],['gastos','Gastos']].map(([key,label])=>
<button key={key} className={summaryTab===key?'active':''} onClick={()=>setSummaryTab(key)}>{label}</button>)}</div>
        {summaryTab==='ventas' && <div className="summary-body">
<div className="metrics-grid four">
<StatCard label="Ventas totales" value={money(totalSales,currentCurrency)} hint={`${todaySales.length} cierres`} accent/>
<StatCard label="Promedio por pedido" value={money(todaySales.length?totalSales/todaySales.length:0,currentCurrency)} hint="Ticket promedio"/>
<StatCard label="Promedio de entrega" value={avgDelivery?duration(Math.round(avgDelivery)):'—'} hint="Desde cocina hasta cierre"/>
<StatCard label="Total de personas" value={totalPeople || 0} hint="Comensales atendidos"/>
</div>
<div className="summary-panels">
<article className="panel">
<div className="panel-heading">
<div>
<span className="eyebrow">Métodos de pago</span>
<h4>Cómo entró el dinero</h4>
</div>
</div>{Object.entries(paymentTotals).length ? Object.entries(paymentTotals).map(([method,total])=>
<div className="bar-row" key={method}>
<span>{method}</span>
<strong>{money(total,currentCurrency)}</strong>
<div className="bar">
<i style={{width:`${Math.min(100,totalSales ? total/totalSales*100 : 0)}%`}}/>
</div>
</div>) : <div className="empty-inline">Todavía no hay ventas cerradas.</div>}</article>
<article className="panel">
<div className="panel-heading">
<div>
<span className="eyebrow">Indicadores</span>
<h4>Ventas netas</h4>
</div>
</div>
<div className="big-number">{money(totalSales,currentCurrency)}</div>
<div className="summary-mini-grid">
<span>
<small>Propinas</small>
<strong>{money(totalTips,currentCurrency)}</strong>
</span>
<span>
<small>Descuentos</small>
<strong>{money(totalDiscounts,currentCurrency)}</strong>
</span>
<span>
<small>Cancelados</small>
<strong>{cancelledOrders.filter(order=>(order.cancelledAt||0)>=todayStart.getTime()).length}</strong>
</span>
</div>
</article>
</div>
</div>}
        {summaryTab==='propinas' && <div className="summary-body">
<div className="metrics-grid four">
<StatCard label="Propinas del día" value={money(totalTips,currentCurrency)} accent/>
<StatCard label="Promedio propina" value={money(todaySales.length?totalTips/todaySales.length:0,currentCurrency)} hint="Por venta"/>
<StatCard label="Ventas con propina" value={todaySales.filter(sale=>sale.tip>0).length} hint={`de ${todaySales.length} ventas`}/>
<StatCard label="Propina por persona" value={money(totalPeople?totalTips/totalPeople:0,currentCurrency)} hint="Promedio"/>
</div>
<div className="summary-table">
<div className="summary-table-head">
<span>Venta</span>
<span>Método</span>
<span>Propina</span>
<span>Empleado</span>
</div>{todaySales.map(sale=>
<div className="summary-table-row" key={sale.id}>
<span>#{sale.orderIds?.[0] ? orders.find(order=>order.id===sale.orderIds[0])?.number || sale.id.slice(-4) : sale.id.slice(-4)}</span>
<span>{sale.paymentMethod}</span>
<strong>{money(sale.tip,currentCurrency)}</strong>
<span>{employees.find(employee=>employee.id===sale.employeeId)?.name || '—'}</span>
</div>)}</div>
</div>}
        {summaryTab==='pedidos' && <div className="summary-body">
<div className="summary-filter-row">
<label className="search-control">⌕<input value={summarySearch} onChange={event=>setSummarySearch(event.target.value)} placeholder="Buscar pedido, mesa o producto…"/>
</label>
<span className="muted-copy">Solo consulta: aquí no se cancela ni se elimina.</span>
</div>
<div className="summary-order-list">{summaryOrders.map(order=>
<button className="summary-order-row" key={order.id} onClick={()=>setDetailOrder(order)}>
<div>
<strong>#{order.number} · {order.tableName}</strong>
<small>{dateLabel(order.closedAt || order.updatedAt || order.createdAt)} · {statusLabel(order.status)}</small>
</div>
<span>{money(order.paidTotal ?? order.total,currentCurrency)}</span>
<span>Ver →</span>
</button>)}</div>
</div>}
        {summaryTab==='caja' && <div className="summary-body">
<div className="metrics-grid four">
<StatCard label="Estado" value={store.cash.isOpen?'Abierta':'Cerrada'} hint={store.cash.isOpen?`Esperado ${money(cashExpected,currentCurrency)}`:'Sin turno abierto'} accent/>
<StatCard label="Dinero inicial" value={money(store.cash.openingAmount,currentCurrency)}/>
<StatCard label="Ventas en efectivo" value={money(sessionCashSalesTotal,currentCurrency)}/>
<StatCard label="Diferencia del último cierre" value={money(store.cash.lastDifference || 0,currentCurrency)}/>
</div>
<div className="cash-actions-grid">
<article className="panel">
<div className="panel-heading">
<div>
<span className="eyebrow">Abrir caja</span>
<h4>Nuevo turno</h4>
</div>
</div>{store.cash.isOpen ? <div className="cash-open-note">Caja abierta desde {dateLabel(store.cash.openedAt)} por {employees.find(employee=>employee.id===store.cash.openedBy)?.name || '—'}.</div> : <div className="cash-form">
<label>Dinero inicial<input type="number" min="0" value={cashAmount} onChange={event=>setCashAmount(event.target.value)} placeholder="0"/>
</label>
<button className="primary-btn" onClick={openCash}>Abrir caja</button>
</div>}</article>
<article className="panel">
<div className="panel-heading">
<div>
<span className="eyebrow">Cerrar caja</span>
<h4>Arqueo</h4>
</div>
</div>{store.cash.isOpen ? <div className="cash-form">
<div className="cash-summary-line">
<span>Esperado</span>
<strong>{money(cashExpected,currentCurrency)}</strong>
</div>
<label>Dinero contado<input type="number" min="0" value={cashCounted} onChange={event=>setCashCounted(event.target.value)} placeholder="0"/>
</label>
<button className="secondary-btn" onClick={closeCash}>Cerrar caja</button>
</div> : <div className="cash-open-note">Abre la caja para realizar el arqueo.</div>}</article>
</div>
<div className="summary-table">
<div className="summary-table-head">
<span>Movimiento</span>
<span>Motivo</span>
<span>Monto</span>
<span>Empleado</span>
</div>{cashMovements.slice(0,20).map(item=>
<div className="summary-table-row" key={item.id}>
<span>{item.type==='expense'?'Gasto':'Ingreso'}</span>
<span>{item.reason}</span>
<strong className={item.type==='expense'?'danger-text':''}>{item.type==='expense'?'-':''}{money(item.amount,currentCurrency)}</strong>
<span>{employees.find(employee=>employee.id===item.employeeId)?.name || '—'}</span>
</div>)}</div>
</div>}
        {summaryTab==='gastos' && <div className="summary-body">
<div className="metrics-grid four">
<StatCard label="Gastos de hoy" value={money(cashExpenses,currentCurrency)} accent/>
<StatCard label="Ingresos extra" value={money(cashIncome,currentCurrency)}/>
<StatCard label="Movimientos" value={cashMovements.length}/>
<StatCard label="Balance de caja" value={money(cashExpected,currentCurrency)} hint="Antes del arqueo"/>
</div>
<div className="summary-panels">
<article className="panel">
<div className="panel-heading">
<div>
<span className="eyebrow">Registrar</span>
<h4>Gasto o ingreso</h4>
</div>
</div>
<div className="button-grid">
<button className="primary-btn" onClick={()=>setExpenseEditor({type:'expense',amount:'',reason:'',method:'Efectivo'})}>+ Registrar gasto</button>
<button className="secondary-btn" onClick={()=>setExpenseEditor({type:'income',amount:'',reason:'',method:'Efectivo'})}>+ Registrar ingreso</button>
</div>
</article>
<article className="panel">
<div className="panel-heading">
<div>
<span className="eyebrow">Últimos gastos</span>
<h4>Control rápido</h4>
</div>
</div>{cashMovements.filter(item=>item.type==='expense').slice(0,6).map(item=>
<div className="expense-row" key={item.id}>
<span>{item.reason}<small>{dateLabel(item.createdAt)}</small>
</span>
<strong>{money(item.amount,currentCurrency)}</strong>
</div>)}</article>
</div>
</div>}
      </section>}

      {view==='menu' && <section className="screen menu-screen">
<div className="section-header">
<div>
<span className="eyebrow">Menú · administración</span>
<h3>Organiza el catálogo por entidades, no por texto repetido.</h3>
</div>
<button className="primary-btn" onClick={()=>setProductEditor({ id:null, name:'', description:'', price:'', categoryId:categories[0]?.id || '', isActive:true, estimatedPrepTime:900, ingredientIds:[], ingredientUsage:{}, ingredientUsageUnit:{}, extraIds:[], image:'' })}>+ Nuevo producto</button>
</div>
<div className="menu-switcher">{[['productos','Productos'],['categorias','Categorías'],['ingredientes','Ingredientes'],['extras','Extras']].map(([key,label])=>
<button key={key} className={menuSection===key?'active':''} onClick={()=>setMenuSection(key)}>{label}</button>)}</div>
        {menuSection==='productos' && <div className="menu-body">
<div className="menu-toolbar">
<label className="search-control">⌕<input value={menuSearch} onChange={event=>setMenuSearch(event.target.value)} placeholder="Buscar producto…"/>
</label>
<div className="chip-row">{[['all','Todos'],...categories.filter(category=>category.active!==false).map(category=>[category.id,category.name])].map(([key,label])=>
<button key={key} className={menuCategory===key?'selected':''} onClick={()=>setMenuCategory(key)}>{label}</button>)}</div>
</div>
<div className="product-admin-grid">{products.filter(product=>(menuCategory==='all'||product.categoryId===menuCategory)&&`${product.name} ${product.description}`.toLowerCase().includes(menuSearch.toLowerCase())).map(product=>
<article className={`admin-product-card ${!product.isActive?'paused':''}`} key={product.id}>
<div className="admin-product-art">
<span>{product.name.slice(0,1)}</span>
<button className="icon-btn" onClick={()=>setProductEditor(product)}>✎</button>
</div>
<div className="admin-product-body">
<span className="eyebrow">{getCategoryName(categories,product.categoryId)}</span>
<h4>{product.name}</h4>
<p>{product.description || 'Sin descripción'}</p>
<div className="product-admin-meta">
<strong>{money(product.price,currentCurrency)}</strong>
<span>{Math.round(product.estimatedPrepTime/60)} min</span>
</div>
<div className="tag-row">
<span>{product.ingredients.length} ingredientes</span>
<span>{product.extras.length} extras</span>
</div>
<div className="product-admin-actions">
<button onClick={()=>setProductEditor(product)}>Editar</button>
<button onClick={()=>duplicateProduct(product)}>Duplicar</button>
<button onClick={()=>toggleProductActive(product)}>{product.isActive?'Pausar':'Activar'}</button>
</div>
</div>
</article>)}</div>
</div>}
        {menuSection==='categorias' && <div className="entity-layout">
<article className="panel entity-form-panel">
<div className="panel-heading">
<div>
<span className="eyebrow">Categorías del menú</span>
<h4>Una vez, y se reutilizan en todos los productos.</h4>
</div>
</div>
<button className="primary-btn" onClick={()=>setCategoryEditor({id:null,name:'',active:true})}>+ Nueva categoría</button>
</article>
<div className="entity-card-grid">{categories.map(category=>
<article className="entity-card" key={category.id}>
<div>
<span className="entity-icon">C</span>
<h4>{category.name}</h4>
<small>{products.filter(product=>product.categoryId===category.id).length} productos</small>
</div>
<div className="entity-actions">
<button onClick={()=>setCategoryEditor(category)}>Editar</button>
<button onClick={()=>deleteCategory(category.id)}>Eliminar</button>
</div>
</article>)}</div>
</div>}
        {menuSection==='ingredientes' && <div className="entity-layout">
<div className="entity-layout-head">
<div>
<span className="eyebrow">Biblioteca de ingredientes</span>
<h4>Clasificados y listos para descontar por cantidad usada.</h4>
</div>
<button className="primary-btn" onClick={()=>setIngredientEditor({id:null,name:'',category:ingredientCategories[0] || '',unit:'g',costPerUnit:0,stock:0,minStock:0,active:true})}>+ Ingrediente</button>
</div>
<div className="chip-row entity-category-filter">{[['all','Todos'],...ingredientCategories.map(category=>[category,category])].map(([key,label])=>
<button key={key} className={ingredientCategory===key?'selected':''} onClick={()=>setIngredientCategory(key)}>{label}</button>)}<button className="ghost-btn" onClick={()=>setEntityCategoryEditor({type:'ingredient',value:''})}>+ Categoría</button>
</div>
<div className="entity-card-grid">{Object.entries(ingredients.filter(item=>ingredientCategory==='all'||item.category===ingredientCategory).reduce((groups,item)=>{(groups[item.category||'Sin categoría'] ||= []).push(item);return groups},{})).map(([group,items])=>
<div className="entity-group" key={group}>
<div className="group-label">{group}</div>{items.map(ingredient=>
<article className="entity-card" key={ingredient.id}>
<div>
<span className="entity-icon">I</span>
<h4>{ingredient.name}</h4>
<small>{ingredient.unit} · costo {money(ingredient.costPerUnit,currentCurrency)} · stock {ingredient.stock}{Number(ingredient.stock) <= Number(ingredient.minStock) ? ' · stock bajo' : ''}</small>
</div>
<div className="entity-actions">
<button onClick={()=>setIngredientEditor(ingredient)}>Editar</button>
</div>
</article>)}</div>)}</div>
</div>}
        {menuSection==='extras' && <div className="entity-layout">
<div className="entity-layout-head">
<div>
<span className="eyebrow">Biblioteca de extras</span>
<h4>Categorías reutilizables para personalizar productos.</h4>
</div>
<button className="primary-btn" onClick={()=>setExtraEditor({id:null,name:'',category:extraCategories[0] || '',price:0,active:true,ingredientIds:[],ingredientUsage:{},ingredientUsageUnit:{}})}>+ Extra</button>
</div>
<div className="chip-row entity-category-filter">{[['all','Todos'],...extraCategories.map(category=>[category,category])].map(([key,label])=>
<button key={key} className={extraCategory===key?'selected':''} onClick={()=>setExtraCategory(key)}>{label}</button>)}<button className="ghost-btn" onClick={()=>setEntityCategoryEditor({type:'extra',value:''})}>+ Categoría</button>
</div>
<div className="entity-card-grid">{Object.entries(extras.filter(item=>extraCategory==='all'||item.category===extraCategory).reduce((groups,item)=>{(groups[item.category||'Sin categoría'] ||= []).push(item);return groups},{})).map(([group,items])=>
<div className="entity-group" key={group}>
<div className="group-label">{group}</div>{items.map(extra=>
<article className="entity-card" key={extra.id}>
<div>
<span className="entity-icon">E</span>
<h4>{extra.name}</h4>
<small>{money(extra.price,currentCurrency)}</small>
</div>
<div className="entity-actions">
<button onClick={()=>setExtraEditor(extra)}>Editar</button>
</div>
</article>)}</div>)}</div>
</div>}
      </section>}


      {view==='analytics' && <section className="screen analytics-screen">
<div className="section-header"><div><span className="eyebrow">Análisis · V8</span><h3>Datos, patrones y señales útiles.</h3></div><div className="header-tools"><div className="tab-strip">{[['7d','7 días'],['30d','30 días'],['all','Todo']].map(([key,label])=><button key={key} className={analyticsRange===key?'selected':''} onClick={()=>setAnalyticsRange(key)}>{label}</button>)}</div><button className="secondary-btn" onClick={downloadAnalyticsCsv}>Exportar</button></div></div>
<div className="metrics-grid four"><StatCard label="Ventas" value={money(analyticsSales.reduce((sum,sale)=>sum+Number(sale.netTotal ?? sale.total ?? 0),0),currentCurrency)} accent/><StatCard label="Pedidos" value={analyticsSales.length}/><StatCard label="Retrasos" value={`${Math.round(analyticsDelayRate)}%`}/><StatCard label="Valor de stock" value={money(analyticsStockValue,currentCurrency)} hint={`${analyticsLowStock.length} bajos`}/></div>
<div className="analytics-grid"><article className="panel"><div className="panel-heading"><div><span className="eyebrow">Productos</span><h4>Más movimiento</h4></div></div><div className="analytics-product-list">{analyticsProductRows.slice(0,8).map((row,index)=><div className="analytics-product-row" key={row.productId || row.name}><span><b>{index+1}</b>{row.name}</span><strong>{row.quantity} · {money(row.revenue,currentCurrency)}</strong></div>)}{!analyticsProductRows.length&&<div className="empty-state"><strong>Sin datos todavía</strong></div>}</div></article>
<article className="panel"><div className="panel-heading"><div><span className="eyebrow">Señales</span><h4>Qué revisar</h4></div></div><div className="analytics-insights">{analyticsInsights.map(item=><div className="insight-card" key={item.title}><strong>{item.title}</strong><span>{item.text}</span></div>)}{analyticsNextDemand != null&&<div className="insight-card accent"><strong>Demanda estimada</strong><span>≈ {analyticsNextDemand} cierres en un día similar.</span></div>}</div></article></div>
<article className="panel analytics-demand"><div className="panel-heading"><div><span className="eyebrow">Cocina e inventario</span><h4>Lectura rápida</h4></div></div><div className="analytics-mini-grid"><div><span>Pedidos analizados</span><strong>{analyticsOrders.length}</strong></div><div><span>Pedidos retrasados</span><strong>{analyticsDelayed}</strong></div><div><span>Insumos bajos</span><strong>{analyticsLowStock.length}</strong></div><div><span>Productos con ventas</span><strong>{analyticsProductRows.length}</strong></div></div></article>
</section>}

      {view==='customers' && <section className="screen customers-screen">
<div className="section-header"><div><span className="eyebrow">Clientes · relación</span><h3>Datos simples y útiles, sin obligar a registrar a todo el mundo.</h3></div><div className="header-tools"><label className="search-control">⌕<input value={customerSearch} onChange={event=>setCustomerSearch(event.target.value)} placeholder="Buscar cliente…"/></label><button className="primary-btn" onClick={()=>setCustomerEditor({id:null,name:'',phone:'',email:'',notes:''})}>+ Cliente</button></div></div>
<div className="entity-card-grid">{customers.filter(customer=>!customerSearch||`${customer.name} ${customer.phone||''} ${customer.email||''}`.toLowerCase().includes(customerSearch.toLowerCase())).map(customer=>{const customerOrders=orders.filter(order=>order.customerId===customer.id); const customerSales=store.sales.filter(sale=>sale.customerId===customer.id); const spent=customerSales.reduce((sum,sale)=>sum+Number(sale.netTotal ?? sale.total ?? 0),0); return <article className="entity-card" key={customer.id}><div><span className="entity-icon">C</span><h4>{customer.name}</h4><small>{customer.phone || 'Sin teléfono'}{customer.email?` · ${customer.email}`:''}</small><small>{customerOrders.length} pedidos · {money(spent,currentCurrency)}</small></div><div className="entity-actions"><button onClick={()=>setCustomerEditor(customer)}>Editar</button></div></article>})}{!customers.length&&<div className="empty-state wide"><strong>Aún no hay clientes</strong><span>Los clientes son opcionales en cada pedido.</span></div>}</div>
</section>}

      {view==='reservations' && <section className="screen reservations-screen">
<div className="section-header"><div><span className="eyebrow">Reservas · agenda</span><h3>Reserva una mesa y conviértela en operación cuando llegue el cliente.</h3></div><div className="header-tools"><div className="tab-strip"><button className={reservationFilter==='today'?'selected':''} onClick={()=>setReservationFilter('today')}>Hoy</button><button className={reservationFilter==='all'?'selected':''} onClick={()=>setReservationFilter('all')}>Todas</button></div><button className="primary-btn" onClick={()=>setReservationEditor({id:null,customerId:customers[0]?.id||'',date:new Date().toISOString().slice(0,10),time:'19:00',people:2,tableId:'',status:'pendiente',notes:''})}>+ Reserva</button></div></div>
<div className="reservation-list">{reservations.filter(reservation=>reservationFilter==='all'||reservation.date===new Date().toISOString().slice(0,10)).sort((a,b)=>`${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)).map(reservation=><article className="reservation-card" key={reservation.id}><div><span className="eyebrow">{reservation.date} · {reservation.time}</span><h4>{reservation.customerName}</h4><small>{reservation.people} personas{reservation.tableId?` · ${tables.find(table=>String(table.id)===String(reservation.tableId))?.name||'Mesa pendiente'}`:' · Mesa pendiente'}</small><p>{reservation.notes || 'Sin notas'}</p></div><div className="entity-actions"><span className="mini-status active">{reservation.status}</span><button onClick={()=>openReservationOperation(reservation)}>Abrir</button><button onClick={()=>setReservationEditor(reservation)}>Editar</button></div></article>)}{!reservations.length&&<div className="empty-state wide"><strong>No hay reservas</strong><span>Crea la primera para la agenda.</span></div>}</div>
</section>}

      {view==='inventory' && <section className="screen inventory-screen">
        <div className="section-header">
<div>
<span className="eyebrow">Inventario · control real</span>
<h3>Stock, unidades y movimientos.</h3>
</div>
<div className="header-tools">
<button className="primary-btn" onClick={()=>setInventoryMoveEditor({type:'purchase',ingredientId:ingredients[0]?.id||'',quantity:'',reason:''})}>+ Añadir stock</button>
<button className="secondary-btn" onClick={openNewIngredient}>+ Añadir ingrediente</button>
<button className="secondary-btn" onClick={()=>setInventoryMoveEditor({type:'adjust',ingredientId:ingredients[0]?.id||'',quantity:'',reason:''})}>Ajustar</button>
</div>
</div>
        <div className="inventory-toolbar">
<label className="search-control">⌕<input value={inventorySearch} onChange={event=>setInventorySearch(event.target.value)} placeholder="Buscar ingrediente…"/>
</label>
<div className="tab-strip">
<button className={inventoryFilter==='all'?'selected':''} onClick={()=>setInventoryFilter('all')}>Todos</button>
<button className={inventoryFilter==='low'?'selected':''} onClick={()=>setInventoryFilter('low')}>Stock bajo ({ingredients.filter(item=>Number(item.stock||0)<=Number(item.minStock||0)).length})</button>
</div>
</div>
        <div className="inventory-grid">{ingredients.filter(item=>{const q=inventorySearch.toLowerCase().trim(); const matches=!q||`${item.name} ${item.category}`.toLowerCase().includes(q); const low=Number(item.stock||0)<=Number(item.minStock||0); return matches&&(inventoryFilter==='all'||low)}).map(ingredient=>{const low=Number(ingredient.stock||0)<=Number(ingredient.minStock||0); return <article className={`inventory-card ${low?'low-stock':''}`} key={ingredient.id}>
<div className="inventory-card-head">
<div>
<span className="eyebrow">{ingredient.category}</span>
<h4>{ingredient.name}</h4>
</div>
<span className={`mini-status ${low?'inactive':'active'}`}>{low?'Stock bajo':'Disponible'}</span>
</div>
<div className="stock-main">
<strong>{Number(ingredient.stock||0).toLocaleString('es-CO')}</strong>
<span>{ingredient.unit}</span>
</div>
<div className="stock-meta">
<span>Mínimo {Number(ingredient.minStock||0).toLocaleString('es-CO')} {ingredient.unit}</span>
<span>{money(Number(ingredient.costPerUnit||0),currentCurrency)} / {ingredient.unit}</span>
</div>
<div className="inventory-bar">
<i style={{width:`${Math.min(100,Math.max(4,(Number(ingredient.stock||0)/Math.max(1,Number(ingredient.minStock||1)*3))*100))}%`}}/>
</div>
<div className="inventory-card-actions"><button className="secondary-btn" onClick={()=>setInventoryMoveEditor({type:'purchase',ingredientId:ingredient.id,quantity:'',reason:''})}>+ Añadir</button><button className="ghost-btn" onClick={()=>setInventoryMoveEditor({type:'adjust',ingredientId:ingredient.id,quantity:String(ingredient.stock ?? ''),reason:''})}>Ajustar</button></div>
</article>})}{!ingredients.length&&<div className="empty-state wide">
<strong>No hay ingredientes</strong>
<span>Usa “Añadir ingrediente” para crear uno nuevo.</span>
</div>}</div>
        <article className="panel inventory-history">
<div className="panel-heading">
<div><span className="eyebrow">Movimientos</span><h4>Actividad del stock</h4></div>
</div>
<div className="inventory-history-toolbar">
<label className="search-control">⌕<input value={inventoryMovementSearch} onChange={event=>setInventoryMovementSearch(event.target.value)} placeholder="Buscar ingrediente o motivo…"/></label>
<div className="tab-strip">{[['today','Hoy'],['yesterday','Ayer'],['7d','7 días'],['all','Todo']].map(([key,label])=><button key={key} className={inventoryMovementDateFilter===key?'selected':''} onClick={()=>setInventoryMovementDateFilter(key)}>{label}</button>)}</div>
</div>
<div className="inventory-movement-list">{visibleInventoryMovements.slice(0,30).map(move=>
<div className="inventory-movement-row" key={move.id}>
<span className={`movement-sign ${Number(move.quantity)>=0?'in':'out'}`}>{Number(move.quantity)>=0?'+':'−'}</span>
<div><strong>{move.ingredientName || ingredients.find(item=>item.id===move.ingredientId)?.name || 'Ingrediente'}</strong><small>{move.reason || (move.type==='sale'?'Venta':'Movimiento')} · {dateLabel(move.createdAt)}</small></div>
<strong>{Math.abs(Number(move.quantity||0)).toLocaleString('es-CO')} {move.unit||''}</strong>
</div>)}{!visibleInventoryMovements.length&&<div className="empty-state"><strong>Sin movimientos</strong><span>Prueba otro día o término.</span></div>}</div>
</article>
      </section>}

      {view==='config' && <section className="screen config-screen">
<div className="section-header">
<div>
<span className="eyebrow">Configuración · V8</span>
<h3>Base local, sonido, usuarios, conexión y respaldo.</h3>
</div>
<button className="secondary-btn" onClick={requestBackup}>Descargar respaldo SQLite</button>
</div>
<div className="config-grid">
<article className="panel">
<div className="panel-heading">
<div>
<span className="eyebrow">Restaurante</span>
<h4>Datos generales</h4>
</div>
</div>
<label>Nombre<input value={store.config.restaurantName} onChange={event=>patchStore(previous=>({...previous,config:{...previous.config,restaurantName:event.target.value}}))}/>
</label>
<div className="two-columns">
<label>Moneda<select value={store.config.currency} onChange={event=>patchStore(previous=>({...previous,config:{...previous.config,currency:event.target.value}}))}>
<option value="COP">COP</option>
<option value="USD">USD</option>
</select>
</label>
<label>Mesas<input type="number" min="1" max="40" value={store.config.tableCount || tables.length} onChange={event=>changeTableCount(event.target.value)}/>
</label>
</div>
</article>
<article className="panel">
<div className="panel-heading">
<div>
<span className="eyebrow">Cocina y alertas</span>
<h4>Tiempos globales</h4>
</div>
</div>
<div className="two-columns">
<label>Tiempo predeterminado<input type="number" min="1" value={Math.round(store.config.kitchen.defaultEstimatedPrepTime/60)} onChange={event=>patchStore(previous=>({...previous,config:{...previous.config,kitchen:{...previous.config.kitchen,defaultEstimatedPrepTime:Math.max(1,Number(event.target.value)||1)*60}}}))}/>
</label>
<label>Repetir alerta<input type="number" min="1" value={Math.round(store.config.kitchen.alertRepeatInterval/60)} onChange={event=>patchStore(previous=>({...previous,config:{...previous.config,kitchen:{...previous.config.kitchen,alertRepeatInterval:Math.max(1,Number(event.target.value)||1)*60}}}))}/>
</label>
</div>
<label className="inline-check">
<input type="checkbox" checked={Boolean(store.config.kitchen.soundEnabled)} onChange={event=>patchStore(previous=>({...previous,config:{...previous.config,kitchen:{...previous.config.kitchen,soundEnabled:event.target.checked}}}))}/> Alertas sonoras automáticas</label>
<label className="range-row">Volumen<input type="range" min="0" max="1" step="0.05" value={store.config.kitchen.volume} onChange={event=>patchStore(previous=>({...previous,config:{...previous.config,kitchen:{...previous.config.kitchen,volume:Number(event.target.value)}}}))}/>
<strong>{Math.round(store.config.kitchen.volume*100)}%</strong>
</label>
<div className="button-grid">
<button className="secondary-btn" onClick={unlockAudio}>{audioReady?'Sonido desbloqueado':'Activar sonido'}</button>
<button className="secondary-btn" onClick={()=>setSoundEditor(true)}>Personalizar sonidos</button>
</div>
</article>
<article className="panel">
<div className="panel-heading">
<div>
<span className="eyebrow">Empleados y roles</span>
<h4>Quién opera el sistema</h4>
</div>
<button className="icon-btn" onClick={()=>canManageCatalog ? setEmployeeEditor({id:null,name:'',role:'Mesero',active:true,pin:''}) : setToast('Solo Administrador puede gestionar empleados.')}>+</button>
</div>{employees.map(employee=>
<div className="employee-row" key={employee.id}>
<span>
<strong>{employee.name}</strong>
<small>{employee.role}</small>
</span>
<div className="inline-actions">
<button className="ghost-btn" onClick={()=>setEmployeeEditor(employee)}>Editar</button>
<span className={`mini-status ${employee.active?'active':'inactive'}`}>{employee.active?'Activo':'Inactivo'}</span>
</div>
</div>)}</article>

<article className="panel"><div className="panel-heading"><div><span className="eyebrow">Acceso remoto</span><h4>URL pública preparada</h4></div></div><label>URL base pública<input value={store.config.publicBaseUrl || ''} onChange={event=>patchStore(previous=>({...previous,config:{...previous.config,publicBaseUrl:event.target.value.trim()}}))} placeholder="https://restaurante.tudominio.com"/></label><div className="architecture-note"><div><strong>Uso</strong><span>La aplicación queda lista para publicarse mediante un túnel seguro; la autenticación del personal sigue usando PIN y roles.</span></div><div><strong>QR</strong><span>El QR de cada mesa utiliza esta URL para apuntar al menú digital futuro.</span></div></div></article>

<article className="panel">
<div className="panel-heading">
<div>
<span className="eyebrow">Arquitectura</span>
<h4>Listo para la siguiente capa</h4>
</div>
</div>
<div className="architecture-note">
<div>
<strong>Base local</strong>
<span>{serverOnline ? 'SQLite activa y sincronizada entre ventanas.' : 'Sin servidor: la interfaz sigue disponible con respaldo local.'}</span>
</div>
<div>
<strong>Menú digital</strong>
<span>Estructura separada de productos/ingredientes/extras para agregarlo después sin rehacer el catálogo.</span>
</div>
<div>
<strong>Inventario</strong>
<span>Cada producto guarda cantidad y unidad de uso; el stock se descuenta con conversión automática.</span>
</div>
</div>
</article>
</div>
</section>}
    </main>

    {orderScreen && <div className="fullscreen-layer" role="dialog" aria-modal="true">
<div className="order-workspace">
<header className="workspace-header">
<div>
<span className="eyebrow">Tomar pedido</span>
<h2>{selectedTable?.name || orderScreen.tableName}</h2>
<small>Empleado: {activeEmployee?.name} · {ORDER_TYPES[orderScreen.orderType] || 'Mesa'}</small>
<div className="order-customer-line"><label>Cliente<select value={orderScreen.customerId || ''} onChange={event=>setOrderScreen(previous=>({...previous,customerId:event.target.value || null}))}><option value="">Cliente ocasional</option>{customers.map(customer=><option key={customer.id} value={customer.id}>{customer.name}{customer.phone?` · ${customer.phone}`:''}</option>)}</select></label>{orderScreen.orderType==='delivery' && <label>Dirección<input value={orderScreen.deliveryAddress || ''} onChange={event=>setOrderScreen(previous=>({...previous,deliveryAddress:event.target.value}))} placeholder="Dirección de entrega"/></label>}<button className="ghost-btn compact" onClick={()=>setCustomerEditor({id:null,name:'',phone:'',email:'',notes:''})}>+ Cliente</button></div>
</div>
<div className="workspace-actions">
<strong>{money(orderTotal(cart), currentCurrency)}</strong>
<button className="secondary-btn" onClick={()=>{setOrderScreen(null);setCart([])}}>Salir</button>
<button className="primary-btn" disabled={!cart.length} onClick={saveOrder}>Enviar a cocina</button>
</div>
</header>
<div className="workspace-body">
<div className="catalog-panel">
<div className="catalog-header">
<label className="search-control">⌕<input value={menuSearch} onChange={event=>setMenuSearch(event.target.value)} placeholder="Buscar producto…"/>
</label>
<div className="chip-row">{[['all','Todos'],...categories.filter(category=>category.active!==false).map(category=>[category.id,category.name])].map(([key,label])=>
<button key={key} className={categoryTab===key?'selected':''} onClick={()=>setCategoryTab(key)}>{label}</button>)}</div>
</div>
<div className="pos-product-grid">{products.filter(product=>product.isActive&&(categoryTab==='all'||categoryTab===product.categoryId)&&`${product.name} ${product.description}`.toLowerCase().includes(menuSearch.toLowerCase())).map(product=>
<ProductCard key={product.id} product={product} categories={categories} currency={currentCurrency} onAdd={addProductToCart}/>)}</div>
</div>
<aside className="cart-workspace">
<div className="panel-heading">
<div>
<span className="eyebrow">Comanda</span>
<h3>{cart.length ? `${cart.reduce((sum,item)=>sum+item.quantity,0)} unidades` : 'Vacía'}</h3>
</div>
</div>{cart.length ? <div className="cart-workspace-list">{cart.map(item=>
<div className="cart-workspace-row" key={item.id}>
<div>
<strong>{item.productName}</strong>
<small>{item.extras?.length ? `+ ${item.extras.map(extra=>extra.name).join(', ')}` : 'Sin extras'}</small>
</div>
<div className="quantity-controls">
<button onClick={()=>setCart(items=>items.flatMap(entry=>entry.id===item.id && entry.quantity===1 ? [] : entry.id===item.id ? [{...entry,quantity:entry.quantity-1}] : [entry]))}>−</button>
<span>{item.quantity}</span>
<button onClick={()=>setCart(items=>items.map(entry=>entry.id===item.id?{...entry,quantity:entry.quantity+1}:entry))}>+</button>
</div>
<strong>{money(itemSubtotal(item),currentCurrency)}</strong>
</div>)}</div> : <div className="empty-state">
<strong>Añade productos</strong>
<span>Elige un plato, personalízalo y aparecerá aquí.</span>
</div>}<div className="cart-total">
<span>Total</span>
<strong>{money(orderTotal(cart),currentCurrency)}</strong>
</div>
</aside>
</div>
</div>
</div>}

    {checkoutScreen && checkoutEntity && <div className="fullscreen-layer" role="dialog" aria-modal="true">
<div className="checkout-workspace">
<header className="workspace-header">
<div>
<span className="eyebrow">Cobro</span>
<h2>{checkoutEntity.name}</h2>
<small>{checkoutEntity.orders.length} pedidos{checkoutEntity.seats ? ` · ${checkoutEntity.seats} puestos` : ''}</small>
</div>
<button className="secondary-btn" onClick={()=>setCheckoutScreen(null)}>Salir</button>
</header>
<div className="checkout-grid">
<section className="checkout-summary">
<div className="summary-amount">
<span>Subtotal</span>
<strong>{money(checkoutEntity.total,currentCurrency)}</strong>
</div>
<div className="checkout-lines">
<div>
<span>Descuento</span>
<input type="number" min="0" value={checkoutScreen.discount} onChange={event=>setCheckoutScreen(previous=>({...previous,discount:event.target.value}))}/>
</div>
<div>
<span>Propina</span>
<input type="number" min="0" value={checkoutScreen.tip} onChange={event=>setCheckoutScreen(previous=>({...previous,tip:event.target.value}))}/>
<div className="tip-presets">{[0,10,15,20].map(percent=>
<button key={percent} type="button" className="tip-chip" onClick={()=>setCheckoutScreen(previous=>({...previous,tip:Math.round(getCheckoutTotals(previous).netTotal*percent/100)}))}>{percent===0?'Sin propina':`${percent}%`}</button>)}</div>
</div>
<div>
<span>Personas</span>
<input type="number" min="1" value={checkoutScreen.people} onChange={event=>setCheckoutScreen(previous=>({...previous,people:Math.max(1,Number(event.target.value)||1)}))}/>
</div>
</div>
<div className="checkout-total">
<span>Total a cobrar</span>
<strong>{money(getCheckoutTotals(checkoutScreen).total,currentCurrency)}</strong>
</div>
</section>
<section className="payment-panel">
<div className="panel-heading">
<div>
<span className="eyebrow">Método de pago</span>
<h3>Elige o combina pagos</h3>
</div>
</div>
<div className="payment-method-grid">{[['Efectivo','Efectivo'],['Tarjeta','Tarjeta'],['Transferencia','Transferencia'],['Mixto','Dividir pago']].map(([method,label])=>
<button key={method} className={checkoutScreen.method===method?'selected':''} onClick={()=>setCheckoutScreen(previous=>({...previous,method}))}>
<strong>{label}</strong>{method==='Mixto' && <small>2 métodos</small>}</button>)}</div>{checkoutScreen.method==='Efectivo' && <div className="cash-payment-box">
<label>Dinero recibido<input type="number" min="0" value={checkoutScreen.paidCash} onChange={event=>setCheckoutScreen(previous=>({...previous,paidCash:event.target.value}))}/>
</label>
<div className="payment-helper">
<span>Cambio</span>
<strong>{money(Math.max(0,(Number(checkoutScreen.paidCash)||0)-getCheckoutTotals(checkoutScreen).total),currentCurrency)}</strong>
</div>
</div>}{checkoutScreen.method==='Mixto' && (()=>{
          const total=getCheckoutTotals(checkoutScreen).total
          const mode=checkoutScreen.mixedSplitMode || 'methods'
          const first=Number(checkoutScreen.mixedFirstAmount)||0
          const second=Number(checkoutScreen.mixedSecondAmount)||0
          const peopleParts=checkoutScreen.mixedPeopleParts || []
          const combined=mode==='people' ? sumSplitParts(peopleParts) : first+second
          const remaining=total-combined
          const cashPortion=mode==='people' ? Number(buildPaymentBreakdownFromParts(peopleParts).Efectivo || 0) : (checkoutScreen.mixedFirstMethod==='Efectivo'?first:0)+(checkoutScreen.mixedSecondMethod==='Efectivo'?second:0)
          const received=Number(checkoutScreen.paidCash)||0
          const peopleCount=clampSplitPeople(checkoutScreen.people)
          return <div className="mixed-payment-box">
            <div className="mixed-payment-intro"><strong>¿Cómo quieres dividir el pago?</strong><span>Puedes repartirlo entre 2 métodos o dividirlo entre el número de personas.</span></div>
            <div className="mixed-split-mode">
              <button type="button" className={mode==='methods'?'selected':''} onClick={()=>setCheckoutScreen(previous=>({...previous,mixedSplitMode:'methods'}))}>Por métodos</button>
              <button type="button" className={mode==='people'?'selected':''} onClick={()=>setCheckoutScreen(previous=>({...previous,mixedSplitMode:'people',people:Math.max(2,Number(previous.people)||2),mixedPeopleParts:resizeSplitPeople(Math.max(2,Number(previous.people)||2),previous.mixedPeopleParts)}))}>Por personas</button>
            </div>
            {mode==='methods' ? <div className="mixed-payment-grid">
<div className="mixed-payment-part">
<span>Parte 1</span>
<select value={checkoutScreen.mixedFirstMethod} onChange={event=>setCheckoutScreen(previous=>({...previous,mixedFirstMethod:event.target.value}))}>
<option>Efectivo</option>
<option>Tarjeta</option>
<option>Transferencia</option>
</select>
<label>Monto<input type="number" min="0" value={checkoutScreen.mixedFirstAmount} onChange={event=>setCheckoutScreen(previous=>({...previous,mixedFirstAmount:event.target.value}))}/>
</label>
</div>
<div className="mixed-payment-part">
<span>Parte 2</span>
<select value={checkoutScreen.mixedSecondMethod} onChange={event=>setCheckoutScreen(previous=>({...previous,mixedSecondMethod:event.target.value}))}>
<option>Tarjeta</option>
<option>Transferencia</option>
<option>Efectivo</option>
</select>
<label>Monto<input type="number" min="0" value={checkoutScreen.mixedSecondAmount} onChange={event=>setCheckoutScreen(previous=>({...previous,mixedSecondAmount:event.target.value}))}/>
</label>
<button type="button" className="ghost-btn compact" onClick={()=>setCheckoutScreen(previous=>({...previous,mixedSecondAmount:String(Math.max(0,getCheckoutTotals(previous).total-(Number(previous.mixedFirstAmount)||0)))}))}>Completar restante</button>
</div>
</div> : <div className="mixed-people-box">
              <div className="mixed-people-controls">
<label>Dividir entre<input type="number" min="2" max="20" value={peopleCount} onChange={event=>setCheckoutScreen(previous=>{const next=clampSplitPeople(event.target.value); return {...previous,people:next,mixedPeopleParts:resizeSplitPeople(next,previous.mixedPeopleParts)}})}/>
<span>personas</span>
</label>
<button type="button" className="ghost-btn compact" onClick={()=>setCheckoutScreen(previous=>({...previous,mixedPeopleParts:distributeSplitTotal(getCheckoutTotals(previous).total, clampSplitPeople(previous.people))}))}>Repartir por igual</button>
</div>
              <div className="mixed-people-each"><span>Valor por persona si se divide por igual</span><strong>{money(total/peopleCount,currentCurrency)}</strong></div>
              <div className="mixed-people-list">{peopleParts.slice(0,peopleCount).map((part,index)=>
<div className="mixed-payment-part" key={part.id || index}>
<span>Persona {index+1}</span>
<select value={part.method || 'Tarjeta'} onChange={event=>setCheckoutScreen(previous=>({...previous,mixedPeopleParts:previous.mixedPeopleParts.map((item,itemIndex)=>itemIndex===index?{...item,method:event.target.value}:item)}))}>
<option>Efectivo</option>
<option>Tarjeta</option>
<option>Transferencia</option>
</select>
<label>Monto<input type="number" min="0" value={part.amount} onChange={event=>setCheckoutScreen(previous=>({...previous,mixedPeopleParts:previous.mixedPeopleParts.map((item,itemIndex)=>itemIndex===index?{...item,amount:event.target.value}:item)}))}/>
</label>
</div>)}</div>
            </div>}
            <div className={`mixed-payment-status ${Math.abs(remaining)<=0.5?'complete':''}`}>
<div>
<small>Total</small>
<strong>{money(total,currentCurrency)}</strong>
</div>
<div>
<small>Pagado</small>
<strong>{money(combined,currentCurrency)}</strong>
</div>
<div>
<small>{remaining>0.5?'Falta':remaining< -0.5?'Excede':'Listo'}</small>
<strong>{money(Math.abs(remaining),currentCurrency)}</strong>
</div>
</div>{cashPortion>0 && <div className="cash-payment-box mixed-cash-box">
<label>Efectivo recibido<input type="number" min="0" value={checkoutScreen.paidCash} onChange={event=>setCheckoutScreen(previous=>({...previous,paidCash:event.target.value}))}/>
</label>
<div className="payment-helper">
<span>Cambio del efectivo</span>
<strong>{money(Math.max(0,received-cashPortion),currentCurrency)}</strong>
</div>
</div>}
          </div>
        })()}<button className="primary-btn full-width" onClick={closeTable}>Confirmar cobro · {money(getCheckoutTotals(checkoutScreen).total,currentCurrency)}</button>
</section>
</div>
<div className="checkout-orders">
<div className="panel-heading">
<div>
<span className="eyebrow">Detalle</span>
<h4>Pedidos incluidos</h4>
</div>
</div>{checkoutEntity.orders.map(order=>
<div className="checkout-order" key={order.id}>
<span>#{order.number}</span>
<OrderItems order={order} currency={currentCurrency} compact/>
<strong>{money(order.total,currentCurrency)}</strong>
</div>)}</div>
</div>
</div>}

    {receiptPreview && <div className="modal-backdrop">
<div className="entity-editor large receipt-preview">
<div className="modal-header">
<div>
<span className="eyebrow">Cobro completado</span>
<h3>Comprobante generado</h3>
<p className="muted-copy">La mesa quedó libre y el inventario ya fue actualizado.</p>
</div>
<button className="icon-btn" onClick={()=>setReceiptPreview(null)}>×</button>
</div>
<div className="receipt-paper">
<strong>{receiptPreview.restaurantName}</strong>
<span>{receiptPreview.tableName} · {dateLabel(receiptPreview.createdAt)}</span>{receiptPreview.items.map((item,index)=>
<div className="receipt-line" key={`${item.productName}-${index}`}>
<span>{item.quantity} × {item.productName}</span>
<strong>{money(item.subtotal,currentCurrency)}</strong>
</div>)}<div className="receipt-divider"/>
<div className="receipt-line">
<span>Subtotal</span>
<strong>{money(receiptPreview.subtotal,currentCurrency)}</strong>
</div>
<div className="receipt-line">
<span>Descuento</span>
<strong>{money(receiptPreview.discount,currentCurrency)}</strong>
</div>
<div className="receipt-line">
<span>Propina</span>
<strong>{money(receiptPreview.tip,currentCurrency)}</strong>
</div>
<div className="receipt-line">
<span>Método</span>
<strong>{receiptPreview.paymentMethod}</strong>
</div>{receiptPreview.paymentBreakdown && Object.entries(receiptPreview.paymentBreakdown).map(([method,amount])=>
<div className="receipt-line" key={method}>
<span>↳ {method}</span>
<strong>{money(amount,currentCurrency)}</strong>
</div>)}{receiptPreview.cashChange>0 && <div className="receipt-line">
<span>Cambio</span>
<strong>{money(receiptPreview.cashChange,currentCurrency)}</strong>
</div>}<div className="receipt-line receipt-total">
<span>Total</span>
<strong>{money(receiptPreview.total,currentCurrency)}</strong>
</div>
</div>
<div className="modal-footer">
<button className="secondary-btn" onClick={()=>printReceipt(receiptPreview)}>Imprimir</button>
<button className="primary-btn" onClick={()=>downloadReceiptPdf(receiptPreview)}>Descargar PDF</button>
<button className="ghost-btn" onClick={()=>setReceiptPreview(null)}>Cerrar</button>
</div>
</div>
</div>}

    {customizing && <div className="modal-backdrop">
<div className="customize-modal">
<div className="modal-header">
<div>
<span className="eyebrow">Personalizar</span>
<h3>{customizing.product.name}</h3>
</div>
<button className="icon-btn" onClick={()=>setCustomizing(null)}>×</button>
</div>{customizing.product.extras?.length>0 && <fieldset>
<legend>Extras</legend>{customizing.product.extras.map(extra=>
<label className="check-row" key={extra.id}>
<span>
<input type="checkbox" checked={(customizing.extrasSelected||[]).some(item=>item.id===extra.id)} onChange={()=>setCustomizing(previous=>({...previous,extrasSelected:(previous.extrasSelected||[]).some(item=>item.id===extra.id)?previous.extrasSelected.filter(item=>item.id!==extra.id):[...(previous.extrasSelected||[]),extra]}))}/>{extra.name}</span>
<strong>+{money(extra.price,currentCurrency)}</strong>
</label>)}</fieldset>}{customizing.product.ingredients?.length>0 && <fieldset>
<legend>Quitar ingredientes</legend>{customizing.product.ingredients.map(id=>{const ingredient=ingredients.find(item=>item.id===id);return <label className="check-row" key={id}>
<span>
<input type="checkbox" checked={(customizing.removedIngredients||[]).includes(id)} onChange={()=>setCustomizing(previous=>({...previous,removedIngredients:(previous.removedIngredients||[]).includes(id)?previous.removedIngredients.filter(item=>item!==id):[...(previous.removedIngredients||[]),id]}))}/>Sin {ingredient?.name || id}</span>
</label>})}</fieldset>}<label>Cantidad<input type="number" min="1" max="20" value={customizing.quantity} onChange={event=>setCustomizing(previous=>({...previous,quantity:Math.max(1,Number(event.target.value)||1)}))}/>
</label>
<label>Nota<input value={customizing.note} onChange={event=>setCustomizing(previous=>({...previous,note:event.target.value}))} placeholder="Sin cebolla, salsa aparte…"/>
</label>
<button className="primary-btn full-width" onClick={finishCustomizing}>Agregar a la comanda</button>
</div>
</div>}

    {detailOrder && <div className="modal-backdrop">
<div className="detail-modal">
<div className="modal-header">
<div>
<span className="eyebrow">Pedido #{detailOrder.number}</span>
<h3>{detailOrder.tableName}</h3>
</div>
<button className="icon-btn" onClick={()=>setDetailOrder(null)}>×</button>
</div>
<span className={orderStatusClass(detailOrder.status)}>{statusLabel(detailOrder.status)}</span>
<p className="muted-copy">{dateLabel(detailOrder.createdAt)} · {employees.find(employee=>employee.id===detailOrder.employeeId)?.name || 'Sin asignar'}</p>
<OrderItems order={detailOrder} currency={currentCurrency}/>
<div className="detail-total">
<span>Total</span>
<strong>{money(detailOrder.paidTotal ?? detailOrder.total,currentCurrency)}</strong>
</div>{detailOrder.status===STATUS.CANCELLED && <div className="cancel-box">
<strong>Motivo de cancelación</strong>
<span>{detailOrder.cancelReason || 'Sin motivo especificado'}</span>
</div>}<div className="modal-footer">
<div className="inline-actions">{detailOrder.status===STATUS.READY&&<button className="primary-btn" onClick={()=>{updateOrderStatus(detailOrder.id,STATUS.DELIVERED);setDetailOrder(null)}}>Entregar</button>}{![STATUS.DELIVERED,STATUS.CANCELLED].includes(detailOrder.status)&&<button className="secondary-btn" onClick={()=>{requestCancel(detailOrder);setDetailOrder(null)}}>Cancelar</button>}</div>
</div>
</div>
</div>}

    {cancelTarget && <div className="modal-backdrop">
<div className="customize-modal">
<div className="modal-header">
<div>
<span className="eyebrow">Cancelar pedido #{cancelTarget.number}</span>
<h3>{cancelTarget.tableName}</h3>
</div>
<button className="icon-btn" onClick={()=>setCancelTarget(null)}>×</button>
</div>
<p className="muted-copy">El pedido no se borra: pasa a Cancelados con trazabilidad.</p>
<label>Motivo<textarea value={cancelReason} onChange={event=>setCancelReason(event.target.value)} placeholder="Ej. Cliente cambió el pedido…"/>
</label>
<div className="modal-footer">
<button className="secondary-btn" onClick={()=>setCancelTarget(null)}>Volver</button>
<button className="danger-btn" onClick={confirmCancel}>Confirmar cancelación</button>
</div>
</div>
</div>}

    {productEditor && <div className="modal-backdrop">
<div className="entity-editor large">
<div className="modal-header">
<div>
<span className="eyebrow">Editor de producto</span>
<h3>{productEditor.id?'Editar producto':'Nuevo producto'}</h3>
</div>
<button className="icon-btn" onClick={()=>setProductEditor(null)}>×</button>
</div>
<div className="editor-form">
<div className="two-columns">
<label>Nombre<input value={productEditor.name} onChange={event=>setProductEditor({...productEditor,name:event.target.value})}/>
</label>
<label>Precio<input type="number" min="0" value={productEditor.price} onChange={event=>setProductEditor({...productEditor,price:event.target.value})}/>
</label>
</div>
<label>Descripción<textarea value={productEditor.description} onChange={event=>setProductEditor({...productEditor,description:event.target.value})}/>
</label>
<div className="two-columns">
<label>Categoría<select value={productEditor.categoryId} onChange={event=>setProductEditor({...productEditor,categoryId:event.target.value})}>{categories.filter(category=>category.active!==false).map(category=>
<option key={category.id} value={category.id}>{category.name}</option>)}</select>
</label>
<label>Tiempo de preparación (min)<input type="number" min="1" value={Math.round(productEditor.estimatedPrepTime/60)} onChange={event=>setProductEditor({...productEditor,estimatedPrepTime:Math.max(60,Number(event.target.value)||1)*60})}/>
</label>
</div>
<div className="editor-section">
<div className="panel-heading">
<div>
<span className="eyebrow">Ingredientes</span>
<h4>Selecciona los existentes</h4>
<small>La cantidad usada por unidad queda guardada para inventario.</small>
</div>
</div>
<div className="selection-grid">{ingredients.map(ingredient=>
<label key={ingredient.id} className={`selection-card ${(productEditor.ingredientIds||[]).includes(ingredient.id)?'selected':''}`}>
<span>
<input type="checkbox" checked={(productEditor.ingredientIds||[]).includes(ingredient.id)} onChange={event=>{const ids=productEditor.ingredientIds||[];const next=event.target.checked?[...ids,ingredient.id]:ids.filter(id=>id!==ingredient.id);setProductEditor({...productEditor,ingredientIds:next,ingredientUsage:{...productEditor.ingredientUsage,[ingredient.id]:productEditor.ingredientUsage?.[ingredient.id] || (ingredient.unit==='unidad'?1:25)},ingredientUsageUnit:{...productEditor.ingredientUsageUnit,[ingredient.id]:productEditor.ingredientUsageUnit?.[ingredient.id] || defaultUsageUnit(ingredient.unit)}})}}/>{ingredient.name}<small>{ingredient.category} · {ingredient.unit}</small>
</span>{(productEditor.ingredientIds||[]).includes(ingredient.id) && <span className="usage-editor"><input className="usage-input" type="number" min="0" step="0.1" value={productEditor.ingredientUsage?.[ingredient.id] ?? ''} onChange={event=>setProductEditor({...productEditor,ingredientUsage:{...productEditor.ingredientUsage,[ingredient.id]:Number(event.target.value)||0}})}/><select className="usage-unit-select" value={productEditor.ingredientUsageUnit?.[ingredient.id] || defaultUsageUnit(ingredient.unit)} onChange={event=>setProductEditor({...productEditor,ingredientUsageUnit:{...productEditor.ingredientUsageUnit,[ingredient.id]:event.target.value}})}>{compatibleUnits(ingredient.unit).map(unit=><option key={unit} value={unit}>{unit}</option>)}</select></span>}</label>)}</div>
</div>
<div className="editor-section">
<div className="panel-heading">
<div>
<span className="eyebrow">Extras</span>
<h4>Selecciona los existentes</h4>
</div>
</div>
<div className="selection-grid">{extras.map(extra=>
<label key={extra.id} className={`selection-card compact-selection ${(productEditor.extraIds||[]).includes(extra.id)?'selected':''}`}>
<span>
<input type="checkbox" checked={(productEditor.extraIds||[]).includes(extra.id)} onChange={event=>setProductEditor({...productEditor,extraIds:event.target.checked?[...(productEditor.extraIds||[]),extra.id]:(productEditor.extraIds||[]).filter(id=>id!==extra.id)})}/>{extra.name}<small>{extra.category}</small>
</span>
<strong>{money(extra.price,currentCurrency)}</strong>
</label>)}</div>
</div>
<label className="inline-check">
<input type="checkbox" checked={productEditor.isActive} onChange={event=>setProductEditor({...productEditor,isActive:event.target.checked})}/> Disponible para venta</label>
</div>
<div className="modal-footer">
<button className="secondary-btn" onClick={()=>setProductEditor(null)}>Cancelar</button>
<button className="primary-btn" onClick={()=>saveProduct(productEditor)}>Guardar producto</button>
</div>
</div>
</div>}

    {categoryEditor && <div className="modal-backdrop">
<div className="entity-editor">
<div className="modal-header">
<div>
<span className="eyebrow">Categoría</span>
<h3>{categoryEditor.id?'Editar':'Nueva'} categoría</h3>
</div>
<button className="icon-btn" onClick={()=>setCategoryEditor(null)}>×</button>
</div>
<label>Nombre<input value={categoryEditor.name} onChange={event=>setCategoryEditor({...categoryEditor,name:event.target.value})}/>
</label>
<div className="modal-footer">
<button className="secondary-btn" onClick={()=>setCategoryEditor(null)}>Cancelar</button>
<button className="primary-btn" onClick={()=>{if(!categoryEditor.name.trim()) return; saveEntity('categories',{...categoryEditor,name:categoryEditor.name.trim()},setCategoryEditor)}}>Guardar</button>
</div>
</div>
</div>}

    {ingredientEditor && <div className="modal-backdrop">
<div className="entity-editor">
<div className="modal-header">
<div>
<span className="eyebrow">Ingrediente</span>
<h3>{ingredientEditor.id?'Editar':'Nuevo'} ingrediente</h3>
</div>
<button className="icon-btn" onClick={()=>setIngredientEditor(null)}>×</button>
</div>
<div className="two-columns">
<label>Nombre<input value={ingredientEditor.name} onChange={event=>setIngredientEditor({...ingredientEditor,name:event.target.value})}/>
</label>
<label>Categoría<select value={ingredientEditor.category} onChange={event=>setIngredientEditor({...ingredientEditor,category:event.target.value})}>{ingredientCategories.map(category=>
<option key={category} value={category}>{category}</option>)}</select>
</label>
</div>
<div className="two-columns">
<label>Unidad<select value={ingredientEditor.unit} onChange={event=>setIngredientEditor({...ingredientEditor,unit:event.target.value})}>
<option value="g">g</option>
<option value="kg">kg</option>
<option value="ml">ml</option>
<option value="L">L</option>
<option value="unidad">unidad</option>
</select>
</label>
<label>Costo por unidad<input type="number" min="0" step="0.01" value={ingredientEditor.costPerUnit} onChange={event=>setIngredientEditor({...ingredientEditor,costPerUnit:Number(event.target.value)||0})}/>
</label>
</div>
<div className="two-columns">
<label>{ingredientEditor.id?'Stock actual':'Stock inicial'}<input type="number" min="0" value={ingredientEditor.stock} disabled={Boolean(ingredientEditor.id)} onChange={event=>setIngredientEditor({...ingredientEditor,stock:Number(event.target.value)||0})}/>{ingredientEditor.id&&<small>Usa Inventario para ajustar el stock y conservar trazabilidad.</small>}</label>
<label>Stock mínimo<input type="number" min="0" value={ingredientEditor.minStock} onChange={event=>setIngredientEditor({...ingredientEditor,minStock:Number(event.target.value)||0})}/>
</label>
</div>
<div className="modal-footer">
<button className="secondary-btn" onClick={()=>setIngredientEditor(null)}>Cancelar</button>
<button className="primary-btn" onClick={()=>saveIngredient({...ingredientEditor,name:ingredientEditor.name.trim()})}>Guardar</button>
</div>
</div>
</div>}

    {extraEditor && <div className="modal-backdrop">
<div className="entity-editor">
<div className="modal-header">
<div>
<span className="eyebrow">Extra</span>
<h3>{extraEditor.id?'Editar':'Nuevo'} extra</h3>
</div>
<button className="icon-btn" onClick={()=>setExtraEditor(null)}>×</button>
</div>
<div className="two-columns">
<label>Nombre<input value={extraEditor.name} onChange={event=>setExtraEditor({...extraEditor,name:event.target.value})}/>
</label>
<label>Categoría<select value={extraEditor.category} onChange={event=>setExtraEditor({...extraEditor,category:event.target.value})}>{extraCategories.map(category=>
<option key={category} value={category}>{category}</option>)}</select>
</label>
</div>
<label>Precio<input type="number" min="0" value={extraEditor.price} onChange={event=>setExtraEditor({...extraEditor,price:Number(event.target.value)||0})}/>
</label>
<div className="editor-section">
<div className="panel-heading">
<div>
<span className="eyebrow">Consumo</span>
<h4>Ingredientes del extra</h4>
<small>Se descuentan al cobrar.</small>
</div>
</div>
<div className="selection-grid">{ingredients.map(ingredient=>
<label key={ingredient.id} className={`selection-card compact-selection ${(extraEditor.ingredientIds||[]).includes(ingredient.id)?'selected':''}`}>
<span>
<input type="checkbox" checked={(extraEditor.ingredientIds||[]).includes(ingredient.id)} onChange={event=>{const ids=extraEditor.ingredientIds||[];const next=event.target.checked?[...ids,ingredient.id]:ids.filter(id=>id!==ingredient.id);setExtraEditor({...extraEditor,ingredientIds:next,ingredientUsage:{...extraEditor.ingredientUsage,[ingredient.id]:extraEditor.ingredientUsage?.[ingredient.id] || (ingredient.unit==='unidad'?1:25)},ingredientUsageUnit:{...extraEditor.ingredientUsageUnit,[ingredient.id]:extraEditor.ingredientUsageUnit?.[ingredient.id] || defaultUsageUnit(ingredient.unit)}})}}/>{ingredient.name}<small>{ingredient.category} · {ingredient.unit}</small>
</span>{(extraEditor.ingredientIds||[]).includes(ingredient.id)&&<span className="usage-editor"><input className="usage-input" type="number" min="0" step="0.1" value={extraEditor.ingredientUsage?.[ingredient.id] ?? ''} onChange={event=>setExtraEditor({...extraEditor,ingredientUsage:{...extraEditor.ingredientUsage,[ingredient.id]:Number(event.target.value)||0}})}/><select className="usage-unit-select" value={extraEditor.ingredientUsageUnit?.[ingredient.id] || defaultUsageUnit(ingredient.unit)} onChange={event=>setExtraEditor({...extraEditor,ingredientUsageUnit:{...extraEditor.ingredientUsageUnit,[ingredient.id]:event.target.value}})}>{compatibleUnits(ingredient.unit).map(unit=><option key={unit} value={unit}>{unit}</option>)}</select></span>}</label>)}</div>
</div>
<div className="modal-footer">
<button className="secondary-btn" onClick={()=>setExtraEditor(null)}>Cancelar</button>
<button className="primary-btn" onClick={()=>saveEntity('extras',{...extraEditor,name:extraEditor.name.trim(),ingredients:extraEditor.ingredientIds||[],ingredientIds:extraEditor.ingredientIds||[],ingredientUsage:extraEditor.ingredientUsage||{},ingredientUsageUnit:extraEditor.ingredientUsageUnit||{}},setExtraEditor)}>Guardar</button>
</div>
</div>
</div>}

    {employeeEditor && <div className="modal-backdrop">
<div className="entity-editor">
<div className="modal-header">
<div>
<span className="eyebrow">Empleado</span>
<h3>{employeeEditor.id?'Editar':'Nuevo'} empleado</h3>
</div>
<button className="icon-btn" onClick={()=>setEmployeeEditor(null)}>×</button>
</div>
<label>Nombre<input value={employeeEditor.name} onChange={event=>setEmployeeEditor({...employeeEditor,name:event.target.value})}/>
</label>
<label>Rol<select value={employeeEditor.role} onChange={event=>setEmployeeEditor({...employeeEditor,role:event.target.value})}>
<option>Administrador</option>
<option>Mesero</option>
<option>Cocina</option>
<option>Caja</option>
</select>
</label>
<label>PIN de operación<input inputMode="numeric" pattern="[0-9]*" maxLength={6} value={employeeEditor.pin || ''} onChange={event=>setEmployeeEditor({...employeeEditor,pin:event.target.value.replace(/\D/g,'').slice(0,6)})} placeholder="4 a 6 dígitos"/>
</label>
<label className="inline-check">
<input type="checkbox" checked={employeeEditor.active} onChange={event=>setEmployeeEditor({...employeeEditor,active:event.target.checked})}/> Activo</label>
<div className="modal-footer">
<button className="secondary-btn" onClick={()=>setEmployeeEditor(null)}>Cancelar</button>
<button className="primary-btn" onClick={()=>saveEntity('employees',{...employeeEditor,name:employeeEditor.name.trim()},setEmployeeEditor)}>Guardar</button>
</div>
</div>
</div>}

    {expenseEditor && <div className="modal-backdrop">
<div className="entity-editor">
<div className="modal-header">
<div>
<span className="eyebrow">Movimiento de caja</span>
<h3>{expenseEditor.type==='expense'?'Registrar gasto':'Registrar ingreso'}</h3>
</div>
<button className="icon-btn" onClick={()=>setExpenseEditor(null)}>×</button>
</div>
<label>Monto<input type="number" min="0" value={expenseEditor.amount} onChange={event=>setExpenseEditor({...expenseEditor,amount:event.target.value})}/>
</label>
<label>Motivo<textarea value={expenseEditor.reason} onChange={event=>setExpenseEditor({...expenseEditor,reason:event.target.value})} placeholder="Ej. Compra de hielo…"/>
</label>
<div className="modal-footer">
<button className="secondary-btn" onClick={()=>setExpenseEditor(null)}>Cancelar</button>
<button className="primary-btn" onClick={()=>addCashMovement(expenseEditor.type)}>Guardar</button>
</div>
</div>
</div>}

    {entityCategoryEditor && <div className="modal-backdrop">
<div className="entity-editor">
<div className="modal-header">
<div>
<span className="eyebrow">Categoría reutilizable</span>
<h3>Nueva categoría</h3>
</div>
<button className="icon-btn" onClick={()=>setEntityCategoryEditor(null)}>×</button>
</div>
<label>Nombre<input autoFocus value={entityCategoryEditor.value} onChange={event=>setEntityCategoryEditor({...entityCategoryEditor,value:event.target.value})} placeholder={entityCategoryEditor.type==='ingredient'?'Ej. Salsas':'Ej. Toppings'} />
</label>
<div className="modal-footer">
<button className="secondary-btn" onClick={()=>setEntityCategoryEditor(null)}>Cancelar</button>
<button className="primary-btn" onClick={()=>entityCategoryEditor.type==='ingredient'?addEntityCategory('ingredient',entityCategoryEditor.value,value=>setIngredientCategory(value)):addEntityCategory('extra',entityCategoryEditor.value,value=>setExtraCategory(value))}>Crear categoría</button>
</div>
</div>
</div>}

    {inventoryMoveEditor && <div className="modal-backdrop">
<div className="entity-editor">
<div className="modal-header">
<div>
<span className="eyebrow">Inventario</span>
<h3>{inventoryMoveEditor.type==='purchase'?'Registrar entrada':'Ajustar stock'}</h3>
</div>
<button className="icon-btn" onClick={()=>setInventoryMoveEditor(null)}>×</button>
</div>
<label>Ingrediente<select value={inventoryMoveEditor.ingredientId} onChange={event=>setInventoryMoveEditor({...inventoryMoveEditor,ingredientId:event.target.value})}>{ingredients.map(item=>
<option key={item.id} value={item.id}>{item.name}</option>)}</select>
</label>
<label>{inventoryMoveEditor.type==='purchase'?'Cantidad que entra':'Nuevo stock'}<input type="number" min="0" step="0.1" value={inventoryMoveEditor.quantity} onChange={event=>setInventoryMoveEditor({...inventoryMoveEditor,quantity:event.target.value})}/>
</label>
<label>Motivo<input value={inventoryMoveEditor.reason} onChange={event=>setInventoryMoveEditor({...inventoryMoveEditor,reason:event.target.value})} placeholder={inventoryMoveEditor.type==='purchase'?'Ej. Compra a proveedor':'Ej. Conteo físico'}/>
</label>
<div className="modal-footer">
<button className="secondary-btn" onClick={()=>setInventoryMoveEditor(null)}>Cancelar</button>
<button className="primary-btn" onClick={saveInventoryMovement}>Guardar movimiento</button>
</div>
</div>
</div>}


    {customerEditor && <div className="modal-backdrop"><div className="entity-editor"><div className="modal-header"><div><span className="eyebrow">Cliente</span><h3>{customerEditor.id?'Editar':'Nuevo'} cliente</h3></div><button className="icon-btn" onClick={()=>setCustomerEditor(null)}>×</button></div><label>Nombre<input autoFocus value={customerEditor.name} onChange={event=>setCustomerEditor({...customerEditor,name:event.target.value})}/></label><label>Teléfono<input value={customerEditor.phone||''} onChange={event=>setCustomerEditor({...customerEditor,phone:event.target.value})}/></label><label>Correo<input type="email" value={customerEditor.email||''} onChange={event=>setCustomerEditor({...customerEditor,email:event.target.value})}/></label><label>Notas<textarea value={customerEditor.notes||''} onChange={event=>setCustomerEditor({...customerEditor,notes:event.target.value})}/></label><div className="modal-footer"><button className="secondary-btn" onClick={()=>setCustomerEditor(null)}>Cancelar</button><button className="primary-btn" onClick={()=>saveCustomer(customerEditor)}>Guardar cliente</button></div></div></div>}

    {reservationEditor && <div className="modal-backdrop"><div className="entity-editor"><div className="modal-header"><div><span className="eyebrow">Reserva</span><h3>{reservationEditor.id?'Editar':'Nueva'} reserva</h3></div><button className="icon-btn" onClick={()=>setReservationEditor(null)}>×</button></div><label>Cliente<select value={reservationEditor.customerId} onChange={event=>setReservationEditor({...reservationEditor,customerId:event.target.value})}>{customers.map(customer=><option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label><div className="two-columns"><label>Fecha<input type="date" value={reservationEditor.date} onChange={event=>setReservationEditor({...reservationEditor,date:event.target.value})}/></label><label>Hora<input type="time" value={reservationEditor.time} onChange={event=>setReservationEditor({...reservationEditor,time:event.target.value})}/></label></div><div className="two-columns"><label>Personas<input type="number" min="1" max="40" value={reservationEditor.people} onChange={event=>setReservationEditor({...reservationEditor,people:Math.max(1,Number(event.target.value)||1)})}/></label><label>Mesa<select value={reservationEditor.tableId || ''} onChange={event=>setReservationEditor({...reservationEditor,tableId:event.target.value})}><option value="">Pendiente</option>{tables.map(table=><option key={table.id} value={table.id}>{table.name}</option>)}</select></label></div><label>Estado<select value={reservationEditor.status} onChange={event=>setReservationEditor({...reservationEditor,status:event.target.value})}><option value="pendiente">Pendiente</option><option value="confirmada">Confirmada</option><option value="atendida">Atendida</option><option value="cancelada">Cancelada</option></select></label><label>Notas<textarea value={reservationEditor.notes||''} onChange={event=>setReservationEditor({...reservationEditor,notes:event.target.value})}/></label><div className="modal-footer"><button className="secondary-btn" onClick={()=>setReservationEditor(null)}>Cancelar</button><button className="primary-btn" onClick={()=>saveReservation(reservationEditor)}>Guardar reserva</button></div></div></div>}

    {globalSearchOpen && <div className="modal-backdrop"><div className="entity-editor large"><div className="modal-header"><div><span className="eyebrow">Búsqueda global</span><h3>Encuentra cualquier cosa rápido</h3></div><button className="icon-btn" onClick={()=>{setGlobalSearchOpen(false);setGlobalSearch('')}}>×</button></div><label>Buscar<input autoFocus value={globalSearch} onChange={event=>setGlobalSearch(event.target.value)} placeholder="Mesa, pedido, cliente, producto o reserva…"/></label><div className="global-results">{(()=>{const q=globalSearch.toLowerCase().trim(); if(!q) return <div className="empty-inline">Escribe para buscar.</div>; const results=[]; orders.filter(order=>`${order.number} ${order.tableName} ${order.items.map(item=>item.productName).join(' ')} ${order.orderType||''}`.toLowerCase().includes(q)).slice(0,6).forEach(order=>results.push({type:'Pedido',label:`#${order.number} · ${order.tableName}`,meta:statusLabel(order.status),go:()=>{setDetailOrder(order);setGlobalSearchOpen(false)}})); customers.filter(customer=>`${customer.name} ${customer.phone||''} ${customer.email||''}`.toLowerCase().includes(q)).slice(0,6).forEach(customer=>results.push({type:'Cliente',label:customer.name,meta:customer.phone||'Sin teléfono',go:()=>{setView('customers');setGlobalSearchOpen(false)}})); tables.filter(table=>`${table.name} ${table.id}`.toLowerCase().includes(q)).slice(0,6).forEach(table=>results.push({type:'Mesa',label:table.name,meta:tablesView.find(item=>item.id===table.id)?.status||'Disponible',go:()=>{setView('tables');setSelectedTableId(table.id);setGlobalSearchOpen(false)}})); reservations.filter(res=>`${res.customerName} ${res.date} ${res.time}`.toLowerCase().includes(q)).slice(0,6).forEach(res=>results.push({type:'Reserva',label:res.customerName,meta:`${res.date} · ${res.time}`,go:()=>{setView('reservations');setGlobalSearchOpen(false)}})); return results.length ? results.map((result,index)=><button className="global-result-row" key={`${result.type}-${index}`} onClick={result.go}><span className="eyebrow">{result.type}</span><strong>{result.label}</strong><small>{result.meta}</small><b>→</b></button>) : <div className="empty-state"><strong>Sin resultados</strong><span>Prueba con otro término.</span></div>})()}</div></div></div>}

    {qrTable && <div className="modal-backdrop"><div className="entity-editor"><div className="modal-header"><div><span className="eyebrow">QR de mesa</span><h3>{qrTable.name}</h3></div><button className="icon-btn" onClick={()=>setQrTable(null)}>×</button></div>{(()=>{const base=(store.config.publicBaseUrl||window.location.origin).replace(/\/$/,''); const url=`${base}/menu/${qrTable.id}`; const qr=`https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(url)}`; return <div className="qr-panel"><img src={qr} alt={`Código QR de ${qrTable.name}`}/><code>{url}</code><div className="modal-footer"><button className="secondary-btn" onClick={()=>navigator.clipboard?.writeText(url).then(()=>setToast('Enlace QR copiado'))}>Copiar enlace</button><a className="primary-btn" href={qr} target="_blank" rel="noreferrer">Abrir QR</a></div></div>})()}</div></div>}

    {soundEditor && <div className="modal-backdrop">
<div className="entity-editor large">
<div className="modal-header">
<div>
<span className="eyebrow">Sonidos y alertas</span>
<h3>Pequeños, claros y personalizables</h3>
</div>
<button className="icon-btn" onClick={()=>setSoundEditor(false)}>×</button>
</div>
<p className="muted-copy">Los sonidos personalizados se validan a máximo 2 segundos. También puedes usar opciones incluidas.</p>
<div className="sound-list">{[['delayed','Pedido retrasado'],['newOrder','Pedido nuevo'],['ready','Pedido listo'],['cash','Cobro']].map(([key,label])=>
<div className="sound-row" key={key}>
<div>
<strong>{label}</strong>
<small>Opción actual: {store.soundPresets?.[key]?.customDataUrl?'Personalizado':store.soundPresets?.[key]?.type || 'ping'}</small>
</div>
<div className="sound-controls">
<select value={store.soundPresets?.[key]?.type || 'ping'} onChange={event=>setSoundPreset(key,event.target.value)}>
<option value="click">Click</option>
<option value="ping">Ping</option>
<option value="double">Doble</option>
<option value="triple">Triple</option>
</select>
<button className="ghost-btn" onClick={()=>{if(audioReady)playConfiguredSound(key);else unlockAudio(key)}}>Probar</button>
<label className="upload-btn">Subir<input type="file" accept="audio/*" onChange={event=>uploadSound(key,event.target.files?.[0])}/>
</label>
</div>
</div>)}</div>
</div>
</div>}
  </div>
}
