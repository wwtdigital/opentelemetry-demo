# Known Bugs

| Date | Service | Root Cause | Affected File/Line | Fix Applied |
|------|---------|-----------|-------------------|-------------|
| 2026-03-13 | product-catalog | SQL column name typo: `p.price_unit` (singular) used instead of `p.price_units` (plural) in `loadProductsFromDB()` query, causing every `ListProducts` call to fail with a PostgreSQL "column does not exist" error | `src/product-catalog/main.go:197` | Changed `p.price_unit` to `p.price_units` to match the database schema defined in `src/postgresql/init.sql:136` |
