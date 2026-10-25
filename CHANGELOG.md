# Changelog

## Unreleased

**`drexbot swarm run --orders N --per DURATION` places orders at a set rate.** One protocol bee places N guest orders in every DURATION (`60s`, `5m`, `1h`; at least 10 seconds), evenly, so a store can be given a steady stream of orders rather than a share of shoppers at whatever pace the users run. k6 starts each order on schedule whether or not the last one has finished, and sizes its users from the rate: those that stay busy when an order takes a minute, and twice as many before it drops one. The orders are the REST checkout the mixes already use, so the record reads them the same way, and one more line sets the orders asked for (N times the run's seconds over DURATION, rounded down) beside those started, placed, failed and dropped; dropped orders are the ones k6 had no free user to start, so a slow store does not read as one that was asked for less. It needs `MAGENTO_DISPOSABLE=1` and a SKU, and is refused beside `--mix` or `--protocol-users`, with browser bees or more than one protocol bee, with a DURATION under 10 seconds, with only one of the two flags, and for a run too short to be asked for an order. Runs at different rates are not compared with each other. Without the flags nothing changes.

**A showcase store can have customers ordering all day with no one starting runs.** `drexbot swarm shop` is one run at the rate the time of day calls for: 25 orders a slice inside a local-time night window that holds the daily deploy (`--night 01:00-05:00`, which may cross midnight) and 5 a slice the rest of the day, over five minutes by default, started through the same code path as `swarm run` with `--orders` and `--per`. A user timer starts it every five minutes, and each run's record is one slice. `contrib/systemd/` holds the timer, the service and an example environment file as templates; nothing installs them, and the timer has `Persistent=false` so a slice missed while the machine was off is not caught up. The next morning `drexbot swarm day DATE --deploy-ledger FILE` places the runs during each deploy in the deploy tool's audit log, and those in an equal span before and after it (`--around`, two hours by default, so the two compare like with like), and prints for each band the runs, the orders asked and placed, the failed requests, and the highest of the runs' checkout p95s, which is labelled so because a record keeps percentiles and not histograms. It also writes the report as JSON under `results/swarm/day/`, so what a deploy costs the customers in it can be read from the data.

**`drexbot swarm run --of-knee 0.5` sets a run's load as a share of the store's knee.** A step test that ends on the store's own limit now writes its knee beside the run records, and `--of-knee F` runs protocol bees at F of that knee's last good step, rounded down, for the store and the mix it was measured at (`--knee-mix`, normal-day unless named). A store is its origin, as `swarm-targets` reads it, so `http://shop.test/` finds the knee measured at `http://shop.test`. The run's record says the fraction, which step test it came from, when and under which caps. A run with no knee for its store, a fraction that is not a number or is outside 0 to 1, a share under one user, or users or a rate of orders given beside it is refused before anything starts, each with its own sentence: a missing knee names the `swarm step` command for the mix the run asked for, and a fraction that is not a number is quoted as it was typed.

**`drexbot swarm step` finds a store's knee and stops there.** It runs protocol bees at the normal-day mix one step at a time, doubling the users until a step goes bad, then halving the gap between the last good step and the first bad one. A step is bad when more users stop buying more answers (less than half the extra throughput they asked for), when the p95 of every request or of checkout doubles, or when 1% of requests fail; 5% failed is the break and ends the test at once, and so does a bad step on a busy machine, since that knee may be the machine's. While each step runs it samples the store's Compose services against their own CPU caps, and the answer is ratios with the caps beside them: orders a minute per store CPU, per PHP CPU and per PHP-FPM worker, requests a second per store CPU, and the service nearest its cap when the store gave.

**Protocol bees can check out too, so the mix holds at volume.** With `--mix normal-day` or `--mix checkout-stress`, each k6 user draws a shopper from the same mix as a browser worker, with the same figures, and a shopper who orders does it as a guest over Magento's REST API: create a cart, add the product by SKU, estimate shipping and take the first method, save the address, and place the order paid by Check / Money order, never a card. Each request is a stage of its own in the bee's lines, `cart`, `shipping` and `place-order` under the names the browser bee uses and `cart-create` and `shipping-estimate` new, so the record prints the same shoppers and checkout steps for a run whose orders came from k6. The gates are the browser bee's: `MAGENTO_DISPOSABLE=1` at the plan and `BEE_DISPOSABLE=1` in the bee. The store baseline now keeps the simple product's SKU, and `--sku` names another; a protocol bee that would order with neither is refused at the plan. The default run has a protocol bee, so `--mix` now orders from it as well; `--protocol-bees 0` keeps the orders to the browser bees. Without a mix the bees browse exactly as before.

**A run that crosses a deploy now says when the deploy and its maintenance window happened.** `drexbot swarm run --deploy-ledger FILE` reads a deploy tool's audit log (the JSONL `magento-deploy-playbook` writes) and records each deploy that fell within 60 seconds of the run: the release, the environment, the outcome, when it started and ended, its phases, and the maintenance window from `maintenance.enabled` to `maintenance.disabled`, each time as the ledger wrote it and as seconds from the run's start. A window with no `maintenance.disabled` is recorded as not closed rather than guessed at. The browser bees' interval windows are split into before, during and after the deploy and its maintenance window, as requests, failures and p95; protocol bees write one window for the whole run, so they are not split. A ledger line that does not parse stops a run before it starts, or is named in the record afterwards with the run's numbers kept. `swarm reconcile DIR --deploy-ledger FILE` does the same for an AWS run, and without the flag nothing changes.

**An add to cart the store refused now says why.** A store out of a variant's stock still answers the add with 200 and then serves an empty cart, so the checkout checks failed with only _the cart it then served holds no row_. They now quote what the cart page tells the shopper, such as _Not enough items for sale_, the same way a missing element already does.

**Browser bees can check out, in a mix you set.** `drexbot swarm run --mix normal-day` makes each browser worker a stream of new shoppers, most browsing, some adding to the cart and leaving, and some placing a guest order paid by Check / Money order, with each step timed: cart, checkout, shipping, placing the order and the confirmation. `normal-day` uses published figures, a visitor-to-order conversion of 1.62% (IRP Commerce, the UK clothing market, September 2026) and an average cart abandonment of 70.22% (Baymard Institute); `checkout-stress` sends 40% of shoppers to an order. A mix that orders needs `MAGENTO_DISPOSABLE=1`, and the bee refuses on its own without `BEE_DISPOSABLE=1` from the plan. The record reads the shoppers as ratios: the mix set beside the mix drawn, each step's time, the step that gives first, and orders per store CPU when `--store-cpus` names the store's cap. Without `--mix` the bees browse exactly as before.

**A checkout that stays on the shipping step after "Next" now says what the store said.** Luma keeps the payment step in the page, hidden, from the moment checkout opens, so the wait after "Next" found that hidden copy and then waited for it to appear: 150 seconds, ending in _waiting for locator('#checkout-step-payment') to be visible_ and nothing about why. The wait now accepts only a payment step that is shown, so a stall fails through the same path as any missing element, quoting the page's messages, such as Luma's _The shipping method is missing. Select the shipping method and try again._ It also gives up after 120 seconds rather than 150.

**`make install` works again over a launcher that is read-only.** The launcher was written with a shell redirect, which cannot write into a read-only file, so once a tool manager had locked the installed copy every later install failed with _Permission denied_. It is now put in place with `install(1)`, which replaces the file rather than writing into it.

## 0.2.0

**`drexbot swarm` puts load on a store from bees in containers, and blends two kinds.** A browser bee is Chromium walking the store's pages with a few workers; a protocol bee is k6 users asking for the same pages over plain HTTP. A few of the first beside many of the second gives realistic pages and real volume in one run, reported as one result: per stage and per kind, and time to first byte for the store under both. Both read the pages from the store baseline, and both only read. Bees run on this machine or, through Docker over SSH, on another one listed in `~/.config/drexbot/swarm-hosts` with a budget the run has to fit. No store is loaded unless its origin is in `~/.config/drexbot/swarm-targets`, and none is by default.

**One run can span several machines.** `--on local,bees` runs the whole shape on each host at once and records them as one run; if one host cannot start a bee, the others are stopped and every host still tears down. A host's line in `swarm-hosts` can name its own route to the store, a relay or a Docker network, so a store that answers only to its own address can be loaded from anywhere.

**Every run is recorded and compared.** A record goes to `results/swarm/` and is set beside the last run of the same shape against the same store, with the change in throughput and latency. Percentiles come from histograms every bee writes, which add up exactly across bees.

**Every run ends with its containers removed, and the removal checked.** That holds when the run ends, when it is stopped with Ctrl-C, and when a bee fails to start. Every bee also stops itself at a hard lifetime, so a conductor killed outright leaves stopped containers at worst, and `drexbot swarm sweep` removes those.

**`--via ecs` starts the bees as ECS tasks on a local emulator, and `drexbot swarm aws` prints the same run for AWS.** The ECS client refuses any endpoint that is not this machine, so it cannot reach AWS. It caps each container itself, and checks teardown in Docker, because an emulator ignores a task's limits and leaves its containers behind. The AWS path is printed as commands, one per block, each saying what it creates or destroys, and has not been run against AWS; we need more testing.

**`drexbot swarm measure` finds how much load one bee of a given size drives,** against a caching proxy in front of the store so the store is never the bottleneck. On a Luma storefront it showed that a browser bee needs two CPUs and a protocol bee 1 GiB for a few hundred users, and those are the defaults.

## 0.1.6

**A preflight the store answers with something other than 200 now says what could be wrong.** A run against a store whose `/magento_version` answered 404 blocked all six suites on one line, _https://store.test/magento_version answered 404_, and gave nobody anything to act on. The status now arrives with the reply's content type, whether the body looks like an HTML error page, and a candidate cause when the answer carries one to name. An HTML error page with Magento's own markup in it says the store answered and does not serve this route, which is what a headless or route-narrowed storefront does, and what a base URL missing a store-code prefix does. An HTML error page without that markup says something in front of the store can produce it, either a cache or proxy answering before Magento sees the path or a front end that is not this store, and names what terminates TLS as the thing to check. A 404 carrying nothing to attribute it to still gets the status, the content type and the body, and no hint: a store that is simply absent is not evidence of anything else. A redirect names the address it points at, since redirects are here requested and never followed. A 401, a 403, a 503 and a gateway status each name what produces them. The block itself is unchanged, and a run that cannot say what it tested still runs nothing.

**A clone no longer inherits another machine's run history.** The drift and flake ledgers were tracked, so every checkout arrived carrying the selector winners and per-check outcomes of the runs that wrote them — one person's store and one person's machine deciding which selector a fresh clone treats as settled and which checks it calls flaky. Both are ignored now, and each clone builds them from its own runs. The quarantine ledger beside them is still committed, because holding a check out of the verdict is a decision rather than a run, and so are the state signatures under `baselines/`.

## 0.1.5

**A certificate the browser won't accept says what to do about it.** A store can pass preflight and still fail every browser check with `ERR_CERT_AUTHORITY_INVALID`, because Chromium keeps its own list of trusted certificates and never reads `NODE_EXTRA_CA_CERTS`. That read as `transport`, so it was retried, tripped the circuit breaker, and took the checks behind it down as unreachable: 3 failed, 12 blocked, and nothing on the page said what was wrong. The navigation that opens a check now blocks on a refused certificate instead, with the fix in the reason — for a local store, the `certutil` line that imports the root into `~/.pki/nssdb`; for a public one, that the chain it serves doesn't reach a root Chromium trusts. A hostname mismatch, an expired certificate and a revoked one are named as they are, with no root suggested, because trusting a root fixes none of them. The same goes for the two trust decisions Chromium doesn't spell `ERR_CERT_`: a certificate missing from a transparency log, and a store asking for a client certificate. Nothing else about a navigation failure changes: a refused connection is still `transport` and still retried.

## 0.1.4

**Browser checks go to the store named by `--url`.** A check opened its first page at `--url`, then built every later address (the cart, checkout, the wishlist, the guest order lookup) from the URL saved in the store baseline. A run with `--url https://prod.test` and a baseline captured from `https://vanilla.test` added to cart on one store and went to checkout on the other, and failed there with a certificate error. Every address now comes from `--url`. A baseline captured from a different URL is set aside, because its category and product paths belong to that store, and the checks that need it report `blocked`: _the store baseline for "local" was captured from https://vanilla.test, not https://prod.test — run: drexbot baseline --target magento --url https://prod.test --env local_. With no baseline at all, the command they name now carries the run's URL and environment too.

## 0.1.3

**Checkout no longer waits three minutes for an email field that is already showing.** Waiting for an entry watched the first element any of its candidates matched in page order, whether or not a shopper could see it. On a Luma checkout that is the hidden email input in the sign-in popup, so every checkout waited out its full 180 seconds before moving on, and a slow store pushed checks such as `magento.checkout.payment-step-offers-a-method` past their time limit with _could not find "checkoutEmail"_. The wait now ends as soon as any candidate is visible, and candidates are still tried in their listed order. Opening checkout to checking the email now takes about 5 seconds instead of about 215.

**A browser that cannot start is a setup problem, and says which.** When Chromium couldn't load a system library, every browser check failed as `transport` with a page of browser logs as its reason. Three of those tripped the circuit breaker, so HTTP checks later in the run were blocked as if the store were down. It is now `blocked` with a one-sentence reason that names the fix: _Chromium cannot start because this machine is missing a system library (libnspr4.so) it needs. On Debian or Ubuntu, including WSL, run `make browser-deps`…_. It is never retried, doesn't count towards the circuit breaker, and the report shows it once with a count of the rest. A Chromium that was never installed names the path Playwright looked in and says to run `make setup`. Any other launch failure is still `transport`, with its full log.

**`drexbot probe` says why it couldn't run.** When Chromium couldn't start, the probe crashed with a stack trace. It now prints one line with the same fix a run gives, and exits 1. This needs harness-kernel `8d8bb6a`, which drexbot now pins.

**`make setup` proves the browser starts.** It used to download Chromium and stop, so a machine without Chromium's system libraries found out on its first run. It now builds, installs Chromium and runs `drexbot browser`, which starts Chromium once and exits non-zero with the same fix when it can't. `make browser-deps` installs the libraries. It asks for sudo, so `make setup` never runs it on its own.

**A store Node won't trust says so.** Preflight against a store whose certificate Node doesn't trust used to block with only _fetch failed_. It now names the certificate error. On a local store (`localhost`, a loopback address, or a name ending in `.test`, `.localhost` or `.local`) it also names the fix: _GET …/magento_version: fetch failed (DEPTH_ZERO_SELF_SIGNED_CERT: self-signed certificate). Node ignores the certificates this machine trusts, so set NODE_EXTRA_CA_CERTS…_. When that variable is already set, the message names the file and says it doesn't give Node that root. On any other store, trusting a root would hide a real fault, so a missing issuer is reported as a probable missing intermediate certificate, and a chain ending in an unknown root says to trust a root only if a proxy that inspects TLS is in the way. An expired certificate, a hostname mismatch or a refused connection is named with no hint. This needs the harness-kernel change that keeps the cause of an HTTP failure, which drexbot now pins.

**The wrapper finds more roots.** Warden and Den sign each local site's certificate with a root they create on install. curl accepts it, but Node doesn't use the system's trusted certificates, so a Warden store failed preflight. The wrapper now looks for those roots, following `WARDEN_HOME_DIR` and `DEN_HOME_DIR`. For mkcert it also follows `CAROOT`, `XDG_DATA_HOME` and the macOS location. The same certificate found in two places counts once. Node reads only one extra certificate file, so several different roots are joined into `$XDG_CACHE_HOME/drexbot/extra-ca.pem`, in a folder only you can write to. If that can't be written, the first root is used and the run goes ahead. A `NODE_EXTRA_CA_CERTS` you set yourself is still left alone.

**`magento.depth.guest-checkout-reaches-payment` no longer fails a healthy checkout.** On a fresh Mage-OS 3.5 (Magento 2.4.9) store with Luma, the payment step is in the page from the moment checkout opens, hidden until shipping is answered. The check asked whether the step was there, not whether it was showing, so it failed with _the payment step was showing before shipping was answered_. A check can now ask `present(entry, { visible: true })`, which answers only with a candidate the shopper can see, and this check does. Every other entry resolves as it did, and a hidden element never records a winner in the drift ledger.

**A browser check can no longer hang the run.** Against a store in developer mode, `magento.journey.product-page` opened a product while the category page was still loading its scripts, and then never finished closing its browser context. Playwright writes the network log before it closes the page, and that write waited for responses the navigation had cut off, which only give up when the page closes. The run sat there with no new line in its journal until somebody killed it. Pages are now closed before their context, and the check finishes in about three seconds.

**Every browser step has a bound.** Clicks and navigations get 30 seconds unless a check asks for longer, stated rather than inherited. Calls Playwright never times out itself (counting matches, reading the page, saving the trace, closing) get 15 seconds, and fail as a `timeout` that names the step: _counting "pageTitle" (h1) timed out after 15s_.

**Each browser suite has a time limit behind that.** 3 minutes an attempt for `journey` and `regression`, 10 for `depth` and `checkout`. At the limit the check's browser context is closed, its trace, network log and video are kept, and the reason names the last step it started. This needs harness-kernel `971da9a`, which adds the limit.

## 0.1.2

**The wrapper works through a symlink now.** It worked out where `dist/` was from
the path it was invoked by, so anything reaching it through a link looked for the
CLI beside the link and died with a module it couldn't find. It follows the link
chain first. `make install` was never affected — it writes its own wrapper — so
this only ever bit someone who symlinked the entry point themselves.

**`package.json` no longer claims a `bin`.** It advertised a `drexbot` command
that an install could not deliver: the published tarball carries no `dist/` and
there's no build step to make one, so the command would have pointed at code that
was never there. The way to get drexbot is still the way the README says — clone
it, then `make install` — and that path never read the field.

## 0.1.1

Documentation only. Nothing about how it behaves has changed, and 0.1.0 remains a
correct release of the same code.

**Five guides, under `docs/`.** `from-nothing.md` takes you from never having used
a test harness to a real verdict about a real store. `getting-started.md` is the
ten-minute version for anyone who already knows what one is. `user-guide.md` covers
every command, flag and verdict. `configuration.md` covers the environment it reads
and the files it keeps, and why some of those are committed and some are not.
`architecture.md` sets out where the line falls between the kernel and this adapter,
and what happens to one check.

**Three things the existing pages had wrong.** A failing browser check carries the
page's own message alongside the candidates it tried, rather than instead of them.
`--changed` is what narrows a run from a diff; `--since` only says what to compare
against. And `HARNESS_NOTIFY_WEBHOOK` is a credential — anything holding it can post
to that channel — where SECURITY.md had said the harness holds none.

## 0.1.0

The first release, and the first one anybody else can install.

Extracted from a private harness, where it was the Magento half of a package
that also tested an internal backend. The full history to that point is in that
repository.

It stands alone because it asks a store for nothing but HTTPS: none of its 40
checks needs a database, a credential or a shell into the stack, so it can be
pointed at any storefront it can reach.
[`harness-kernel`](https://github.com/kingletas/harness-kernel) is a dependency
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
