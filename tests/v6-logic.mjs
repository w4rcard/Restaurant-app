import assert from 'node:assert/strict'
import { deductInventoryForSale, getInventoryRequirements, validateInventoryForSale } from '../src/lib/inventory.js'
import { calculateEstimatedPrepTime, getKitchenTiming } from '../src/lib/kitchen.js'
import { STATUS, itemSubtotal, orderTotal } from '../src/lib/pos.js'

const ingredients = [{id:'i1',name:'Carne',unit:'g',stock:500,minStock:50},{id:'i2',name:'Pan',unit:'unidad',stock:10,minStock:2}]
const products = [{id:'p1',name:'Burger',price:10000,estimatedPrepTime:900,ingredients:['i1','i2'],ingredientUsage:{i1:150,i2:1}}]
const items = [{productId:'p1',productName:'Burger',basePrice:10000,quantity:2,extras:[],removedIngredients:[]}]

const req = getInventoryRequirements(items,products,ingredients)
assert.equal(req.find(x=>x.ingredientId==='i1').quantity,300)
assert.equal(req.find(x=>x.ingredientId==='i2').quantity,2)
assert.equal(validateInventoryForSale(items,products,ingredients).ok,true)
const deducted = deductInventoryForSale(ingredients,req,'sale-1','emp-1',1000)
assert.equal(deducted.ingredients.find(x=>x.id==='i1').stock,200)
assert.equal(deducted.ingredients.find(x=>x.id==='i2').stock,8)
assert.equal(deducted.movements.length,2)
const insufficient = validateInventoryForSale([{...items[0],quantity:4}],products,ingredients)
assert.equal(insufficient.ok,false)

const estimated = calculateEstimatedPrepTime(items.map(x=>({...x,estimatedPrepTime:1200})),products,{defaultEstimatedPrepTime:900})
assert.equal(estimated,1200)
const timing = getKitchenTiming({status:STATUS.PENDING,createdAt:1,sentToKitchenAt:1,estimatedPrepTime:600},700000,{})
assert.equal(timing.alertLevel,'delayed')
assert.equal(itemSubtotal({basePrice:100,extras:[{price:25}],quantity:2}),250)
assert.equal(orderTotal([{basePrice:100,extras:[],quantity:2}]),200)
console.log('V6 logic tests: PASS')
