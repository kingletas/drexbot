# Security

## What it is pointed at

This drives a storefront that belongs to somebody. Several of its checks are exposure checks — they ask whether `/app/etc/env.php` is served, whether the admin renders a dashboard to a caller with no session, whether REST resources answer without a token. Against a store you run, that is a health check. Against one you do not, it is unauthorised scanning.

**Point it only at a store you are authorised to test.** Nothing here enforces that, and nothing can.

## What it does to the store

**It writes nothing unless the environment says it may.** The checks that register a customer or place an order run only where `MAGENTO_DISPOSABLE=1` is set, and nothing else grants it — not a flag, not a suite, not a config file. Any other value, including `true`, refuses. Unset, those checks report `unsupported`, say what they are missing, and do not run. The default is refusal because nothing here can undo either act.

**When it is granted, the writes are real and permanent.** An order is placed through the store's own offline method — Check / Money order, which takes no money and touches no gateway — and **nothing removes it afterwards**. A registration leaves a customer account behind. Both use a nonce-derived identity under `@drexbot.test` so they are findable, not so they are reversible. A check that writes is never tried twice, so a timeout after the fact cannot place a second order.

**It reads nothing privileged.** No database connection, no admin credential, no shell into the stack, and nothing in it can open one. Everything it knows about a store it learned over HTTPS, which is why it can be pointed at one whose configuration is not yours to fix.

## What it leaves behind

**A run's artefacts carry whatever the store sent.** Traces, screenshots and HAR files from an authenticated journey contain session cookies and whatever was on the page, and nothing redacts them.

- `results/` is per-run and is **never committed** — the shipped `.gitignore` excludes it.
- **Do not attach a raw artefact to a public issue.** Attach the console output, which carries verdicts and reasons rather than payloads.

**The committed ledgers and baselines are deliberate, and they describe a catalogue.** `ledger/` records which selector candidate answered and which checks are quarantined; `baselines/*.store.json` records a category path, a search term and a product path. Those are facts about the software and about a demo catalogue, which is why they are under review rather than ignored. **A baseline captured from a store whose catalogue is not public is not something to commit** — check what is in it before it goes into a repository somebody else can read.

**It holds no credentials of its own.** No config file, no keyring. `MAGENTO_URL`, `MAGENTO_ADMIN_PATH`, `MAGENTO_DISPOSABLE` and `MAGENTO_DIR` are the whole of the store's half of its environment, and none of them is a secret.

**The notification channel is the exception, and it is the kernel's.** `HARNESS_NOTIFY_WEBHOOK` is an incoming-webhook URL, which is a credential: anything holding it can post to that channel. `HARNESS_NOTIFY_SMTP` may name an internal host. Neither is read unless you set `HARNESS_NOTIFY`, and neither belongs in a shell history, a CI log or a committed file. [`docs/configuration.md`](docs/configuration.md) has the full list.

## Reporting a vulnerability

Email **code@kingletas.com** with a description and, ideally, a stub defect that reproduces the issue — `fixtures/storefront-stub.ts` is the shape to copy. You will get an acknowledgment, a triage verdict, and, for confirmed issues, a fix accompanied by a regression test and a sweep for the rest of the defect's class.

The kernel underneath this has its own model: [harness-kernel/SECURITY.md](https://github.com/kingletas/harness-kernel/blob/main/SECURITY.md).
