# Restaurante V8

Aplicación POS local para restaurante con React + Vite + servidor Node + SQLite.

## Inicio rápido

```bash
npm install
npm start
```

`npm start` inicia la API SQLite y la interfaz. Por defecto la interfaz queda disponible en el puerto de Vite y la API en `8787`.

## Datos

La base SQLite se guarda en `data/restaurante-v6.db` (puedes cambiarla con `DB_PATH`).

V8 migra automáticamente el estado V5 guardado en el navegador/servidor y conserva productos, mesas, pedidos, ventas y caja.

## Qué agrega V8

- Inventario real: entradas, ajustes, stock mínimo y movimientos.
- Descuento automático de ingredientes al cerrar una venta.
- Validación de stock antes de cobrar.
- Selector de mesa para Nueva comanda.
- Modo Trabajo por dispositivo, con navegación reducida según el rol activo.
- Cobro más directo, pagos combinados y comprobante generado después de cobrar.
- Impresión del comprobante y descarga del documento.
- Indicador funcional de caja abierta/cerrada.
- Reconexión automática al servidor y refresco tras recuperar conexión.
- Servidor preparado para escuchar en red local; para otra red usa una VPN segura como Tailscale en vez de exponer SQLite directamente a internet.
- Respaldo de SQLite desde Configuración.
- Sincronización tolerante a cambios simultáneos: combina entidades por timestamp, evita ventas duplicadas y reconstruye el stock desde el libro de movimientos.
- PIN operativo por empleado para cambiar de operador y permisos básicos por rol para caja, inventario y catálogo.
- Bloqueos anti doble clic en comandas, cobros, caja y movimientos de inventario.

## Red local / acceso remoto

El servidor escucha en `0.0.0.0` para poder recibir conexiones de la red local. Puedes cambiar `UI_HOST` y `HOST` si lo necesitas.

Para acceso desde otra red, mantén el servidor en tu PC y usa una VPN privada (por ejemplo Tailscale). No expongas el puerto de SQLite/API directamente a internet sin autenticación y una capa de red segura.

## Pruebas

```bash
npm run test:smoke
npm run test:exhaustive
npm run test:all
npm run build
npm run lint
```

### Comprobantes

Después de cobrar se genera un comprobante con opción de imprimir o descargar como PDF. El sistema no pretende sustituir la facturación electrónica/fiscal que pueda exigir la normativa local; esa integración puede añadirse en una fase específica.


## V8
Incluye clientes, reservas, tipos de pedido (mesa / para llevar / domicilio), búsqueda global, QR preparado por mesa, acceso remoto preparado mediante URL pública, inventario con “Añadir” y “Añadir ingrediente”, y conserva toda la base de V6.
