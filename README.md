# drexbot

[![CI](https://github.com/kingletas/drexbot/actions/workflows/ci.yml/badge.svg)](https://github.com/kingletas/drexbot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Regression, acceptance, behaviour and performance testing for a Magento
storefront.

## Documentation

|                                                         |                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| [From nothing to a checked store](docs/from-nothing.md) | You have never used a test harness. Start here                |
| [Getting started](docs/getting-started.md)              | You know what a harness is. Ten minutes                       |
| [User guide](docs/user-guide.md)                        | Every command, every flag, every verdict                      |
| [Configuration](docs/configuration.md)                  | The environment it reads, and the files it keeps              |
| [Architecture](docs/architecture.md)                    | Kernel and adapter, and how a change gets made                |
| [CONTRIBUTING.md](CONTRIBUTING.md)                      | The shape a change should arrive in, and how a release is cut |
| [SECURITY.md](SECURITY.md)                              | The model, and where to report something                      |

## Installing it

Node 20.19 or newer. Not on npm — clone it, and `make setup` fetches the dependencies and the one browser it drives:

```bash
git clone https://github.com/kingletas/drexbot && cd drexbot && make setup
```

```bash
make install
```

This puts `drexbot` on your `PATH`, pointed back at the clone.

The kernel is fetched from its own repository rather than from the registry, and
**npm 12 refuses git dependencies by default** — it stops with `EALLOWGIT` before
fetching anything. On npm 12, install with `npm ci --allow-git=all`, or use npm
11, which Node 24 still ships. Nothing here sets that for you: it would relax the
rule for every dependency rather than this one.

```bash
drexbot baseline --target magento
```

```bash
drexbot run --target magento
```

Silence means nothing is wrong. The verdict vocabulary, the silence contract, the
ledgers and the worker pool all belong to
[`harness-kernel`](https://github.com/kingletas/harness-kernel); this package is the adapter, the
browser surface and its fixtures.

## It asks a store for nothing but HTTPS

**None of its 40 checks needs privileged access.** Eighteen drive a browser, the
rest are plain HTTP, and nothing in it can open a database connection. So it can be
pointed at any store it can reach — including one whose configuration isn't
yours to fix, which is why a failure carries the store's own error banner and
what is actually on the page, rather than only a selector nobody can find.

## Capture the store before running against it

```bash
drexbot baseline --target magento
```

A category path and a search term are **facts about a catalogue**, not constants.
Written into the source they pin the harness to one store, so the baseline is
captured over GraphQL and read by the checks. Until it exists, the checks that
need a catalogue report `blocked` and name the command.

`baseline` is the one command the shared set doesn't have: a storefront is the
only target whose checks need facts about a catalogue before they can ask for
anything.

## It places a real order, and can't take it back

The store's own offline method — Check / Money order, active in every Magento
that ships `Magento_OfflinePayments` — takes no money, so an order is placed
without a gateway and without charging anything. Nothing here removes the order
afterwards, which is why the check runs only where the environment says the
store may be written to:

```bash
MAGENTO_DISPOSABLE=1 drexbot run --target magento --suite checkout
```

**It fails closed, and only that exact value opens it.** Unset, the checks that
register an account or place an order report `unsupported` and say what they
are missing — they never fail, and they are never silently absent from
the sheet. So pointing this at a store you didn't mean to write to costs you
two lines of output rather than an order somebody has to go and cancel.

Placing is asserted by finding the order again through Orders and Returns, not
by the success page: a page that names an order number is a page.

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
because a probe that failed would be a gate, and a gate isn't what you run first.

## The environment it reads

| Variable             | Default                | What it decides                                                                       |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| `MAGENTO_URL`        | `https://vanilla.test` | The store to point at.                                                                |
| `MAGENTO_DISPOSABLE` | unset                  | `1` allows the checks that write. Anything else, including `true`, refuses.           |
| `MAGENTO_ADMIN_PATH` | `/admin`               | Where the admin lives, so the session-less probe knocks on the right door.            |
| `MAGENTO_DIR`        | —                      | A checkout of the store's own code, so `run --changed` can select checks from a diff. |

## License

MIT — see [LICENSE](LICENSE). [CONTRIBUTING.md](CONTRIBUTING.md) is the shape a change should arrive in, and [SECURITY.md](SECURITY.md) has the model and the reporting route.
