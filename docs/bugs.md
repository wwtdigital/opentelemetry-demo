# Known Bugs

| Date | Service | Root Cause | Affected File/Line | Fix Applied |
|------|---------|------------|---------------------|-------------|
| 2026-03-13 | product-catalog | SQL column name typo: `price_unit` instead of `price_units` in `loadProductsFromDB` query caused all `ListProducts` calls to fail with a PostgreSQL "column does not exist" error, cascading into `GetProduct` error metrics | `src/product-catalog/main.go:197` | Changed `p.price_unit` → `p.price_units` to match the `catalog.products` schema defined in `src/postgresql/init.sql:136` |
