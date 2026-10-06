export const UNIT_GROUPS = {
  weight: ['g', 'kg'],
  volume: ['ml', 'L'],
  count: ['unidad'],
}

export function unitFamily(unit = 'unidad') {
  return Object.entries(UNIT_GROUPS).find(([, units]) => units.includes(unit))?.[0] || 'count'
}

export function compatibleUnits(unit = 'unidad') {
  return UNIT_GROUPS[unitFamily(unit)] || UNIT_GROUPS.count
}

export function defaultUsageUnit(stockUnit = 'unidad') {
  if (stockUnit === 'kg') return 'g'
  if (stockUnit === 'L') return 'ml'
  return stockUnit
}

export function convertQuantity(quantity, fromUnit, toUnit) {
  const value = Number(quantity) || 0
  if (!value || fromUnit === toUnit) return value
  if (unitFamily(fromUnit) !== unitFamily(toUnit)) return null
  const factors = { g: 1, kg: 1000, ml: 1, L: 1000, unidad: 1 }
  const from = factors[fromUnit]
  const to = factors[toUnit]
  if (!from || !to) return null
  return value * from / to
}


export function reconcileInventoryStocks(ingredients = [], inventoryMovements = []) {
  const deltas = new Map()
  for (const movement of inventoryMovements || []) {
    if (!movement?.ingredientId) continue
    const delta = Number(movement.quantity) || 0
    deltas.set(movement.ingredientId, (deltas.get(movement.ingredientId) || 0) + delta)
  }
  return (ingredients || []).map(ingredient => {
    const fallbackCurrent = Number(ingredient.stock) || 0
    const baseStock = Number.isFinite(Number(ingredient.baseStock))
      ? Number(ingredient.baseStock)
      : fallbackCurrent - (deltas.get(ingredient.id) || 0)
    const stock = Math.max(0, baseStock + (deltas.get(ingredient.id) || 0))
    if (Number(ingredient.stock) === stock && Number(ingredient.baseStock) === baseStock) return ingredient
    return { ...ingredient, baseStock, stock }
  })
}

export function getInventoryRequirements(items = [], products = [], ingredients = []) {
  const productMap = new Map(products.map(product => [product.id, product]))
  const requirements = new Map()
  const addUsage = (ingredientId, quantity, usageUnit) => {
    const rawUsage = Number(quantity) || 0
    if (!ingredientId || rawUsage <= 0) return
    const ingredient = ingredients.find(entry => entry.id === ingredientId)
    const stockUnit = ingredient?.unit || usageUnit || 'unidad'
    const converted = convertQuantity(rawUsage, usageUnit || stockUnit, stockUnit)
    if (converted == null) return
    requirements.set(ingredientId, (requirements.get(ingredientId) || 0) + converted)
  }
  for (const item of items) {
    const product = productMap.get(item.productId)
    if (!product) continue
    const removed = new Set(item.removedIngredients || [])
    const quantity = Math.max(1, Number(item.quantity) || 1)
    for (const ingredientId of product.ingredients || []) {
      if (removed.has(ingredientId)) continue
      const usageUnit = product.ingredientUsageUnit?.[ingredientId] || ingredients.find(entry => entry.id === ingredientId)?.unit || 'unidad'
      addUsage(ingredientId, (product.ingredientUsage?.[ingredientId] || 0) * quantity, usageUnit)
    }
    for (const extra of item.extras || []) {
      const extraIngredientIds = extra.ingredientIds || extra.ingredients || []
      for (const ingredientId of extraIngredientIds) {
        const usageUnit = extra.ingredientUsageUnit?.[ingredientId] || ingredients.find(entry => entry.id === ingredientId)?.unit || 'unidad'
        addUsage(ingredientId, (extra.ingredientUsage?.[ingredientId] || 0) * quantity, usageUnit)
      }
    }
  }
  return [...requirements.entries()].map(([ingredientId, quantity]) => {
    const ingredient = ingredients.find(entry => entry.id === ingredientId)
    return { ingredientId, quantity, unit: ingredient?.unit || 'unidad', ingredientName: ingredient?.name || ingredientId }
  })
}

export function validateInventoryForSale(items, products, ingredients) {
  const requirements = getInventoryRequirements(items, products, ingredients)
  const shortages = requirements.map(req => {
    const ingredient = ingredients.find(entry => entry.id === req.ingredientId)
    const available = Number(ingredient?.stock) || 0
    return available < req.quantity ? { ...req, available, missing: req.quantity - available } : null
  }).filter(Boolean)
  return { ok: shortages.length === 0, requirements, shortages }
}

export function deductInventoryForSale(ingredients, requirements, saleId, employeeId, timestamp) {
  const requirementMap = new Map(requirements.map(item => [item.ingredientId, item.quantity]))
  const movements = []
  const nextIngredients = ingredients.map(ingredient => {
    const quantity = requirementMap.get(ingredient.id)
    if (!quantity) return ingredient
    const nextStock = Math.max(0, Number(ingredient.stock || 0) - quantity)
    movements.push({
      id: `inv-${saleId}-${ingredient.id}`,
      type: 'sale',
      ingredientId: ingredient.id,
      quantity: -quantity,
      unit: ingredient.unit,
      stockBefore: Number(ingredient.stock || 0),
      stockAfter: nextStock,
      saleId,
      employeeId,
      createdAt: timestamp,
    })
    return { ...ingredient, stock: nextStock, updatedAt: timestamp }
  })
  return { ingredients: nextIngredients, movements }
}
