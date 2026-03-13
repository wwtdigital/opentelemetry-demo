# Known Bugs

| Date | Service | Root Cause | Affected File/Line | Fix Applied |
|------|---------|------------|---------------------|-------------|
| 2026-03-13 | product-catalog | SQL column name typo: `price_unit` (singular) instead of `price_units` (plural) in `loadProductsFromDB` query. The `catalog.products` table defines the column as `price_units` (see `src/postgresql/init.sql:136`). This caused 100% of `ListProducts` gRPC calls to fail with a PostgreSQL "column does not exist" error. | `src/product-catalog/main.go:197` | Changed `p.price_unit` to `p.price_units` in the SQL SELECT query within `loadProductsFromDB`. Single-character fix (added trailing `s`). |
