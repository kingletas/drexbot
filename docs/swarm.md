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

| Flag                                   | Default        | Meaning                                                         |
| -------------------------------------- | -------------- | --------------------------------------------------------------- |
| `--url`                                | `$MAGENTO_URL` | The store, which must be in `swarm-targets`                     |
| `--env`                                | `local`        | Whose store baseline to read                                    |
| `--on`                                 | `local`        | A bee host from `swarm-hosts`, or this machine                  |
| `--via`                                | `docker`       | `docker`, or `ecs` for tasks on a local ECS emulator            |
| `--seconds`                            | `60`           | Seconds of load; at least 10                                    |
| `--browser-bees`, `--browser-workers`  | `1`, `2`       | How many browser bees, and workers in each                      |
| `--browser-cpus`, `--browser-memory`   | `2`, `2g`      | Each browser bee's size                                         |
| `--protocol-bees`, `--protocol-users`  | `1`, `50`      | How many protocol bees, and k6 users in each                    |
| `--protocol-cpus`, `--protocol-memory` | `1`, `1g`      | Each protocol bee's size                                        |
| `--forward PORT=HOST:PORT`             | none           | A relay inside every bee; see [Where bees run](#where-bees-run) |

**The bees only read.** They ask for pages and nothing else: no form, no cart, no order. What a page view writes on the store (a session, a visitor row) is all a run leaves there.

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

## Where bees run

**This machine is the default,** with a budget of half its CPUs and half its memory. A run that doesn't fit is refused before it starts.

**Another machine is a line in `~/.config/drexbot/swarm-hosts`,** reached through Docker over SSH, so nothing on that machine listens on the network for this:

```text
# NAME  DOCKER_HOST  budget
bees  ssh://bees.example  cpus=4 memory=16g
```

The budget is required. It is the most the bees on that machine may take together, because the machine is somebody's and has other work to do. Then `--on bees`.

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

| Variable             | Meaning                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `BEE_RUN`, `BEE_ID`  | Which run this is, and which bee                                 |
| `BEE_URL`            | The store, as the store expects to be addressed                  |
| `BEE_PATHS`          | JSON list of `{stage, path}` to walk                             |
| `BEE_CONCURRENCY`    | Workers or users                                                 |
| `BEE_SECONDS`        | Seconds of load, counted once the bee is ready                   |
| `BEE_LIFETIME`       | Hard limit on the bee's life, enforced by its entrypoint         |
| `BEE_FORWARD`        | Optional `PORT=HOST:PORT` relays                                 |
| `BEE_WINDOW_SECONDS` | Browser bee: how often it writes a window of counts (default 10) |

A bee writes `started`, then `window` lines of per-stage counts and latency histograms, then `finished`. Windows add up, so a bee stopped early loses only its last one.

## What it does not do

- **It makes no network openings.** Reaching a store on another machine is set up by whoever owns that network.
- **It keeps no per-request detail.** Each bee writes counts and histograms, which is what makes a run of millions of requests collectable from container logs.
- **It judges nothing.** A record reports what happened; whether a p95 is acceptable is your call, made against the previous record.
