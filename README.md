# drexbot

Regression, acceptance, behaviour and performance testing for a Magento
storefront.

```bash
drexbot baseline --target magento
```

```bash
drexbot run --target magento
```

Silence means nothing is wrong. The verdict vocabulary, the silence contract, the
ledgers and the worker pool all belong to
[`@harness/kernel`](../harness-kernel/README.md); this package is the adapter, the
browser surface and its fixtures.

## It asks a store for nothing but HTTPS

**None of its 31 checks needs privileged access.** Nine drive a browser, the rest
are plain HTTP, and the adapter declares `canReadDatabase: false`. So it can be
pointed at any store it can reach — including one whose configuration is not
yours to fix, which is why a failure repeats the store's own error banner rather
than reporting a selector nobody can find.

## Capture the store before running against it

```bash
drexbot baseline --target magento
```

A category path and a search term are **facts about a catalogue**, not constants.
Written into the source they pin the harness to one store, so the baseline is
captured over GraphQL and read by the checks. Until it exists, the checks that
need a catalogue report `blocked` and name the command.

`baseline` is the one command the shared set does not have: a storefront is the
only target whose checks need facts about a catalogue before they can ask for
anything.

## Selectors, and the ledger that watches them rot

Every element is an ordered candidate list rather than one selector — semantic
and ARIA first, the Magento convention next, this theme's own class last. Which
one answered is recorded, so an entry falling through toward the bottom of its
list is visible before it stops resolving at all.

```bash
drexbot probe --target magento
```

The probe walks the whole journey, reports which entries resolve and via which
candidate, and **judges nothing** — it exits 0 even when nothing resolves,
because a probe that failed would be a gate, and a gate is not what you run first.
