# Changelog

## Unreleased

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

Extracted from `houndbot`, where it was the Magento half of a harness that also
tested the Hound backend. The full history to that point is in that repository.

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
