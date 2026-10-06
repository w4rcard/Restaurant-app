# Restaurante V6 — Test Report

## Repeated verification

| Suite | Repetitions | Result |
|---|---:|---|
| Server + SQLite smoke | 5 | PASS 5/5 |
| Inventory / POS / kitchen logic | 5 | PASS 5/5 |
| Receipt PDF generation | 5 | PASS 5/5 |
| V5 → V6 migration | 5 | PASS 5/5 |
| Static project / import / metadata checks | 5 | PASS 5/5 |

## Server coverage

- SQLite database creation
- `PRAGMA integrity_check`
- GET `/api/health`
- GET `/api/state`
- PUT `/api/state`
- SSE `/api/events`
- SQLite backup endpoint
- JSON state persistence
- V6 state version
- Windows-safe child process startup in the existing smoke test

## Functional logic coverage

- Ingredient requirements from product recipes
- Excluding removed ingredients
- Stock sufficiency validation before sale
- Automatic stock deduction on sale
- Inventory movement creation
- Product prep-time calculation
- Kitchen delayed-state calculation
- POS subtotal / order total calculations

## V6 product changes verified statically

- Inventory module
- New Comanda table selector
- Per-device Modo Trabajo
- Functional Caja abierta/cerrada indicator
- Reconnection polling / online-offline handling
- Payment combination wording
- Receipt preview
- Print flow
- PDF download flow
- V5 → V6 data migration
- V6 package metadata and imports

## Environment limitation

The complete frontend build and lint could not be executed in this environment because `npm ci` could not finish fetching packages from the npm registry. The Node/server test suites do run locally in this environment, and all repeated suites above passed 5/5.

Recommended final local verification:

```bash
npm install
npm run test:smoke
npm run build
npm run lint
```
