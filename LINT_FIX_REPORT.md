# V6 lint fix — reporte

Se corrigieron los avisos mostrados en la salida de oxlint entregada por el usuario.

## Correcciones

- Eliminados imports no usados en `src/App.jsx`:
  - `DEFAULT_KITCHEN_SETTINGS`
  - `migrateKitchenOrder`
- Eliminados símbolos/variables no usados:
  - `cleanId`
  - `cashSales`
  - `downloadReceipt`
- Eliminado import no usado `defaultExtras` en `tests/v6-exhaustive.mjs`.
- Estabilizadas referencias derivadas (`categories`, `ingredients`, `extras`, `tables`, `orders`, `employees`) mediante `useMemo` para evitar dependencias que cambian en cada render.
- Estabilizadas funciones de audio con `useCallback` y dependencias explícitas.
- Ajustado el efecto de alertas de cocina para depender de referencias estables y de todas las funciones/configuraciones que usa.
- `test:all` ahora incluye `tests/mixed-people.mjs`, para que la prueba de cobro dividido por personas forme parte de la suite acumulada.

## Verificación disponible en este entorno

- `npm run test:all`: PASS.
- Pruebas de lógica, migración, documentos, estáticas, cobro por personas, servidor y suite exhaustiva: PASS.
- Sintaxis Node en server/tests/src/lib: PASS.

## Limitación

No se pudo ejecutar `npm run lint` ni `npm run build` en este entorno porque la instalación de dependencias npm no terminó y no hay `node_modules` disponible localmente. Por eso el reporte no afirma que oxlint/Vite se hayan ejecutado aquí después del cambio. La corrección se basa en todos los avisos concretos entregados en la salida de lint.
