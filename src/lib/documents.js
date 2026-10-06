const plain = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const pdfEscape = value => plain(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
const moneyPdf = (value, currency='COP') => new Intl.NumberFormat('es-CO', { style:'currency', currency, maximumFractionDigits:0 }).format(Number(value)||0).replace(/\u00a0/g, ' ')

export function buildReceiptPdf(receipt, currency='COP') {
  const lines = [
    plain(receipt.restaurantName),
    `Comprobante · ${plain(receipt.tableName)} · ${new Date(receipt.createdAt).toLocaleString('es-CO')}`,
    '',
    ...(receipt.items || []).flatMap(item => [
      `${item.quantity} x ${plain(item.productName)}  ${moneyPdf(item.subtotal,currency)}`,
      ...(item.extras || []).map(extra => `  + ${plain(extra.name)}`),
    ]),
    '',
    `Subtotal: ${moneyPdf(receipt.subtotal,currency)}`,
    `Descuento: ${moneyPdf(receipt.discount,currency)}`,
    `Propina: ${moneyPdf(receipt.tip,currency)}`,
    `Pago: ${plain(receipt.paymentMethod)}`,
    `Total: ${moneyPdf(receipt.total,currency)}`,
    `Personas: ${Number(receipt.people)||1}`,
    '',
    'Comprobante generado por el sistema.',
  ]
  const contentLines = ['BT', '/F1 13 Tf', '40 780 Td']
  lines.forEach((line,index) => {
    const size = index === 0 ? 15 : (line.startsWith('Total:') ? 14 : 10)
    if (index !== 0) contentLines.push('0 -17 Td')
    contentLines.push(`/F1 ${size} Tf (${pdfEscape(line)}) Tj`)
  })
  contentLines.push('ET')
  const stream = contentLines.join('\n') + '\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}endstream`,
  ]
  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'
  const offsets = [0]
  for (let i=0;i<objects.length;i++) {
    offsets.push(new TextEncoder().encode(pdf).length)
    pdf += `${i+1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefOffset = new TextEncoder().encode(pdf).length
  pdf += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n`
  for (let i=1;i<offsets.length;i++) pdf += `${String(offsets[i]).padStart(10,'0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return new Uint8Array(new TextEncoder().encode(pdf))
}
