# From nothing to a checked store

Part one gets you from an empty directory to a real verdict about a real storefront. It assumes you have never used a test harness and have never seen this one. Nothing you do in it can change the store you point at.

By the end you'll have run drexbot against a Magento store, you'll know what each word in its output means, and you'll know which of the things it writes down are worth keeping.

## Contents

**Part one, about fifteen minutes:**

- [What a harness is, and what this one isn't](#what-a-harness-is-and-what-this-one-isnt)
- [Step 0: get drexbot](#step-0-get-drexbot)
- [Step 1: prove the harness before you trust it](#step-1-prove-the-harness-before-you-trust-it)
- [Step 2: point it at a store](#step-2-point-it-at-a-store)
- [Step 3: ask the store what is in it](#step-3-ask-the-store-what-is-in-it)
- [Step 4: run it](#step-4-run-it)
- [Step 5: read what it said](#step-5-read-what-it-said)

**Part two, when one run isn't enough:**

- [The eight words a check can say](#the-eight-words-a-check-can-say)
- [Why a good run prints almost nothing](#why-a-good-run-prints-almost-nothing)
- [Letting it write to a store](#letting-it-write-to-a-store)
- [Running only what a change put at risk](#running-only-what-a-change-put-at-risk)
- [A check that can't make up its mind](#a-check-that-can't-make-up-its-mind)
- [Holding a check out of the verdict](#holding-a-check-out-of-the-verdict)
- [Telling somebody](#telling-somebody)
- [Running it on a schedule](#running-it-on-a-schedule)

**Part three, the rest of what is in there:**

- [The ledger that watches selectors rot](#the-ledger-that-watches-selectors-rot)
- [Checking whether it can drive your store at all](#checking-whether-it-can-drive-your-store-at-all)
- [The sign-off sheet](#the-sign-off-sheet)
- [Everything it writes, and where](#everything-it-writes-and-where)
- [Making a run faster, and what that costs](#making-a-run-faster-and-what-that-costs)
- [Adding a check of your own](#adding-a-check-of-your-own)
- [Where to go next](#where-to-go-next)

## What a harness is, and what this one isn't

Suppose your store went live this morning and you want to know whether it still works. You could open it and click around: search for something, open a product, add it to the cart, try to check out. That works, and it goes wrong in the ways clicking around goes wrong. You do it slightly differently each time, you stop when you get bored, and you have no record afterwards of what you actually looked at.

A harness is that same click-around, written down and repeatable. It has a list of things worth checking, it does each of them the same way every time, and it tells you which ones didn't do what they should.

drexbot is one of those, for a Magento storefront. **Forty checks across six groups.** Some are plain HTTP requests — is the home page really a home page, is the admin login form actually a login form. Eighteen of them drive a real browser, because a swatch that doesn't change the price isn't something an HTTP request can see.

Three things it deliberately isn't:

**It isn't a store you have to give it access to.** No database, no admin password, no shell on the server. Everything it does, it does over HTTPS as any visitor would. So you can point it at a store whose configuration isn't yours to fix, and it will still tell you something true.

**It isn't a thing that writes to your store.** Not by default. Two of its checks register a customer and place an order, and those refuse to run until you say, in so many words, that this particular store is one you don't mind writing to. More on that below.

**It isn't a load tester.** It measures how long things take and notices when a number moves further than it usually does, but one visitor at a time is all it ever is.

## Step 0: get drexbot

You need **Node 20.19 or newer**. It isn't on npm — you clone it.

```bash
git clone https://github.com/kingletas/drexbot && cd drexbot
```

```bash
make setup
```

This fetches the dependencies and the one browser it drives, Chromium. It downloads its own copy rather than using the browser you already have, so a check behaves the same on your laptop as it does anywhere else.

```bash
make install
```

This puts `drexbot` on your `PATH`, pointed back at this clone. There's only one copy of the code — edit it here and the command you type picks your change up.

```bash
drexbot help
```

> [!NOTE]
> One dependency comes from a git repository rather than from the npm registry, and **npm 12 refuses those by default**. If `make setup` stops with `EALLOWGIT`, either install with `npm ci --allow-git=all` or use npm 11, which Node 24 still ships. Nothing here sets that flag for you, because it would relax the rule for every dependency rather than the one that needs it.

## Step 1: prove the harness before you trust it

Before you point it at anything of yours, point it at itself.

```bash
drexbot selfcheck
```

It ships a small fake storefront and runs against that. Nothing leaves your machine.

```text
drexbot stub/local — selfcheck
  run 20260907T121437Z-07bb39b7   seed 07bb39b7   build stub-1

  n/a   selfcheck.browser-only
        target does not declare: browser

  6 checks — 5 pass, 1 unsupported
```

Those five lines are the whole output style.

**It printed one check out of six.** The five that passed aren't listed. Only the one with something to say got a line.

**The one it printed didn't fail.** It said `unsupported`, and then said why: the fake storefront doesn't offer a browser, so a check that needs one can't mean anything here. It isn't a pass and it isn't a failure. It's the harness declining to make a claim.

**The run has a name and a seed.** `20260907T121437Z-07bb39b7` is where this run's files went. The seed is the random choices it made — pass it back with `--seed` and it makes the same ones again.

If that worked, the harness works. Anything that goes wrong from here is about the store.

## Step 2: point it at a store

drexbot reads four environment variables. Only the first one usually matters.

```bash
export MAGENTO_URL=https://your-store.example
```

| Variable             | Default                | What it decides                                       |
| -------------------- | ---------------------- | ----------------------------------------------------- |
| `MAGENTO_URL`        | `https://vanilla.test` | The store to point at                                 |
| `MAGENTO_ADMIN_PATH` | `/admin`               | Where the admin lives, so it knocks on the right door |
| `MAGENTO_DISPOSABLE` | unset                  | `1`, and only `1`, allows the checks that write       |
| `MAGENTO_DIR`        | —                      | A checkout of the store's own code, for `--changed`   |

You can also pass the URL on the command line, which is the easier way to try one store once:

```bash
drexbot run --target magento --url https://your-store.example
```

**A word about HTTPS.** drexbot asks for an ordinary certificate, verified the ordinary way, and it never turns that off — a harness that skips TLS checks can't tell you anything about your TLS. If your development store uses a locally issued certificate, put the root in `NODE_EXTRA_CA_CERTS`; if you use mkcert, the wrapper finds it for you.

## Step 3: ask the store what is in it

This is the part that trips people up.

A check like "search finds something" needs a word to search for. A check like "the category page lists products" needs a category. Those are **facts about your catalogue**, not constants. Written into the harness they would pin it to one store forever, and the first person to point it somewhere else would get a page of failures that were really just a different catalogue.

So you capture them instead:

```bash
drexbot baseline --target magento
```

It asks the store over GraphQL, reads only, and writes down what it found:

```text
  https://your-store.example — store "default", USD
  category   /women/tops-women.html  (50 products)
  search     "tank"  (23 results)
  product    /breathe-easy-tank.html

  written to ./baselines/magento--local.store.json
```

It picks the category with the most products in it rather than the first one, takes a search term from a product the catalogue actually has, and prefers a product with options so the swatch checks have something to click.

**Until you run this, the checks that need a catalogue report `blocked` and print the command.** They don't fail and they don't quietly disappear from the sheet.

## Step 4: run it

```bash
drexbot run --target magento
```

Before it checks anything, it asks the store to identify itself, and refuses to go on if it can't. A run that can't say what it tested isn't evidence about anything.

Then it works through six groups of checks. You can run one at a time:

```bash
drexbot run --target magento --suite smoke
```

| Suite          | Checks | What it's                                                                                             |
| -------------- | -----: | ----------------------------------------------------------------------------------------------------- |
| `smoke`        |      6 | Plain requests. Is the home page a home page, does GraphQL answer                                     |
| `session-less` |     16 | What the store should refuse a stranger: the admin, the REST surface, files that must never be served |
| `journey`      |      3 | Search, open a product, add it to the cart — in a browser                                             |
| `regression`   |      6 | Tabs, swatches, the mini cart, quantity, compare, an empty result                                     |
| `depth`        |      7 | Sorting, pagination, filters, emptying the cart, registering, guest checkout, the wish list           |
| `checkout`     |      2 | The payment step, and an order actually placed                                                        |

The `--suite` flag takes a list: `--suite smoke,journey`.

## Step 5: read what it said

The output is short on purpose. If everything passed, you get a summary line and nothing else.

When something has gone wrong, you get the check, the verdict, and what happened. A failing browser check gives you three things: the candidates it tried, **what the page is saying to the shopper**, and what is actually visible on it. The list of selectors is the harness's problem; the store's own message is the half you can act on.

The exit code is the machine-readable half:

| Code | Means                                                                   |
| ---- | ----------------------------------------------------------------------- |
| `0`  | Nothing red                                                             |
| `1`  | A check failed, or the store couldn't be reached                        |
| `2`  | The command or its arguments were wrong                                 |
| `3`  | The run finished, and the channel it was meant to tell couldn't be told |

Every run also writes a directory under `results/`, named after the run:

- `journal.jsonl` — one line per thing that happened, in order
- `report.json` — the whole run, as a machine can read it
- `matrix.csv` and `matrix.json` — the sign-off sheet: which areas were covered, by what
- `artefacts/` — screenshots and page dumps a browser check kept

Add `--verbose` to see every check rather than only what changed, and `--matrix` to print the sign-off sheet at the end.

---

## The eight words a check can say

Most harnesses have two outcomes: it passed, or it failed. That isn't enough, and the missing cases all end up mislabelled as one of the two. drexbot has eight, and each one is a different statement.

| Verdict       | What it means                                                         |
| ------------- | --------------------------------------------------------------------- |
| `pass`        | It did what it should                                                 |
| `skipped`     | It wasn't chosen for this run                                         |
| `unsupported` | It can't mean anything against this store, and it names what it lacks |
| `quarantined` | You have held it out of the verdict on purpose                        |
| `flaky`       | Its recent history is inconsistent, so its answer isn't trustworthy   |
| `degraded`    | It passed, but slower than it usually is                              |
| `blocked`     | It couldn't get far enough to have an opinion                         |
| `fail`        | It didn't do what it should                                           |

**Only two of those turn the run red**: `fail` and `blocked`. `flaky` and `quarantined` are statements about the harness rather than about your store. `degraded` is a judgement call, so it's yours to make:

```bash
drexbot run --target magento --strict
```

With `--strict`, a measurement past its usual range fails the run.

**Only a pass is allowed to be silent.** Every other verdict has to carry a reason, and the harness won't let a check report one without.

## Why a good run prints almost nothing

A run that says nothing found nothing wrong. That's on purpose, and it's the thing everything else here is built to protect.

A check that talks when nothing is wrong teaches you to stop reading it. Then, when it finally has something real to say, you scroll past that too. A tool that prints forty green lines every morning is one you have stopped looking at by Thursday.

So it stays quiet while nothing is changing, and speaks up when something does.

## Letting it write to a store

Two checks write: one registers a customer, one places an order and then finds it again through Orders and Returns. Neither can undo what it did — nothing here can cancel an order or delete a customer.

So they fail closed. Until you say otherwise, they report `unsupported` and name what they lack:

```bash
export MAGENTO_DISPOSABLE=1
```

**Exactly `1`.** Not `true`, not `yes`. The value is meant to be typed on purpose rather than arrived at by accident, and a store you have to think about before naming is the point of the whole mechanism.

Set it only against a store you wouldn't mind putting a junk order in. Saying so has to be a deliberate act rather than a default, because nothing here can take an order back once it's placed.

The order is placed through the store's own Check / Money order method, and proved by finding it again rather than by reading the success page. A page that shows an order number is a page; an order you can look up afterwards is an order.

## Running only what a change put at risk

If you have the store's own code checked out somewhere, drexbot can look at a diff and work out which checks it puts at risk.

```bash
export MAGENTO_DIR=~/path/to/the/store
```

```bash
drexbot plan --target magento --changed
```

`plan` says what it would run and runs nothing. When you agree with it:

```bash
drexbot run --target magento --changed
```

By default it diffs against your uncommitted work. `--since main` diffs against a branch instead.

It works from a map: a change under `app/design/frontend/` reaches every storefront page, a change to a checkout or quote module reaches the cart and checkout, and so on. **The map is deliberately incomplete, and a path matching nothing falls back to running everything** — a narrowing rule that guesses wrong silently drops the checks that would have caught the thing.

If `MAGENTO_DIR` is unset it says so and runs everything, rather than narrowing a run from a diff of the wrong tree.

## A check that can't make up its mind

A check that passes, then fails, then passes again with nothing changing is worse than one that always fails. It teaches you to rerun until it goes green, and after a few weeks nobody believes any of them.

drexbot keeps a history and notices:

```bash
drexbot flakes --target magento
```

```text
  no check has an inconsistent history
```

A check it considers inconsistent reports `flaky`, which doesn't turn the run red — the harness is saying _I can't tell you anything reliable about this_, which isn't the same as saying your store is broken.

When you have fixed one and want to stop it being judged on its past:

```bash
drexbot flakes --forget magento.journey.search
```

## Holding a check out of the verdict

Sometimes you know a check is wrong and you can't fix it today. Put it aside explicitly rather than deleting it or letting it fail every morning:

```bash
drexbot quarantine add magento.depth.wishlist-holds-what-was-added
```

```bash
drexbot quarantine
```

A quarantined check still runs and still reports. It just doesn't turn the run red, and it appears in the list every time you ask, so it's a decision you keep making rather than one you made once and forgot.

The quarantine lives in `ledger/`, which is committed. That's on purpose: a check going permanently unsupported should show up as a diff somebody has to approve.

## Telling somebody

By default the harness tells nobody — it writes its files and exits, and the exit code is your signal.

To have it send a message, pick a channel:

```bash
export HARNESS_NOTIFY=webhook
export HARNESS_NOTIFY_WEBHOOK=https://chat.example/hooks/xxxx
```

Or mail:

```bash
export HARNESS_NOTIFY=mail
export HARNESS_NOTIFY_SMTP=127.0.0.1:1025
export HARNESS_NOTIFY_TO=you@example.com
```

`HARNESS_NOTIFY_FROM` defaults to `harness@localhost`.

Prove the channel before you rely on it:

```bash
drexbot notify --test
```

**It only sends when there's something to say**, and "something to say" is more careful than "something is red".

A run is boiled down to a story — this check, failing, for this reason. A story the channel hasn't carried is sent. A story it has already carried **backs off**: the wait doubles each time, up to thirty-two runs, so a failure lasting a month is said once a month rather than sixty times a day or never again after the first.

And a recovery has to **hold for two runs** before it's sent. A check that fails, passes once, and fails again hasn't recovered, and telling somebody it had would be worse than saying nothing.

Same idea as a quiet run, applied to the one part of this that can wake a person up.

Two flags for when you want to override it. `--no-notify` tells nobody whatever the environment says. `--notify` tells the channel even from a command that normally wouldn't, which is how `notify --test` works at all.

## Running it on a schedule

```bash
drexbot schedule plan --target magento
```

Will show you what you'd need to configure as a systemd timer, and writes nothing.

```bash
drexbot schedule install --target magento
```

This writes it but doesn't enable it — we defer enabling anything to you, with `systemctl`.

```bash
drexbot schedule report --days 7
```

This tells you what your schedules have actually been doing. That's a different question from whether a timer is enabled, and usually the more useful one.

While a run is in flight the harness holds a lock, so a schedule can't start a second run of the same target on top of the first.

---

## The ledger that watches selectors rot

A browser check has to find things on a page. Themes change, and the thing it looked for last month isn't there this month.

drexbot doesn't look for one selector. Each thing it needs — the search box, the add-to-cart button, the price — has a list of candidates it tries in order. **And it writes down which one answered.**

That record is `ledger/magento.drift.json`, and it's what makes the difference between a check that breaks one morning with no warning and one you saw coming. Something that used to be found by the first name on its list and is now found by the fourth hasn't failed. It has slipped, the run says so, and you have some months rather than some minutes.

The one to look at is anything found by the **last** name on its list. There's nothing after it.

## Checking whether it can drive your store at all

```bash
drexbot probe --target magento
```

The probe walks the whole journey and tells you what it could find, and which name on each list found it. **It judges nothing** — it exits 0 even when it finds nothing at all.

That's deliberate. A probe that failed would be a gate, and a gate isn't what you want the first time you point this at a store. Run it to find out whether the harness can drive the site, before you ask it for a verdict.

Against a store that isn't there, it says so and still exits 0:

```text
  magento — https://127.0.0.1:9999

  home  — not reached: page.goto: net::ERR_CONNECTION_REFUSED at https://127.0.0.1:9999/

  search results  — not reached: page.goto: net::ERR_CONNECTION_REFUSED at ...

  0 of 0 entries resolved
```

## The sign-off sheet

There are fourteen areas of a storefront the harness recognises — the home page, search, the category listing, the product page, the cart, the customer account, the admin, REST, GraphQL, files that must never be served, compare, checkout, the wish list, and admin workflows.

```bash
drexbot coverage
```

```text
  magento: admin-workflows is uncovered — needs admin credentials the adapter is not given,
  so it can only prove the door is shut
```

**The uncovered area prints its reason.** That's the whole point of declaring the areas separately from the checks: a gap that says nothing is indistinguishable from a gap nobody noticed. Thirteen of the fourteen are covered, and the fourteenth tells you why it isn't.

## Everything it writes, and where

Four directories, and they aren't all the same kind of thing.

| Directory         | Committed? | What is in it                                                                                                      |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| `ledger/`         | **Yes**    | What the store refuses, what is quarantined, the drift record. Facts about the software, the same on every machine |
| `baselines/`      | Partly     | What the store is, and what wasn't green last time, are committed; the **timings aren't**                          |
| `results/`        | No         | One directory per run: the journal, the report, the sheet, the screenshots                                         |
| `results/.locks/` | No         | One file per target while a run is in flight                                                                       |

**The timings are left out on purpose.** A measurement is a fact about the machine that took it. A laptop's history judging a CI runner's numbers reports a regression that's only a change of hardware.

When you want a run to leave nothing behind at all:

```bash
drexbot run --target magento --no-record
```

It records nothing — not what wasn't green, not the timings, not which candidate found each thing, not which checks have been inconsistent — and it says so in its own output, so a teaching run and a non-teaching one can never be mistaken for each other. It tells nobody either: an arranged experiment that pages a person is indistinguishable from a real failure.

## Making a run faster, and what that costs

```bash
drexbot run --target magento --workers 4
```

This lets four checks run at once. It's faster, but it won't judge or record any timings. A number taken while three other checks are hammering the same store isn't comparable with one taken on its own, so we'd rather say nothing than quietly record a slower number as a regression.

One at a time is the default for that reason.

## Adding a check of your own

The place to start isn't the check. It's the fake storefront in `fixtures/`.

Add the broken page first — the one showing the defect you want caught — and prove your new check fails against it. Then prove the healthy fixture keeps it passing. **One direction isn't a test**: a check that fires isn't evidence it can be quiet, and a check that's quiet isn't evidence it can fire.

Then the check itself goes in `src/magento/`, in the file for its suite: `checks.ts` for smoke and session-less, or `journeys.ts`, `regression.ts`, `depth.ts`, `checkout.ts`.

Three things worth knowing before you write one:

**Assert the consequence, not the confirmation.** A wish-list add is proved by waiting for the item, not for the banner that says it was added.

**A check that writes is never tried twice.** Otherwise a timeout after an order is placed gets retried, and the second attempt places a second order.

**Say what your check needs.** A check that needs a store it may write to says so, and reports `unsupported` naming what it's missing when it doesn't have one. It never fails because something wasn't available to it, and it never quietly disappears from the sheet.

```bash
make check
```

That's everything a commit has to pass: the build, the linter, the formatter and the tests.

## Where to go next

- [README](../README.md) — what it is, in one page
- [CONTRIBUTING.md](../CONTRIBUTING.md) — the shape a change should arrive in, and how a release is cut
- [SECURITY.md](../SECURITY.md) — the model, and where to report something
- [`harness-kernel`](https://github.com/kingletas/harness-kernel) — the run, the verdicts, the ledgers and the reporting all live there. drexbot is the Magento half: the adapter, the browser surface and its fixtures
