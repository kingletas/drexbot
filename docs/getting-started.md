# Getting started

Ten minutes, and the last three of them are optional. If you have never used a test harness, read [From nothing to a checked store](from-nothing.md) instead — it covers the same ground and explains the ideas on the way past.

## Contents

- [Try it without a store](#try-it-without-a-store)
- [Install](#install)
- [Point it at your store](#point-it-at-your-store)
- [Capture the catalogue](#capture-the-catalogue)
- [Run it](#run-it)
- [Let it write](#let-it-write)
- [In CI, and on a schedule](#in-ci-and-on-a-schedule)

## Try it without a store

The package ships a small storefront it serves itself.

```bash
drexbot selfcheck
```

Nothing leaves the machine. It's the quickest way to see the output style, which is that a passing check prints nothing at all.

```bash
drexbot selfcheck --defect session-less-read
```

This puts a specific fault into the stub on purpose, so you can see what a real one looks like. The other four are `none`, `intermittent`, `slow` and `refuses-connections`.

## Install

Node 20.19 or newer.

```bash
git clone https://github.com/kingletas/drexbot && cd drexbot
```

```bash
make setup
```

Dependencies, plus the Chromium that Playwright drives. It fetches its own rather than using the browser you have, so a check behaves the same here as it does anywhere else.

```bash
make install
```

This writes a wrapper into `~/bin` that points back at this clone. There's only one copy of the code — edit it here and the command picks your change up.

> [!NOTE]
> One dependency comes from a git repository rather than the npm registry, and **npm 12 refuses those by default**. If `make setup` stops with `EALLOWGIT`, install with `npm ci --allow-git=all` or use npm 11, which Node 24 still ships. Nothing here sets that flag for you, because it would relax the rule for every dependency rather than the one that needs it.

## Point it at your store

```bash
export MAGENTO_URL=https://your-store.example
```

Or per command, with `--url`. If the admin isn't at `/admin`, set `MAGENTO_ADMIN_PATH` too, so the session-less checks knock on the right door.

drexbot verifies TLS the ordinary way and never turns that off. For a development store on a locally issued certificate, put the root in `NODE_EXTRA_CA_CERTS` — the wrapper finds a mkcert root on its own.

Before asking for a verdict, ask whether the suite can even drive the site:

```bash
drexbot probe --target magento
```

The probe tells you what it could find, and which name on each list found it. It **judges nothing** — it exits 0 even when it finds nothing. A probe that failed would be a gate, and a gate isn't what you run first.

## Capture the catalogue

A category path and a search term are facts about your store, not constants. Capture them once:

```bash
drexbot baseline --target magento
```

Read-only, over GraphQL. It picks the category with the most products, takes a search term from a product the catalogue actually has, and prefers a product with options so the swatch checks have something to click. Until you run it, the checks that need a catalogue report `blocked` and print this command.

## Run it

```bash
drexbot run --target magento
```

Six suites, forty checks. Narrow it with `--suite`:

```bash
drexbot run --target magento --suite smoke,session-less
```

Silence means nothing is wrong. `--verbose` reports every check rather than only what changed; `--matrix` prints the sign-off sheet at the end. Exit code `0` is nothing red, `1` is a failure or an unreachable store, `2` is a bad command, `3` is a finished run whose notification couldn't be delivered.

## Let it write

Two checks register a customer and place an order, and nothing here can undo either. They report `unsupported` until you name the store as one you don't mind writing to:

```bash
export MAGENTO_DISPOSABLE=1
```

Exactly `1`. Not `true`, not `yes`.

## In CI, and on a schedule

For CI, the exit code is all you need. Add `--no-record` so the build agent teaches the ledgers nothing — a machine that runs the suite once and is then thrown away has no history worth keeping:

```bash
drexbot run --target magento --no-record
```

For a machine that stays, the schedule is systemd units:

```bash
drexbot schedule plan --target magento
```

```bash
drexbot schedule install --target magento
```

`install` writes it but doesn't enable it — we defer enabling anything to you, with `systemctl`.

To have a run tell somebody, pick a channel and prove it before relying on it:

```bash
export HARNESS_NOTIFY=webhook
export HARNESS_NOTIFY_WEBHOOK=https://chat.example/hooks/xxxx
```

```bash
drexbot notify --test
```

Every variable, and every file the harness keeps, is in [configuration.md](configuration.md). Every command and flag is in the [user guide](user-guide.md).
