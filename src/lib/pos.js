export const STORAGE_VERSION = 6

export const STATUS = {
  PENDING: 'PENDIENTE',
  PREPARING: 'PREPARANDO',
  READY: 'LISTO',
  DELIVERED: 'ENTREGADO',
  CANCELLED: 'CANCELADO',
}

export const isActiveOrder = order => ![STATUS.DELIVERED, STATUS.CANCELLED].includes(order.status)

export const makeId = prefix => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export const itemUnitPrice = item => Number(item.basePrice || 0) + (item.extras || []).reduce((total, extra) => total + Number(extra.price || 0), 0)
export const itemSubtotal = item => itemUnitPrice(item) * Number(item.quantity || 0)
export const orderTotal = items => (items || []).reduce((total, item) => total + itemSubtotal(item), 0)

export const makeOrderItem = (product, options = {}) => ({
  id: makeId('item'), productId:product.id, productName:product.name, basePrice:Number(product.price)||0,
  estimatedPrepTime:Number(product.estimatedPrepTime)||undefined, quantity:Number(options.quantity)||1,
  extras:options.extras||[], removedIngredients:options.removedIngredients||[], note:options.note||'',
})

export const statusLabel = status => ({ PENDIENTE:'Pendiente', PREPARANDO:'Preparando', LISTO:'Listo', ENTREGADO:'Entregado', CANCELADO:'Cancelado' }[status] || status)
