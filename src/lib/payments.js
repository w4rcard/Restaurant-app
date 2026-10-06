export const clampSplitPeople = value => Math.min(20, Math.max(2, Math.floor(Number(value) || 2)))

export const resizeSplitPeople = (count, current = []) => {
  const people = clampSplitPeople(count)
  return Array.from({ length: people }, (_, index) => current[index] || {
    id: `person-${index + 1}`,
    label: `Persona ${index + 1}`,
    method: index === 0 ? 'Efectivo' : 'Tarjeta',
    amount: '',
  })
}

export const distributeSplitTotal = (total, count) => {
  const people = clampSplitPeople(count)
  const cents = Math.round(Math.max(0, Number(total) || 0) * 100)
  const base = Math.floor(cents / people)
  const remainder = cents - base * people
  return Array.from({ length: people }, (_, index) => ({
    id: `person-${index + 1}`,
    label: `Persona ${index + 1}`,
    method: index === 0 ? 'Efectivo' : 'Tarjeta',
    amount: ((base + (index < remainder ? 1 : 0)) / 100).toFixed(2).replace(/\.00$/, ''),
  }))
}

export const sumSplitParts = parts => (parts || []).reduce((sum, part) => sum + Math.max(0, Number(part.amount) || 0), 0)

export const buildPaymentBreakdownFromParts = parts => (parts || []).reduce((acc, part) => {
  const method = part.method || 'Efectivo'
  const amount = Math.max(0, Number(part.amount) || 0)
  if (amount > 0) acc[method] = (acc[method] || 0) + amount
  return acc
}, {})
