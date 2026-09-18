# Changelog

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
