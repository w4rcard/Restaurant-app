# Restaurante V8 — pruebas y revisión

## Implementado

- Migración acumulativa V7 → V8 con DB/localStorage/canal de sincronización V8.
- Análisis inteligente local: ventas, pedidos, retrasos, valor de stock, productos de mayor movimiento, señales operativas y estimación simple de demanda cuando hay datos suficientes.
- Exportación CSV del análisis.
- Unidades por insumo con conversiones g↔kg y ml↔L.
- Cantidad y unidad de consumo configurables por ingrediente de cada producto/extra.
- Inventario con `Añadir stock` y `Ajustar` claramente separados.
- Historial de movimientos con búsqueda y filtros Hoy/Ayer/7 días/Todo; el filtro Hoy cambia automáticamente al cambiar de día sin borrar historial.
- Editor de salón V8 con arrastre por pointer, editor lateral y creación de mesas sin usar drag-and-drop nativo, evitando copias visuales al mover mesas.
- Cocina con señales de color por estado y estado retrasado claramente marcado.
- Sonido de pedido nuevo centralizado: se dispara al detectar una comanda nueva local o sincronizada; el sonido se configura desde Sonidos y alertas.
- Diseño más minimalista en las áreas nuevas, sin eliminar información funcional.

## Pruebas ejecutadas

- V6 logic: PASS
- V6 migration: PASS
- V6 documents: PASS
- V6 static: PASS
- Mixed people payments: PASS 5/5
- Server smoke + SQLite: PASS
- V6 exhaustive: PASS; todos los bloques críticos 5/5
- V7 regression: PASS; todos los bloques 5/5
- V8 regression: PASS; todos los bloques 5/5
- CSS brace/parenthesis balance: PASS
- Node syntax check: PASS para JS/MJS usados en servidor/tests/lib

## Limitación

En este entorno no se pudo ejecutar `npm run lint` ni `npm run build` porque las dependencias frontend de npm no están disponibles localmente y `npm ci --offline` falló por un paquete de Vite no cacheado. Por eso no se afirma que Oxlint/Vite hayan pasado aquí; deben ejecutarse en el PC del usuario.
