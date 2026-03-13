# Known Bugs

| Date | Service | Root Cause | Affected File/Line | Fix Applied |
|------|---------|------------|---------------------|-------------|
| 2026-03-13 | product-catalog | SQL column name typo: `price_unit` (singular) instead of `price_units` (plural) in `loadProductsFromDB` query. The `catalog.products` table defines the column as `price_units` (see `src/postgresql/init.sql:136`). This caused all `ListProducts` gRPC calls to fail with a SQL error, producing a cascading error rate spike across frontend and recommendation services. | `src/product-catalog/main.go:197` | Changed `p.price_unit` to `p.price_units` in the SELECT query within `loadProductsFromDB`. |
