# Restaurante V6 — auditoría, correcciones y pruebas finales

## Correcciones aplicadas

- Selector real para **Nueva comanda** con mesas libres.
- Prevención de crear una comanda nueva sobre una mesa que ya tiene una cuenta activa.
- Bloqueos anti doble clic para comandas, cobros, caja y movimientos de inventario.
- Pago combinado robusto, incluso si el segundo método también es efectivo.
- Stock de inventario reconstruible a partir del libro de movimientos (`baseStock + movimientos`).
- Consumo de ingredientes de productos y extras incluido en la misma contabilidad.
- Deducción y movimientos de inventario preparados para sincronización concurrente.
- Protección contra doble venta del mismo pedido al cerrar desde dos dispositivos.
- Eliminación de duplicados asociados en comprobantes y movimientos cuando se detecta una doble venta.
- Merge de configuración por campo para evitar que cambios simultáneos de dos dispositivos se pisen.
- Reconexión con combinación del estado local pendiente y el servidor.
- PIN operativo por empleado y permisos básicos para Caja/Inventario/Catálogo.
- Ajuste de inventario permite establecer stock en cero.
- Sonido: controles activables, audio personalizado máximo 2 s, límite de archivo 1.5 MB y un solo disparo sonoro por lote de alertas vencidas.
- Configuración de mesas convertida a baja lógica (`active:false`) para evitar que la sincronización vuelva a crear mesas eliminadas.
- No permite reducir la cantidad de mesas si alguna de las mesas que desaparecerían tiene pedidos activos.
- Servidor preparado para escuchar en red (`0.0.0.0`) y arranque robusto en Windows.
- Respaldo SQLite e integridad verificados.

## Cobertura probada

Se revisaron todos los archivos JavaScript/JSX/MJS de `src/`, `server/` y `tests/` mediante parser TypeScript sin errores sintácticos.

También se verificó:

- JSON de `package.json` y `package-lock.json`.
- Balance de llaves de CSS.
- Imports locales de la aplicación.
- Ausencia de TODO/FIXME/HACK pendientes en código de producto.
- API `health`, `state`, `events`, `backup` y manejo de payload inválido.
- SQLite `integrity_check`.
- Respaldo SQLite reabierto y leído.
- Acceso del servidor en `0.0.0.0`.
- Persistencia y merge concurrente de pedidos.
- Merge independiente de configuración.
- Protección contra duplicados de ventas.
- Reconstrucción de inventario desde movimientos.
- Migración V5 → V6 y normalización de datos antiguos.
- Cálculos POS.
- Tiempos y alertas de cocina.
- Generación de PDF de comprobantes.

## Repetición

La suite completa `npm run test:all` pasó **5 veces consecutivas** sin fallos.

Cada bloque interno de la suite exhaustiva se repite 5 veces, incluyendo inventario, cocina, POS, sincronización, duplicados, migración, PDF y rondas de servidor.

## Limitación del entorno

No se pudo ejecutar `npm run build` ni `npm run lint` en este entorno porque `node_modules` no está instalado y la instalación de dependencias desde npm no pudo completarse por las restricciones de red del entorno.

Por la misma razón, no se hizo un click-through visual de la aplicación React en un navegador real. La sintaxis completa de la aplicación sí fue parseada, y el servidor/API y la lógica de negocio se ejecutaron repetidamente.

## Verificación local recomendada

```bash
npm install
npm run test:all
npm run build
npm run lint
npm start
```
