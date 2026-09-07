# Configuration

There's no configuration file, and that's on purpose. Everything drexbot needs to be told is an environment variable, and everything it works out for itself it writes down where you can read it.

## Contents

- [Why there's no config file](#why-theres-no-config-file)
- [The store](#the-store)
- [The notification channel](#the-notification-channel)
- [TLS](#tls)
- [The files it keeps](#the-files-it-keeps)
- [The store baseline, key by key](#the-store-baseline-key-by-key)
- [What is deliberately not configurable](#what-is-deliberately-not-configurable)

## Why there's no config file

Two kinds of thing could go in one, and neither belongs there.

**Facts about your catalogue** — a category with products in it, a search term that returns something, a product with options — aren't settings. Somebody would have to keep them true, and nobody would. So they are captured from the store itself, by `drexbot baseline`, and written to a file the harness maintains rather than one you edit.

**Facts about which store this is** are a property of the shell you are running in, not of the checkout. Two people pointing the same clone at two different stores should not be editing the same file, and a CI job should not have to write one.

What is left is nothing, so there's no file.

## The store

| Variable             | Default                | What it decides                                                                 |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------- |
| `MAGENTO_URL`        | `https://vanilla.test` | The store to point at. `--url` overrides it for one command                     |
| `MAGENTO_ADMIN_PATH` | `/admin`               | Where the admin lives, so the session-less checks knock on the right door       |
| `MAGENTO_DISPOSABLE` | unset                  | `1`, and only `1`, allows the two checks that write                             |
| `MAGENTO_DIR`        | unset                  | A checkout of the store's own code, so `--changed` can narrow a run from a diff |

**`MAGENTO_DISPOSABLE` takes exactly `1`.** Not `true`, not `yes`, not `on`. Two checks register a customer and place an order, and nothing here can undo either, so it refuses by default: without this set, both report `unsupported` and say what they are missing. Set it only against a store you wouldn't mind finding a junk order in.

**`MAGENTO_DIR` has no default, deliberately.** A default path is a guess about one machine, and a `--changed` run narrowed from a diff of the wrong tree would silently drop exactly the checks the change should have selected. Unset, `--changed` says so and runs everything.

## The notification channel

These belong to `harness-kernel`, so they are the same in any harness built on it.

| Variable                 | What it decides                                             |
| ------------------------ | ----------------------------------------------------------- |
| `HARNESS_NOTIFY`         | `none` (default), `mail` or `webhook`                       |
| `HARNESS_NOTIFY_SMTP`    | mail: `host:port` of the sink                               |
| `HARNESS_NOTIFY_TO`      | mail: who is told                                           |
| `HARNESS_NOTIFY_FROM`    | mail: who it claims to be from. Default `harness@localhost` |
| `HARNESS_NOTIFY_WEBHOOK` | webhook: the incoming-webhook URL                           |

A misconfigured channel is an error with a sentence in it, not a silent no-op — a mail channel with nobody to deliver to says so. Prove it before relying on it:

```bash
drexbot notify --test
```

Sending is gated on the run having something to say rather than on something being red. The rule is in the [user guide](user-guide.md#notifications).

## TLS

drexbot verifies certificates the ordinary way and never turns that off: a harness that skips TLS checks can't make any statement about a target's TLS.

Node bundles its own certificate list and ignores the system trust store, so a development store on a locally issued certificate fails here even though curl and every browser on the machine accept it. Point `NODE_EXTRA_CA_CERTS` at the root:

```bash
export NODE_EXTRA_CA_CERTS=$HOME/.local/share/mkcert/rootCA.pem
```

The `drexbot` wrapper does this for you when it finds an mkcert root and you haven't set the variable yourself.

## The files it keeps

Four directories, and whether each is committed is a decision rather than an accident.

| Directory         | Committed  | What is in it                                                                                                   |
| ----------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| `ledger/`         | **yes**    | `magento.drift.json`, `magento.flake.json`, and the quarantine                                                  |
| `baselines/`      | **partly** | What the store is, and what wasn't green last time, are; the timings and the record of who has been told aren't |
| `results/`        | no         | One directory per run                                                                                           |
| `results/.locks/` | no         | One file per target while a run is in flight                                                                    |

**The ledgers are committed because they are facts about the software.** What a store refuses, what is held out of the verdict, and how far a selector has drifted are the same on every machine. Putting them under review means a check going permanently held-out shows up as a diff somebody has to approve, rather than as a quiet change on one laptop.

**The timings aren't.** A measurement is a fact about the machine that produced it. A laptop's history judging a CI runner's numbers reports a regression that's only a change of hardware. `baselines/*.measurements.json` is ignored for that reason.

**Nor is the notification state.** It records who has been told what, on this machine. A committed copy would let one person's channel decide whether another person's run says anything.

To make a run leave nothing behind at all:

```bash
drexbot run --target magento --no-record
```

It records nothing — not what wasn't green, not the timings, not which candidate found each thing, not which checks have been inconsistent — and says so in its own output, so a teaching run and a non-teaching one can never be mistaken for each other.

## The store baseline, key by key

`baselines/magento--<env>.store.json`, written by `drexbot baseline` and read by the checks. The `<env>` comes from `--env`, so pointing at two stores keeps two of these rather than one overwriting the other.

| Key                       | What it's                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `captured`                | `false` for the stand-in used before anyone has run `baseline`                                           |
| `capturedAt`              | When, or `never`                                                                                         |
| `baseUrl`                 | The store it was captured from                                                                           |
| `storeCode`, `currency`   | What the store calls itself                                                                              |
| `categoryPath`            | A category that actually has products in it, with the store's own URL suffix applied                     |
| `categoryProducts`        | How many it had                                                                                          |
| `searchTerm`              | A term this catalogue returns results for                                                                |
| `searchResults`           | How many it returned                                                                                     |
| `configurableProductPath` | A product with options, so the swatch checks have something to click. Absent when the catalogue has none |
| `simpleProductPath`       | A product without options                                                                                |

It's captured over GraphQL and reads only. The category is the one with the most products rather than the first, and the search term comes from a product the catalogue actually has — both because a guess that happens to work on one store is the thing that breaks on the next.

Until it exists, every check that needs a catalogue reports `blocked` and prints the command that would fix it.

## What is deliberately not configurable

**The selector profile.** It lives in `src/magento/selectors.ts` as 62 ordered lists, and it's code because a change to it belongs in review and in the drift ledger's history. Making it a config file would move the one thing that rots most into the one place nothing checks.

**Which verdicts are red.** `fail` and `blocked`, always. `degraded` is the only one you get a say in, through `--strict`, because whether a slow page is a failure is a policy question about your store. `flaky` and `quarantined` never turn a run red, because they are the harness telling you about itself.

**How many times a failed check is tried again.** The kernel decides that, from what kind of failure it was. The one exception in drexbot is the check that places an order, which is never tried twice — a timeout after an order is placed would otherwise be retried, and the second attempt would place a second order.
