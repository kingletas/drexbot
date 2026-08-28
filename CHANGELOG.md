# Changelog

## 0.1.0

Extracted from `~/Development/typescript/houndbot`, where it was the Magento
half of a harness that also tested the Hound backend. The full history to that
point is in that repository.

It stands alone because it asks a store for nothing but HTTPS: none of its 31
checks needs a database, a credential or a shell into the stack, so it can be
pointed at any storefront it can reach. `@harness/kernel` is a dependency
rather than a sibling.
