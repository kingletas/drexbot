# User guide

Every command, every flag and every verdict, in plain words. If you are here to get a first run out of it, [Getting started](getting-started.md) is shorter.

## Contents

- [The commands](#the-commands)
- [The flags](#the-flags)
- [The eight verdicts](#the-eight-verdicts)
- [Reading a run](#reading-a-run)
- [The six suites](#the-six-suites)
- [The sign-off sheet](#the-sign-off-sheet)
- [Selector drift](#selector-drift)
- [Flaky checks](#flaky-checks)
- [Quarantine](#quarantine)
- [Running only what changed](#running-only-what-changed)
- [Notifications](#notifications)
- [Schedules](#schedules)
- [Exit codes](#exit-codes)
- [Things that surprise people](#things-that-surprise-people)

## The commands

| Command                             | What it does                                                    |
| ----------------------------------- | --------------------------------------------------------------- |
| `run --target magento`              | Run the checks and give a verdict                               |
| `baseline --target magento`         | Ask the store what is in it, and write it down                  |
| `probe --target magento`            | Report whether the suite could drive this site, judging nothing |
| `plan --target magento [--changed]` | Say what a run would do, and do none of it                      |
| `selfcheck`                         | Prove the harness against its own stub, with no store involved  |
| `targets`                           | List the targets and the suites each one offers                 |
| `coverage [--target magento]`       | Check the sign-off sheet against the checks that fill it        |
| `quarantine [add <id>]`             | List what is held out of the verdict, and put something there   |
| `flakes [--target magento]`         | Checks whose recent history is inconsistent                     |
| `flakes --forget <id>`              | Drop one check's history from the ledger                        |
| `notify --test`                     | Send one message, to prove the channel works                    |
| `schedule plan\|install\|report`    | The systemd units a schedule needs                              |
| `help`                              | The usage block                                                 |

`baseline` is the only command drexbot adds. Every other one belongs to `harness-kernel`, which is why they behave identically in any harness built on it.

## The flags

| Flag              | What it decides                                                |
| ----------------- | -------------------------------------------------------------- |
| `--target <name>` | Which target to ask. `magento` is the only one here            |
| `--suite <a,b>`   | Which suites to run. Default: all six                          |
| `--url <url>`     | The store to point at, overriding `MAGENTO_URL`                |
| `--env <name>`    | The environment label recorded on the run. Default `local`     |
| `--seed <value>`  | Replay the random choices an earlier run made                  |
| `--workers <n>`   | How many checks may be in flight at once. Default 1            |
| `--verbose`       | Report every check, not only what changed                      |
| `--matrix`        | Print the sign-off sheet after the run                         |
| `--strict`        | A timing well outside its usual range fails the run            |
| `--changed`       | Run only what a diff in the store's repository put at risk     |
| `--since <ref>`   | What to diff against. Default `HEAD`, meaning uncommitted work |
| `--no-record`     | Teach nothing, and tell nobody                                 |
| `--no-notify`     | Tell nobody, whatever `HARNESS_NOTIFY` says                    |
| `--notify`        | Tell the channel even from a command that normally wouldn't    |
| `--defect <name>` | `selfcheck` only: arrange a fault in the stub                  |

**`--env` isn't only a label.** The store baseline is kept per environment, as `baselines/magento--<env>.store.json`, so `--env staging` reads and writes a different one from the default `local`. Point at two stores and you keep two catalogues, rather than one overwriting the other.

**`--workers` above 1 neither judges timings nor records them.** A number taken while three other checks are hammering the same store isn't comparable with one taken alone, so the harness declines to pretend otherwise. One at a time is the default for that reason.

**`--no-record` implies `--no-notify`.** A run that teaches nothing tells nobody either: an arranged experiment that pages a person is indistinguishable from a real failure.

## The eight verdicts

Ordered least to most severe. A run's verdict is the worst one in it.

| Verdict       | It means                                                            | Red?                 |
| ------------- | ------------------------------------------------------------------- | -------------------- |
| `pass`        | It did what it should                                               |                      |
| `skipped`     | It wasn't selected for this run                                     |                      |
| `unsupported` | It can't mean anything here, and it names what it lacks             |                      |
| `quarantined` | You have held it out of the verdict on purpose                      |                      |
| `flaky`       | Its recent history is inconsistent, so its answer isn't trustworthy |                      |
| `degraded`    | It passed, slower than it usually is                                | only with `--strict` |
| `blocked`     | It couldn't get far enough to have an opinion                       | **yes**              |
| `fail`        | It didn't do what it should                                         | **yes**              |

**Only a pass may be silent.** Every other verdict has to carry a reason, and the harness refuses one that doesn't.

`flaky` and `quarantined` are statements about the suite rather than about the store, which is why neither turns a run red. If they did, the harness's own uncertainty would read as your store being broken.

## Reading a run

```text
drexbot magento/local — smoke, session-less, journey, regression, depth, checkout
  run 20260907T121437Z-07bb39b7   seed 07bb39b7   build 2.4.7-p3

  FAIL  magento.journey.add-to-cart
        assertion: could not find "addToCart" on the page. Tried, in order:
          - role=button[name=/add to cart/i]
          - button#product-addtocart-button
          - button.action.tocart
        The page is saying: The product is out of stock.
        What is visible and interactive: ...

  40 checks — 38 pass, 1 fail, 1 unsupported
```

The run id is also the directory it wrote. The seed replays it. The build is what the store said it was at preflight — a run that can't say what it tested isn't evidence about anything, so a store that won't identify itself stops the run before any check happens.

**A failing browser check tells you three things**: which candidates it tried, what the page is saying to the shopper, and what is actually visible and interactive on it. The list of selectors alone is the harness's problem; the store's own message is the half a person can act on, so the failure carries both rather than making you guess which kind of wrong it was.

Every run writes a directory under `results/`:

| File                        | What it's                                  |
| --------------------------- | ------------------------------------------ |
| `journal.jsonl`             | One line per thing that happened, in order |
| `report.json`               | The whole run, for a machine               |
| `matrix.csv`, `matrix.json` | The sign-off sheet                         |
| `artefacts/`                | Screenshots and page dumps a check kept    |

Artefacts are kept only where the verdict needs explaining. A passing check discards its own.

## The six suites

```bash
drexbot targets
```

| Suite          | Checks | Browser? | What it's                                                                                             |
| -------------- | -----: | -------- | ----------------------------------------------------------------------------------------------------- |
| `smoke`        |      6 | no       | Is the home page a home page, does GraphQL answer                                                     |
| `session-less` |     16 | no       | What the store should refuse a stranger: the admin, the REST surface, files that must never be served |
| `journey`      |      3 | yes      | Search, open a product, add it to the cart                                                            |
| `regression`   |      6 | yes      | Tabs, swatches, the mini cart, quantity, compare, an empty result                                     |
| `depth`        |      7 | yes      | Sorting, pagination, filters, emptying the cart, registering, guest checkout, the wish list           |
| `checkout`     |      2 | yes      | The payment step, and an order actually placed                                                        |

The two checks that write — registering a customer, placing an order — report `unsupported` until `MAGENTO_DISPOSABLE=1`. The one that places an order also refuses to retry: a timeout after an order is placed would otherwise be retried, and the second attempt places a second order.

**A browser check ends in a verdict, even when the page stops answering.** Each step has a bound: 30 seconds for a click or a navigation unless the check asks for longer, and 15 seconds for anything Playwright doesn't time out itself, like counting matches or closing the page. Behind those, each suite has a limit per attempt: 3 minutes for `journey` and `regression`, 10 for `depth` and `checkout`. A check that hits one fails as a `timeout`, keeps its trace, network log and video, and its reason names the step it was on.

## The sign-off sheet

Fourteen areas of a storefront: the home page, search, the category listing, the product page, the cart, the customer account, the admin, REST, GraphQL, files that must never be served, compare, checkout, the wish list, and admin workflows.

```bash
drexbot coverage
```

```text
  magento: admin-workflows is uncovered — needs admin credentials the adapter is not given,
  so it can only prove the door is shut
```

Thirteen are covered. The fourteenth prints its reason, which is the whole point of writing the list of areas separately from the checks: a gap that says nothing is indistinguishable from a gap nobody noticed.

The sheet is checked by the test suite. An area with no checks, or a check naming an area that doesn't exist, fails the build.

## Selector drift

Every element a browser check needs has an **ordered list** of ways to find it, most portable first — a role-based selector, then a Magento class, then a theme-specific one. Which candidate answered is written to `ledger/magento.drift.json`.

That record is what turns a surprise into a warning. Something that used to be found by the first name on its list and is now found by the fourth hasn't failed, and the run says so. **The one to look at is anything found by the last name on its list** — there's nothing after it.

Error banners are deliberately left out of it. They are only ever read when something has already failed, so something that turns up only on a bad day has no ordinary history to be compared against.

## Flaky checks

```bash
drexbot flakes --target magento
```

A check that passes, then fails, then passes again with nothing changing is worse than one that always fails: it teaches you to rerun until it goes green. The harness keeps a history and reports `flaky` when one is inconsistent.

A check that passes only on a retry is reported `flaky` for that run too, rather than as a pass. That's the one piece of evidence the run produced about the suite itself, and calling it green throws it away.

When you have fixed one:

```bash
drexbot flakes --forget magento.journey.search
```

## Quarantine

```bash
drexbot quarantine add magento.depth.wishlist-holds-what-was-added
```

```bash
drexbot quarantine
```

A quarantined check still runs and still reports. It doesn't turn the run red, and it appears every time you ask — so it stays a decision you keep making rather than one you made once and forgot.

The quarantine lives in `ledger/`, which is committed, so a check going permanently held-out shows up as a diff somebody has to approve.

## Running only what changed

Point drexbot at a checkout of the store's own code:

```bash
export MAGENTO_DIR=~/path/to/the/store
```

```bash
drexbot plan --target magento --changed
```

`plan` says what it would run and runs nothing. `run --changed` does it.

The narrowing works from a map of paths to areas: a change under `app/design/frontend/` reaches every storefront page, a change to a checkout or quote module reaches the cart and checkout. **The map is deliberately incomplete, and a path matching no rule falls back to running everything** — a narrowing rule that guesses wrong silently drops the checks that would have caught the thing.

With `MAGENTO_DIR` unset, `plan --changed` tells you there's no copy of the store's code to compare against, and reports that it would run everything.

## Notifications

By default the harness tells nobody. The exit code is the signal.

```bash
export HARNESS_NOTIFY=webhook
export HARNESS_NOTIFY_WEBHOOK=https://chat.example/hooks/xxxx
```

```bash
export HARNESS_NOTIFY=mail
export HARNESS_NOTIFY_SMTP=127.0.0.1:1025
export HARNESS_NOTIFY_TO=you@example.com
```

```bash
drexbot notify --test
```

**It sends when there's something to say, which is stricter than when something is red.** A run is boiled down to a story: this check, failing, for this reason.

A story the channel hasn't carried yet is sent. One it has already carried backs off — the wait doubles each time, up to thirty-two runs. So a failure that lasts a month is mentioned about once a month, rather than sixty times a day or never again after the first.

A recovery has to hold for two runs before it's sent. A check that fails, passes once and fails again hasn't recovered.

## Schedules

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

What your schedules have actually been doing. That's a different question from whether a timer is enabled, and usually the more useful one.

While a run is in flight it holds a lock under `results/.locks`, so a schedule can't start a second run of the same target on top of the first.

## Exit codes

| Code | Means                                                                      |
| ---- | -------------------------------------------------------------------------- |
| `0`  | Nothing red                                                                |
| `1`  | A check failed, or the store couldn't be reached                           |
| `2`  | The command or its arguments were wrong                                    |
| `3`  | The run finished and the channel couldn't be told. The verdict is above it |

`3` is worth its own code because the run is still valid. Losing the message isn't the same as losing the answer.

## Things that surprise people

**A green run prints almost nothing.** That's on purpose, not something missing. A tool that prints forty green lines every morning is one you scroll past by Thursday. Use `--verbose` when you want the full list.

**`unsupported` isn't a failure, and it isn't a skip either.** It's the harness declining to make a claim, and it always names what it would have needed.

**A dead store gives you one sentence, not forty.** After three failures to reach it with nothing getting through in between, the rest of the run reports `blocked` immediately rather than each check timing out on its own.

**The probe always exits 0.** Even when nothing resolves. It's the thing you run to find out whether a verdict is worth asking for.

**Timings aren't committed and the ledgers are.** A measurement is a fact about the machine that took it, so a laptop's history judging a CI runner's numbers would report a regression that's only a change of hardware. What the store refuses, what is quarantined and how selectors have drifted are facts about the software, identical everywhere, and those go under review.
