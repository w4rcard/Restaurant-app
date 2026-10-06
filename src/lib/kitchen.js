import { STATUS } from './pos.js'

export const DEFAULT_KITCHEN_SETTINGS = {
  defaultEstimatedPrepTime: 15 * 60,
  warningRemainingPercent: 20,
  alertRepeatInterval: 5 * 60,
  soundEnabled: false,
  volume: 0.45,
  productSpecific: true,
}

export function calculateEstimatedPrepTime(items, products, settings) {
  const fallback = Number(settings?.defaultEstimatedPrepTime) || DEFAULT_KITCHEN_SETTINGS.defaultEstimatedPrepTime
  const max = Math.max(fallback, ...(items || []).map(item => Number(item.estimatedPrepTime) || products.find(product => product.id === item.productId)?.estimatedPrepTime || fallback))
  return max
}

export function getKitchenTiming(order, now, settings) {
  const active = order.status === STATUS.PENDING || order.status === STATUS.PREPARING
  const started = Number(order.sentToKitchenAt || order.createdAt || now)
  const end = Number(order.completedAt || order.updatedAt || now)
  const elapsedTime = Math.max(0, Math.floor(((active ? now : end) - started) / 1000))
  const estimatedPrepTime = Math.max(1, Number(order.estimatedPrepTime) || settings?.defaultEstimatedPrepTime || DEFAULT_KITCHEN_SETTINGS.defaultEstimatedPrepTime)
  const warningStartsAt = estimatedPrepTime * (1 - (Number(settings?.warningRemainingPercent) || 20) / 100)
  const delayTime = active ? Math.max(0, elapsedTime - estimatedPrepTime) : 0
  const alertLevel = !active ? 'complete' : delayTime > 0 ? 'delayed' : elapsedTime >= warningStartsAt ? 'warning' : 'normal'
  return { elapsedTime, estimatedPrepTime, delayTime, alertLevel, active }
}

export function getDueKitchenAlerts(orders, now, settings) {
  const interval = Math.max(10, Number(settings?.alertRepeatInterval) || DEFAULT_KITCHEN_SETTINGS.alertRepeatInterval)
  return (orders || []).filter(order => order.status === STATUS.PENDING || order.status === STATUS.PREPARING).map(order => ({ order, timing:getKitchenTiming(order, now, settings) })).filter(({order,timing}) => {
    if (timing.alertLevel !== 'delayed') return false
    const last = Number(order.lastKitchenAlertAt || 0)
    return !last || now - last >= interval * 1000
  }).sort((a,b) => b.timing.delayTime-a.timing.delayTime)
}

export function migrateKitchenOrder(order, products, settings) {
  return { ...order, sentToKitchenAt:order.sentToKitchenAt||order.createdAt||Date.now(), estimatedPrepTime:order.estimatedPrepTime||calculateEstimatedPrepTime(order.items||[],products,settings) }
}
