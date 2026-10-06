import assert from 'node:assert/strict'
import { buildReceiptPdf } from '../src/lib/documents.js'
const receipt = { restaurantName:'Verde & Grano', tableName:'Mesa 4', createdAt:Date.now(), items:[{quantity:2,productName:'Hamburguesa Clásica',subtotal:44000,extras:[{name:'Queso extra'}]}], subtotal:44000, discount:0, tip:4400, total:48400, paymentMethod:'Efectivo', people:2 }
const pdf = buildReceiptPdf(receipt,'COP')
assert.ok(pdf.length > 500)
assert.equal(new TextDecoder().decode(pdf.slice(0,8)).startsWith('%PDF-1.4'), true)
const text = new TextDecoder().decode(pdf)
assert.match(text,/%%EOF/)
assert.match(text,/Total:/)
console.log('V6 document tests: PASS')
