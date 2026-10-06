# Restaurante V7 — reporte de implementación y pruebas

## Implementado
- Migración acumulativa V6 → V7.
- Store SQLite/localStorage con versión 7 y soporte de lectura de estados V6.
- Conservación de pendientes de sincronización heredados de V6.
- Clientes: alta, edición, teléfono, correo, notas, contador de pedidos y gasto acumulado.
- Reservas: fecha, hora, personas, cliente, mesa, estado y notas; apertura de comanda desde una reserva asignada a mesa.
- Tipos de pedido: mesa, para llevar y domicilio.
- Cliente opcional dentro de la toma de pedido.
- Dirección para pedidos a domicilio.
- Cobro de pedidos externos reutilizando el flujo de cobro de V6.
- Búsqueda global de pedidos, clientes, mesas y reservas.
- QR por mesa preparado a partir de URL pública/base y enlace por mesa.
- Configuración de URL pública para futura publicación mediante túnel seguro.
- Inventario: “Entrada” pasa a “Añadir”; nuevo botón “Añadir ingrediente”; también se mantiene “Añadir stock”.
- Backup SQLite renombrado a V7.
- UI identificada como V7.
- Tests V7 añadidos y test suite acumulativa actualizada.

## Pruebas ejecutadas en este entorno
1. `npm run test:all` → PASS.
2. V6 lógica → PASS.
3. V6 migración → PASS.
4. V6 documentos → PASS.
5. V6 static → PASS.
6. Pagos divididos por personas → PASS (5/5).
7. Smoke server/SQLite → PASS.
8. V6 exhaustive → PASS; los bloques críticos se repiten 5/5 y el servidor integrado se ejecuta en 5 rondas.
9. V7 regression → PASS; cada bloque V7 se repite 5/5.
10. Sintaxis Node para `server/*.mjs` y librerías JS de `src/lib` → PASS.

## Cobertura V7 de regresión
- Defaults y versión 7 → 5/5.
- Migración V6 → V7 → 5/5.
- Merge de clientes/reservas → 5/5.
- Compatibilidad inventario → 5/5.
- Marcadores de UI/arquitectura V7 → 5/5.

## Limitación conocida del entorno
No fue posible ejecutar `npm run lint` ni `npm run build` en este entorno porque la instalación de dependencias de Node/Vite no terminó. El paquete entregado mantiene `npm start`, `npm run lint`, `npm run build`, `npm run test:all` y `npm run test:v7` para verificación en el PC del usuario.
