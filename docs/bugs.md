# Known Bugs

| Date | Service | Root Cause | File / Line | Fix Applied |
|------|---------|------------|-------------|-------------|
| 2026-03-13 | product-catalog | SQL column name typo `price_unit` instead of `price_units` in `loadProductsFromDB` query caused every `ListProducts` call to fail with a PostgreSQL error, producing a 100% error rate | `src/product-catalog/main.go:197` | Changed `p.price_unit` to `p.price_units` to match the schema defined in `src/postgresql/init.sql:136` |
