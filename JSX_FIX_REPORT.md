# V7 JSX lint fix

Se corrigió el bloque JSX del selector de Nueva Comanda en `src/App.jsx`.

Problema reportado por Oxlint:
- `Adjacent JSX elements must be wrapped in an enclosing tag.` en la línea 1134.

Cambio aplicado:
- Se reescribió el bloque `newOrderPickerOpen` con paréntesis explícitos.
- Se mantuvieron las mismas acciones y lógica: mesa, para llevar y domicilio.
- Se explicitó el retorno del `map()` de mesas disponibles.
- No se cambió la lógica de negocio.

Pruebas ejecutadas después del cambio:
- V6 logic: PASS
- V6 migration: PASS
- V6 documents: PASS
- V6 static: PASS
- Mixed people: PASS (5/5)
- Server smoke: PASS
- V6 exhaustive: PASS (todos los bloques 5/5)
- V7 regression: PASS (todos los casos 5/5)

Limitación:
- Oxlint/Vite no se pudieron ejecutar en este entorno porque las dependencias npm no estaban instaladas y el acceso al registro npm no quedó disponible.
