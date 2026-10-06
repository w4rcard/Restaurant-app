import assert from 'node:assert/strict'
import { buildPaymentBreakdownFromParts, clampSplitPeople, distributeSplitTotal, resizeSplitPeople, sumSplitParts } from '../src/lib/payments.js'

for (let run = 1; run <= 5; run += 1) {
  assert.equal(clampSplitPeople(3), 3)
  assert.equal(clampSplitPeople(1), 2)
  assert.equal(clampSplitPeople(99), 20)

  const parts = distributeSplitTotal(1000, 3)
  assert.equal(parts.length, 3)
  assert.equal(sumSplitParts(parts), 1000)
  assert.equal(parts[0].amount, '333.34')
  assert.equal(parts[1].amount, '333.33')
  assert.equal(parts[2].amount, '333.33')

  const resized = resizeSplitPeople(5, parts)
  assert.equal(resized.length, 5)
  assert.equal(resized[0].amount, '333.34')
  assert.equal(resized[3].label, 'Persona 4')

  const breakdown = buildPaymentBreakdownFromParts([
    { method:'Efectivo', amount:'30000' },
    { method:'Tarjeta', amount:'50000' },
    { method:'Efectivo', amount:'20000' },
  ])
  assert.deepEqual(breakdown, { Efectivo:50000, Tarjeta:50000 })
  assert.equal(sumSplitParts([{ amount: '' }, { amount: '10' }]), 10)
}

console.log('Mixed people payment tests: PASS (5/5)')
