# SQLite to PostgreSQL importer (P3)

This is an offline migration utility. The running application and its SQLite runtime are unchanged. The importer accepts only an explicit V8 SQLite source and a PostgreSQL target whose host is loopback and whose database name contains `test` or `import`. It never reads browser profiles or localStorage.

## Safe test use

1. Make a disposable SQLite copy using a SQLite-aware backup procedure. Never point this utility at the live restaurant database. The utility independently rejects the explicit active path, the repository default database path, `DB_PATH`, and `RESTAURANT_ACTIVE_DB_PATH`, including canonical path and hard-link aliases.
2. Create a disposable PostgreSQL database, then apply the repository migrations with `POSTGRES_MIGRATION_DATABASE_URL` and `npm run db:pg:migrate`.
3. Set `POSTGRES_IMPORT_DATABASE_URL` to that loopback test/import database. Set it in the process environment, not in the report or command arguments.
4. Run preflight and review the generated JSON report:

   ```powershell
   node server/sqlite-postgres-import.mjs `
     --source C:\pos-test\source.sqlite `
     --active-db C:\path\to\repository\data\restaurante-v8.db `
     --report C:\pos-test\preflight.json `
     --restaurant-id restaurant-test `
     --confirmed-sales-currency COP `
     --dry-run
   ```

5. Only after reviewing an unblocked report and resolving every policy decision, repeat the command without `--dry-run`. Import requires all target business tables to be empty. It never truncates, updates, or merges an existing tenant.

The report includes source/import counts, relationship counts, credential-state counts, diagnostics, and a source digest. It does not include customer fields, credential verifiers, PINs, or connection data. Import errors printed to stdout/stderr are restricted to stable diagnostic codes.

## Snapshot, transaction, and recovery

The source is opened read-only. SQLite `VACUUM INTO` creates a consistent temporary snapshot (including committed WAL state); validation reads only that snapshot, which is deleted after parsing. No `mergeState`, `dedupeSales`, or runtime database initializer is imported or invoked.

PostgreSQL schema migration checksums are verified before import. The importer checks all business tables are empty, takes a tenant-scoped advisory transaction lock, inserts with parameterized `pg` queries in one serializable transaction, checks inserted counts and financial totals, records an import run plus source-to-target ID map, changes the run from `staging` to `completed`, then commits. A database error or connection interruption rolls the full transaction back. An interrupted transaction therefore leaves no accepted run; it can be retried against the still-empty target. Any non-empty target is rejected, including an already accepted import, so reruns never duplicate or overwrite data.

## Mapping contract

| SQLite source | PostgreSQL target | Policy and preservation |
|---|---|---|
| `app_state.data.config`, `soundPresets` | `restaurants.settings`, `restaurants.name`, `currency_code` | Configuration and sound settings are stored as JSONB settings. Restaurant ID is a required explicit tenant ID. |
| `employees` | `employees` | IDs (safe numeric IDs become decimal text), name, role and active state preserved. Plaintext `pin` is removed. Unsupported employee fields block. |
| `employee_credentials` | `employee_credentials` | Only Phase 2B `scrypt-v1` verifier bytes and `active`/`must_change`/`reset_required` lifecycle are copied. Fixed verifier parameters are those in the approved schema. Sessions are not present in the source and are not created. |
| `tables` | `restaurant_tables` | IDs, name, active state, shape, coordinates, capacity and size preserved. Reciprocal `joinedWith` links become generated `table_groups` and `table_group_members`; malformed groups block. |
| `categories`, `products` | `categories`, `products` | IDs, category refs, availability, price and product fields are preserved. Product recipe data describes the current catalog only and is stored as version 1 when present. Historical order lines are not linked to that current recipe. |
| `ingredientCategories`, `ingredients` | `ingredient_categories`, `ingredients`, `inventory_balances` | String categories receive deterministic generated IDs. Ingredient IDs, units, cost, minimum and current stock are preserved. No balance is recalculated from recipes. |
| `extraCategories`, `extras` | `modifier_categories`, `modifiers`, `modifier_ingredients`, `product_modifiers` | Category IDs are generated deterministically from category names; existing extra/product/ingredient IDs remain. Unsupported units or references block. |
| `orders`, `items` | `orders`, `order_lines`, `order_line_modifiers` | Order IDs and order references remain. Missing line IDs receive deterministic IDs recorded in the manifest. Accepted base prices, line totals, removals, notes, and selected modifier snapshots are preserved. No kitchen/preparation events are invented. |
| `customers`, `reservations` | `customers`, `reservations` | IDs and references are retained. Time strings without an explicit UTC offset are blocked rather than interpreted in the machine's timezone. |
| `sales`, `orderIds`, receipt `documents` | `sales`, `sale_orders`, `sale_lines`, `payments`, `sale_documents` | Sales and order links are preserved; receipt items are the accepted sale-line snapshots. The legacy receipt does not contain order-line IDs, so `sale_lines.order_line_id` remains null rather than guessed. Recorded payment breakdowns become payment rows with generated IDs; payment attempts, provider confirmation, refunds, and taxes are not synthesized. |
| `inventoryMovements` | `inventory_movements` | Signed quantity, unit, before/after stock, sale link, employee, reason and timestamp are retained. A sale movement needs its original sale reference. No consumption is reconstructed from current recipes. |
| `cash.isOpen`, `cash.closings`, `cash.movements` | `cash_sessions`, `cash_movements` | An open session ID is generated and recorded. Closing records need a trustworthy opening employee, which current V9 closing records may not carry; those cases block. Cash movement session links are inferred only when exactly one session exists; otherwise they block. |
| `audit` | `audit_events` | Imported with `details.provenance = legacy_unverified`; these are not security events. |
| `localStorage` | none | Pending browser-only changes cannot be inferred from the SQLite snapshot. A separate operator-led reconciliation is required before any future production cutover. |

## Reconciliation blockers

Import is blocked for missing/duplicate/unsafe IDs, unsupported fields or enums, broken parent references, malformed table groups, overlapping sale-to-order references, missing or multiple sale receipt snapshots, payment/total mismatches, invalid credential lifecycle, ambiguous timestamps, ambiguous cash attribution, and JSON number tokens whose decimal value changes when parsed as JavaScript `Number`.

Legacy sales do not store currency per sale. Every such import therefore requires the operator to explicitly confirm `--confirmed-sales-currency COP` or `USD`; the choice is recorded in the report. This is an explicit reconciliation decision, not a value inferred from the current restaurant configuration. No currency rounding is performed; values are passed as decimal strings to PostgreSQL `NUMERIC`.

The importer does not erase PIN copies that may remain in historical SQLite pages/WAL, browser caches, exports, or backups. Handle those separately. It also does not make changes to SQLite, application code, API behavior, or production data.
