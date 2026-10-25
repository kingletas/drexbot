# Swarm: load from bees in containers

`drexbot swarm` puts load on a store from **bees**: containers that each run one kind of load generator, started on this machine or on another one, for a fixed time. It blends two kinds, and that blend is the point:

| Bee      | What it is                                                    | What it costs            | What it tells you                                                                     |
| -------- | ------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| Browser  | Chromium walking the store's pages with a few workers         | A lot of CPU per shopper | What a shopper's browser saw: time to first byte, page load, largest contentful paint |
| Protocol | [k6](https://k6.io) users asking for the same pages over HTTP | Very little per user     | What the server does under volume                                                     |

A few browser bees beside many protocol users gives you realistic pages and real volume in one run, against one store, reported as one result. Scaling browser bees alone to high concurrency costs thousands of containers for nothing a protocol bee can't tell you.

Every run is recorded, compared with the last run of the same shape, and ends with its containers removed and the removal checked.

## Contents

- [Before the first run](#before-the-first-run)
- [A run](#a-run)
- [Reading the record](#reading-the-record)
- [A run that crosses a deploy](#a-run-that-crosses-a-deploy)
- [Finding the store's knee](#finding-the-stores-knee)
- [Where bees run](#where-bees-run)
- [Stopping, and what happens when something dies](#stopping-and-what-happens-when-something-dies)
- [How big a bee should be](#how-big-a-bee-should-be)
- [ECS, an emulator, and real AWS](#ecs-an-emulator-and-real-aws)
- [The bee contract](#the-bee-contract)
- [What it does not do](#what-it-does-not-do)

## Before the first run

**A swarm refuses every store until you name it.** List the stores that are yours to load, one origin per line, in `~/.config/drexbot/swarm-targets`:

```text
# Stores that are ours to load.
https://store.example
http://localhost:8080
```

The match is on the exact origin: scheme, host and port. A store that isn't listed is refused before anything starts, with the file to add it to.

**The bees walk the pages the store baseline names:** the home page, a category with products, a search that returns results, and a product. So capture the baseline first:

```bash
drexbot baseline --target magento --url https://store.example
```

**Build the two bee images** on the machine the bees will run on:

```bash
make build && drexbot swarm images
```

The browser image is Playwright's, about 2.5 GB; the protocol image is k6's, under 100 MB.

## A run

```bash
drexbot swarm run --url https://store.example --seconds 60 --browser-bees 1 --protocol-users 200
```

| Flag                                   | Default        | Meaning                                                                                   |
| -------------------------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| `--url`                                | `$MAGENTO_URL` | The store, which must be in `swarm-targets`                                               |
| `--env`                                | `local`        | Whose store baseline to read                                                              |
| `--on`                                 | `local`        | Bee hosts from `swarm-hosts`, comma-separated, or this machine                            |
| `--via`                                | `docker`       | `docker`, or `ecs` for tasks on a local ECS emulator                                      |
| `--seconds`                            | `60`           | Seconds of load; at least 10                                                              |
| `--browser-bees`, `--browser-workers`  | `1`, `2`       | How many browser bees, and workers in each                                                |
| `--browser-cpus`, `--browser-memory`   | `2`, `2g`      | Each browser bee's size                                                                   |
| `--protocol-bees`, `--protocol-users`  | `1`, `50`      | How many protocol bees, and k6 users in each                                              |
| `--protocol-cpus`, `--protocol-memory` | `1`, `1g`      | Each protocol bee's size                                                                  |
| `--forward PORT=HOST:PORT`             | none           | A relay inside every bee; see [Where bees run](#where-bees-run)                           |
| `--network NAME`                       | none           | With `--via docker`, start the bees on a Docker network the store is on                   |
| `--mix NAME`                           | `browse`       | What the browser or k6 shoppers do; see [Shoppers who check out](#shoppers-who-check-out) |
| `--sku SKU`                            | the baseline's | The simple product protocol bees add to carts over REST                                   |
| `--store-cpus N`                       | none           | The CPUs the store is capped at, so orders read per store CPU                             |
| `--deploy-ledger FILE`                 | none           | A deploy tool's audit log; see [Deploys](#a-run-that-crosses-a-deploy)                    |

**Without a mix the bees only read.** They ask for pages and nothing else: no form, no cart, no order. What a page view writes on the store (a session, a visitor row) is all a run leaves there.

## Shoppers who check out

**`--mix` makes each browser worker a stream of shoppers**, one new shopper per journey, each in a fresh browser so every cart starts empty. A shopper only browses (every page in `BEE_PATHS` once), adds the baseline's product to the cart and leaves, or checks out as a guest. Protocol bees draw from the same mix, over REST instead of a browser; see [Protocol bees that order](#protocol-bees-that-order).

| Mix               | Browse | Cart and leave | Order | Where the figures come from                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ------ | -------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browse`          | 100%   | 0              | 0     | The bee as it always was: pages in a loop, one long-lived browser per worker                                                                                                                                                                                                                                                                                                                                                                                  |
| `normal-day`      | 94.56% | 3.82%          | 1.62% | Orders: visitor-to-order conversion of 1.62%, IRP Commerce, the UK Fashion Clothing & Accessories market, September 2026, since a Luma store sells clothing ([market data](https://www.irpcommerce.com/en/gb/ecommercemarketdata.aspx?Market=3)). Carts: Baymard Institute's average cart abandonment of 70.22% across industries ([list](https://baymard.com/lists/cart-abandonment-rate)), so carts are orders / 0.2978 and the abandoned ones are the rest |
| `checkout-stress` | 60%    | 0              | 40%   | A chosen stress level, not a published figure                                                                                                                                                                                                                                                                                                                                                                                                                 |

**A mix that orders places real orders, so it needs `MAGENTO_DISPOSABLE=1`,** the same permission the checks that write need, and nothing else grants it. The bee refuses on its own as well, unless the plan handed it `BEE_DISPOSABLE=1`. Every order is a guest paying by Check / Money order, so no card number is ever typed; a store without that method fails the order at its last step. Each order takes one of the product's stock, and a store that runs out answers the add and keeps the cart empty, which shows as failed `cart` steps.

**A checkout is timed step by step,** each step from its first action to the store's answer:

| Step           | From                           | To                                                                                 |
| -------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| `cart`         | choosing the product's options | the store answering the add                                                        |
| `checkout`     | opening `/checkout/`           | the email field showing                                                            |
| `shipping`     | filling the address            | the store saving it and the payment step showing                                   |
| `place-order`  | choosing Check / Money order   | the store answering the order; choosing sends nothing, so it is timed with placing |
| `confirmation` | the store answering the order  | the success page showing                                                           |

**Capture the store's baseline first.** A run reads its product, pages and base URL from the baseline for `--env`, so a store nobody has baselined on this machine is refused with _no store baseline has been captured_:

```sh
drexbot baseline --target magento --url http://localhost:8080 --env shop
MAGENTO_DISPOSABLE=1 drexbot swarm run --env shop --url http://localhost:8080 --mix checkout-stress --protocol-bees 0 --seconds 180
```

At two workers a checkout takes about half a minute, so a run shorter than about three minutes may draw no order at all.

### Protocol bees that order

**A protocol bee's k6 user is a stream of shoppers too,** drawn from the same `--mix` with the same figures, held equal to `src/bee/mix.ts` by a test. A shopper who browses asks for every page in `BEE_PATHS` once; one who fills a cart, or checks out, does it over Magento's REST API as a guest, with no browser and no product page, so a protocol bee can hold the mix at a volume a browser bee cannot. Without a mix, or with `browse`, a user asks for one page per iteration exactly as before.

| Step (stage)        | Request                                                  | Notes                                                         |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| `cart-create`       | `POST /rest/V1/guest-carts`                              | Answers the new cart's id                                     |
| `cart`              | `POST /rest/V1/guest-carts/ID/items`                     | One of the SKU, from `--sku` or the baseline's simple product |
| `shipping-estimate` | `POST /rest/V1/guest-carts/ID/estimate-shipping-methods` | The first method it offers is the one chosen                  |
| `shipping`          | `POST /rest/V1/guest-carts/ID/shipping-information`      | An invented address in Austin; the chosen method              |
| `place-order`       | `POST /rest/V1/guest-carts/ID/payment-information`       | `checkmo` only, so no card number is ever sent                |

Each request is its own stage with its own counts and histograms, and `cart`, `shipping` and `place-order` carry the names the browser bee uses, so the record reads both kinds the same way. A step the store refuses stops that journey there and counts it failed; a store that offers no shipping method fails `shipping-estimate`. An order is counted as placed when `place-order` is served, since there is no success page to wait for. Whole journeys are `journey:browse`, `journey:cart` and `journey:order`, timed from the first request to the last.

**The gates are the browser bee's.** The plan refuses a protocol bee that would order unless `MAGENTO_DISPOSABLE=1`, the bee refuses to start unless the plan handed it `BEE_DISPOSABLE=1`, and the plan refuses a mix without a SKU for it to add. The baseline keeps the simple product's SKU from now on; a baseline captured before that needs capturing again, or `--sku`. Because the default run has a protocol bee, `--mix` now orders from it too; `--protocol-bees 0` keeps the orders to the browser bees. With both kinds the record prints a shoppers block for each.

**The record reads the shoppers as ratios:** the mix set beside the mix the run drew, how many journeys of each kind were served, each step's p50 and p95, the step that takes the largest share of the steps' p95 time, and orders per minute per store CPU when `--store-cpus` gives the store's cap. Never shoppers per minute, which says nothing about a store with other caps. A short run draws few journeys, so the mix drawn wanders from the mix set; both are printed so that is visible. An example, with made-up figures:

```text
  shoppers, mix normal-day: 100 journeys
    set     browse 94.56%   cart and leave 3.82%   order 1.62%
    drawn   browse 94.00%   cart and leave 3.00%   order 3.00%
    served  browse 94 of 94   cart and leave 3 of 3   order 3 of 3
  checkout steps, the whole step as the shopper waited for it:
    cart           p50 2465 ms   p95 3081 ms   0 of 6 failed
    ...
  gives first: checkout, 34.71% of the steps' p95 time
  orders placed: 3; give --store-cpus to read them per store CPU
```

A checkout journey is not started with less than a minute of load left, and a run with a mix gives each bee three minutes past its load instead of one, so a checkout begun near the end can finish.

## Reading the record

An example, with made-up figures:

```text
  20260101-120000-a1b2  https://store.example
  browser 1x2@2cpu, protocol 1x200@1cpu, 60s, local/docker
  compared with 20251231-120000-c3d4

  browser: 480 requests from 1 bee(s), 8/s  (+3%), 0 failed
  home ttfb          p50 38 ms  (-5%)   p95 87 ms  (same)   p99 108 ms
  home load          p50 1108 ms  (+2%)   p95 1732 ms  (same)   p99 2166 ms
  ...
  protocol: 190200 requests from 1 bee(s), 3170/s  (-1%), 0 failed
  ...
  the store, under both: 190680 requests, 0 failed (0.00%)
  time to first byte p50 23 ms   p95 136 ms   p99 212 ms

  teardown verified: 2 bee container(s) removed, none left
```

- **Two runs are compared only when their shape matches:** the same bees, sizes, length and host, against the same store. Anything else would be a different experiment.
- **Time to first byte is the one measure both kinds take the same way,** so "the store, under both" is what the server did under the whole load.
- **Percentiles are read from histograms every bee writes,** which add up exactly across bees. A reported value is the top of its bucket: never under the true figure, and at most a quarter over it.
- **A request still waiting when a bee's time runs out is not counted.** A store the bees can't reach therefore shows as zero requests, never as zero failures, and the record says so.
- Records are JSON under `results/swarm/`, which is not committed: a timing is a fact about the machines that produced it. `drexbot swarm records` lists them.

## A run that crosses a deploy

**`--deploy-ledger FILE` records the deploys that happened while the run loaded the store,** read from the deploy tool's own audit log, so a run that crosses a deploy can be read before, during and after it. `swarm run` and `swarm reconcile DIR` take it; without it nothing changes. The log is the append-only JSONL file `magento-deploy-playbook` writes, one record per line, each with `event`, `recorded_at` (UTC, to the second), `env_name` and `release`. drexbot only reads it: it does not verify the log's hash chain.

```sh
drexbot swarm run --url http://localhost:8080 --seconds 600 --deploy-ledger ./showcase.audit.jsonl
```

- **A deploy is kept when any part of it falls within 60 seconds of the run,** either side. The margin covers the one-second resolution of the log and some difference between the clocks. A deploy is one release's records from its `deploy.started` to the next `deploy.started` of that release, so a closing record a person appended late still belongs to it.
- **Each deploy is recorded** with its release, environment, outcome (`success`, `rolled_back`, `failed` or `not closed`), when it started and ended, and its phases (build, upload, cutover, setup:upgrade) where the log has them. **The maintenance window runs from `maintenance.enabled` to `maintenance.disabled`.** With no `maintenance.disabled` after it the window is recorded as **not closed**, because the store may still be in maintenance; a closing record written by hand is marked as such, since its time is when the person wrote it.
- **Every time is kept twice:** as the ledger wrote it, and as seconds from the run's start, negative before it. **Those are two clocks:** the ledger's is the deploy control node's and the run's is the machine drexbot runs on, so a skew between them shifts every offset by the same amount.
- **A line that does not parse is refused,** with its file and line number. `swarm run` checks the ledger before it starts anything, so a ledger it cannot read stops the run with exit code 2. A line written during the run that cannot be read is found afterwards: the run is still recorded, with the refusal in the record, and the command exits 1.
- **A ledger with no deploy in the window says so,** with how many records it read, so an empty answer is not mistaken for a ledger that was never read.

The deploys are printed under the store's line in the record. An example, with made-up figures:

```text
  deploys within the run, give or take 60s, from ./showcase.audit.jsonl (times are the control node's clock, seconds are from the run's start):
  deploy 20261101_1000000001_showcase on showcase: success, +50s to +110s, 60s (2026-11-01T12:00:50Z to 2026-11-01T12:01:50Z)
    maintenance window: +70s to +90s, 20s (2026-11-01T12:01:10Z to 2026-11-01T12:01:30Z)
    browser bees' windows around the deploy:
      before    5 windows  50 requests  0 failed (0.00%)  ttfb p95 102 ms
      during    6 windows  60 requests  20 failed (33.33%)  ttfb p95 3052 ms
      after     7 windows  70 requests  0 failed (0.00%)  ttfb p95 102 ms
    browser bees' windows around the maintenance window:
      ...
  protocol bees write one window for the whole run, so they are not split around a deploy
```

**The split uses the browser bees only.** A browser bee writes a window every 10 seconds (`BEE_WINDOW_SECONDS`), each with the time it was written. A window that ended before the deploy began is _before_, one that began after it ended is _after_, and any window that overlaps it is _during_, so the edges are as coarse as the window. The split is made twice when the deploy took a maintenance window: around the whole deploy, most of which the store serves normally, and around the window alone, which is where a store answers 503. The sides are different lengths, so read failures as a share and p95 as a time rather than comparing counts. **A protocol bee writes one window for the whole run** (k6 reports only at its end), so its requests cannot be placed before or after anything, and the record says so rather than guessing. A split for protocol bees needs interval windows from the protocol bee first.

## Finding the store's knee

**`drexbot swarm step` raises the load one run at a time until the store reaches its knee, and stops there, never at the break.** Each step is a whole run of protocol bees at the normal-day mix (`--mix` names another), recorded like any other. Users double from `--start` until a step goes bad, then the gap between the last good step and the first bad one is halved until it is no wider than a tenth of the last good step (`--resolution`). While each step runs, drexbot samples `docker stats` for every service of the store's Compose project (`--store-project`) and sets its CPU use against its own cap.

```sh
MAGENTO_DISPOSABLE=1 drexbot swarm step --url http://localhost:8080 --sku 24-MB01 \
  --store-project shop --seconds 120 --fpm-workers 5
```

- **A step is bad when more users stop buying more answers:** the store answered less than half as much extra as the extra users asked for, against the nearest good step with fewer users. It is also bad when the p95 of every request, or of the slowest checkout step, is twice the first step's, or when 1% of its requests fail. Twice, because the histograms bucket at 25% and one bucket up is noise. All of these are conventions, not measurements.
- **Start below saturation.** Latency is read against the first step, so a first step that already queues hides the knee: begin at one or two users (`--start`) unless you know the store.
- **A step where 5% of requests fail is the break,** and the test stops at once, whatever is left to try. So does a bad step that came while this machine's own load was at 75% of its cores or more, because then the knee may be the machine's rather than the store's, and a step whose bees' teardown was not verified.
- **The store must run inside caps of its own,** so it saturates on them: a CPU cap on each service, set in its Compose files. A service without a cap is sampled but cannot be read against one, and is left out of the ratios. A store with no capped service at all is refused before the first step, because its knee would only be a count of users.
- **The answer is ratios, with the caps beside them:** orders a minute per store CPU, per PHP CPU, and per PHP-FPM worker when `--fpm-workers` gives `pm.max_children`; requests a second per store CPU; and the service nearest its cap at the first bad step, which is the one that gives first. Users per step say how the load was set and nothing more: a count of shoppers means nothing for a store with other caps.
- **It places orders**, so it needs `MAGENTO_DISPOSABLE=1` like any mix that orders, and a SKU, from the baseline or `--sku`. `--most` (640) is the most users it will try before saying there is no knee.

An example, with made-up figures:

```text
  step test against http://localhost:8080, mix normal-day, 120s a step
    users  verdict  a second  p95       checkout p95  failed  busiest service            machine
    1      good     12.4      52 ms     331 ms        0.0%    php 21% of 2 CPU           8%
    2      good     24.1      56 ms     331 ms        0.0%    php 40% of 2 CPU           9%
    4      good     45.0      69 ms     414 ms        0.0%    php 77% of 2 CPU           11%
    8      knee     58.2      212 ms    1010 ms       0.0%    php 98% of 2 CPU           12%
    6      knee     52.0      135 ms    646 ms        0.0%    php 93% of 2 CPU           12%
    5      good     51.3      87 ms     517 ms        0.0%    php 88% of 2 CPU           11%

  the knee is between 5 and 6 users
  at the last good step: 3.10 orders a minute per store CPU, 10.85 per PHP CPU, 4.34 per PHP-FPM worker; 7.3 requests a second per store CPU
  gives first: php 93% of 2 CPU at the first bad step, php 88% of 2 CPU at the last good one
  the store's caps: db 1, php 2, web 0.5 CPU; 5 PHP-FPM workers
  the machine stayed under 75% load at every step, so the knee is the store's
```

**A day's load is then set as a fraction of the knee**, such as half of it for a normal day and nine tenths for a stress run, rather than as a number of users that only fits one store.

## Where bees run

**This machine is the default,** with a budget of half its CPUs and half its memory. A run that doesn't fit is refused before it starts.

**Another machine is a line in `~/.config/drexbot/swarm-hosts`,** reached through Docker over SSH, so nothing on that machine listens on the network for this:

```text
# NAME  DOCKER_HOST  budget
bees  ssh://bees.example  cpus=4 memory=16g
```

The budget is required. It is the most the bees on that machine may take together, because the machine is somebody's and has other work to do. Then `--on bees`.

**Several hosts make one run:** `--on local,bees` runs the whole shape on each, at once, and records them as one run whose shape names both. If a bee fails to start on one host, the others are stopped, and every host still tears down.

**A host's line can also name its route to the store,** because that is a fact about the host: `forward=8080=192.0.2.10:18080` for a relay, and `network=store_default` for a Docker network the store is on. A flag overrides the line for one run. `local` can have a line too, with `-` for its Docker host, to override this machine's budget or route.

**A store that answers only to its own address** (a store at `http://localhost:8080/` that redirects anything else there) can still be loaded from another machine: make it reachable at some address, and give every bee a relay with `--forward 8080=192.0.2.10:18080`. Each bee listens on its own `localhost:8080` and passes the connection on, so the store sees exactly the address it expects. How that address is made reachable is yours to decide, and deliberately not something this tool does.

## Stopping, and what happens when something dies

| What happens                     | What you get                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| The run ends                     | Every bee's lines collected, every container removed, the removal checked                                 |
| You press Ctrl-C                 | The same, straight away; the record says the run was stopped and how long it ran                          |
| A bee fails to start             | The bees already started are removed                                                                      |
| The conductor is killed outright | Each bee stops itself at its lifetime, and `drexbot swarm sweep --on HOST` removes the stopped containers |

**Every bee has a hard lifetime:** its seconds of load plus a minute, after which it is stopped whatever it is doing. No bee outlives its run by more than that, whether or not anything is left to stop it.

`drexbot swarm sweep` removes every bee container on a host, from any run, and exits non-zero if any is left.

## How big a bee should be

Measure it on your own store rather than guessing:

```bash
drexbot swarm measure --kind browser --url http://localhost:8080 --upstream store-web:80 --upstream-network store_default
```

`measure` puts a caching proxy in front of the store on the bee's machine, warms it with one browser bee, and then raises one bee's concurrency step by step while the cache answers, so the store is never the bottleneck. The sustained figure is the last step whose throughput still rose by 15%. `--upstream-network` joins the proxy to a Docker network the store is on, so a store running on the same machine is reached container to container, with no port opened.

What measuring a Luma storefront showed us, which the defaults follow:

- **A browser bee needs two CPUs.** With one, Chromium's own processes starve each other, and throughput fell to a fifth of what two CPUs gave. Beyond one to three workers, more workers per bee only made pages slower.
- **A protocol bee needs 1 GiB for a few hundred users.** With 512 MiB, k6 was killed at 400 users and wrote nothing; with 1 GiB it ran them.

## ECS, an emulator, and real AWS

**`--via ecs` starts every bee as an ECS task on a local emulator** such as MiniStack, named by `DREXBOT_ECS_ENDPOINT`:

```bash
DREXBOT_ECS_ENDPOINT=http://127.0.0.1:4566 drexbot swarm run --via ecs --url http://localhost:8080
```

**The client refuses any endpoint that isn't this machine or its Docker bridge,** before a byte is sent, and signs nothing. It can't reach AWS. Two things an emulator doesn't do that ECS does, and what the swarm does about them:

- **It ignores a task's CPU and memory.** Each bee is capped in Docker the moment its container appears, as ECS would have done at start. For that moment, under a second, the bee runs uncapped.
- **It leaves a task's container behind when the task is gone.** Teardown is checked in Docker, never by asking the emulator.

**For real AWS, `drexbot swarm aws` prints the run as commands** for somebody allowed to run them: the ECR pushes, the cluster, one Fargate task definition and `run-task` per bee, and the list and stop commands that prove nothing is left billing. Every block is one command and says what it creates or destroys. Nothing is run. Once the bees' lines are downloaded, `drexbot swarm reconcile DIR` turns them into a record. **This path has not yet been run against AWS; we need more testing.**

## The bee contract

A bee is any image that reads these variables and writes the `bee/1` lines. Standard output is the one channel every place a bee can run hands back.

| Variable             | Meaning                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `BEE_RUN`, `BEE_ID`  | Which run this is, and which bee                                   |
| `BEE_URL`            | The store, as the store expects to be addressed                    |
| `BEE_PATHS`          | JSON list of `{stage, path}` to walk                               |
| `BEE_CONCURRENCY`    | Workers or users                                                   |
| `BEE_SECONDS`        | Seconds of load, counted once the bee is ready                     |
| `BEE_LIFETIME`       | Hard limit on the bee's life, enforced by its entrypoint           |
| `BEE_FORWARD`        | Optional `PORT=HOST:PORT` relays                                   |
| `BEE_WINDOW_SECONDS` | Browser bee: how often it writes a window of counts (default 10)   |
| `BEE_MIX`            | Either kind: `browse` (default), `normal-day` or `checkout-stress` |
| `BEE_CART_PATH`      | Browser bee: the product a cart or order journey buys              |
| `BEE_CART_SKU`       | Protocol bee: the simple product a cart or order journey adds      |
| `BEE_DISPOSABLE`     | Either kind: `1`, and only `1`, lets a mix place orders            |

A bee writes `started`, then `window` lines of per-stage counts and latency histograms, then `finished`. Windows add up, so a bee stopped early loses only its last one. A stage named `journey:browse`, `journey:cart` or `journey:order` counts whole shoppers, one per journey, and is kept out of every request count and rate.

## What it does not do

- **It makes no network openings.** Reaching a store on another machine is set up by whoever owns that network.
- **It keeps no per-request detail.** Each bee writes counts and histograms, which is what makes a run of millions of requests collectable from container logs.
- **It judges nothing.** A record reports what happened; whether a p95 is acceptable is your call, made against the previous record.
