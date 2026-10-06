# V7 JSX Fix 2

Corregido el segundo error de Oxlint en `src/App.jsx`.

## Error reportado

`Adjacent JSX elements must be wrapped in an enclosing tag.`

Ubicación: bloque de acciones rápidas de la mesa seleccionada.

## Causa

La rama `else` del operador ternario renderizaba dos `<button>` hermanos directamente:

- QR mesa
- Unir mesa

## Corrección

Se envolvieron ambos botones en un fragmento JSX `<>...</>`.

## Revisión adicional

Se buscó el mismo patrón de dos botones hermanos dentro de ramas ternarias en `src/App.jsx`; no se encontraron coincidencias adicionales con el mismo patrón textual.

## Limitación de verificación

En este entorno no se pudo ejecutar Oxlint/Vite porque `node_modules` no está disponible y la instalación de dependencias agotó el tiempo de ejecución.
