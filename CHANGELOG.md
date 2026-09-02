# Changelog

## 0.1.0

The first release, and the first one anybody else can install.

Extracted from `houndbot`, where it was the Magento half of a harness that also
tested the Hound backend. The full history to that point is in that repository.

It stands alone because it asks a store for nothing but HTTPS: none of its 40
checks needs a database, a credential or a shell into the stack, so it can be
pointed at any storefront it can reach.
[`@harness/kernel`](https://github.com/kingletas/harness-kernel) is a dependency
rather than a sibling, and it is fetched from GitHub rather than from a path on
one laptop.

**40 checks across six suites** — smoke, session-less, journey, regression,
depth and checkout — covering thirteen areas of a storefront. Beyond the first
click: a product put on a wish list, proved by waiting for the item rather than
for the banner; and an order placed at the storefront through the store's own
Check / Money order method, proved by finding it again through Orders and
Returns rather than by reading the success page.

**A store is written to only when the environment says it may be.** The checks
that register a customer or place an order declare `isDisposable`, which comes
from `MAGENTO_DISPOSABLE=1` and from nothing else. It was previously declared
`true` in the source, so those checks would run against whatever store the
harness was pointed at — including one nobody meant to write to. Unset, they now
report `unsupported` and name the capability they lack.

**`MAGENTO_DIR` no longer defaults to a path on one machine.** Undeclared, a
`--changed` run says so and runs everything, rather than narrowing a run from a
diff of the wrong tree.

**A failing browser check says what it did.** Which candidate answered for each
element is recorded in the drift ledger, so an entry falling toward the bottom
of its list is visible before it stops resolving at all — and a failure repeats
the store's own error banner rather than reporting a selector nobody can find.
