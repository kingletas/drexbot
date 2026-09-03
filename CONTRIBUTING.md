# Contributing

Thanks for looking. This drives somebody else's storefront, and most of the constraints below come from that one fact rather than from taste.

## The three promises

Every change is measured against these first:

1. **It asks the store for nothing but HTTPS.** No database, no credential, no shell into the stack. The adapter declares `canReadDatabase: false` and means it. A check that needs privileged access belongs behind a capability the target does not currently have, reporting `unsupported` — not behind a connection string in a config file.
2. **It writes nothing unless the environment says it may.** `MAGENTO_DISPOSABLE=1` is the only thing that grants it, nothing here can undo a registration or an order, and the default is refusal. A change that lets a suite decide its own disposability is a security change, and will be treated as one.
3. **A failure names something the operator can act on.** The store may be one whose configuration is not yours to fix, so a failing check repeats the store's own error banner rather than reporting a selector nobody can find.

A pull request that relaxes one of these needs to argue the case in an issue first — it will usually be a no.

## Setting up

Node 20.19 or newer.

```bash
make setup
```

That installs the dependencies and the one browser the journeys drive.

## Running the checks

```bash
make check
```

The build, eslint, prettier and the unit suite, and exactly what the pre-commit hook runs. It needs no store: the suite runs against `fixtures/storefront-stub.ts`, a server that can be told to carry a specific defect, and asserts that each defect is caught **and** that a healthy store produces no failures.

Against a real store, start here rather than with a run:

```bash
drexbot probe --target magento
```

The probe walks the whole journey, reports which selector entries resolved and via which candidate, and judges nothing — it exits 0 even when nothing resolves, because a probe that failed would be a gate, and a gate is not what you run first.

## The ideas worth knowing before you write

- **A selector is an ordered candidate list, never one selector.** Semantic and ARIA first, the Magento convention next, the theme's own class last. Which candidate answered is recorded in `ledger/magento.drift.json`, so an entry falling toward the bottom of its list is visible before it stops resolving at all. Adding a selector means adding to a list in `src/magento/selectors.ts`, in that order.
- **A catalogue fact is not a constant.** A category path, a search term, a product with options — written into the source, they pin the harness to one store. They are captured by `drexbot baseline` into `baselines/`, and a check that needs one reports `blocked` and names the command until it exists.
- **Assert the consequence, not the confirmation.** Placing an order is proved by finding it again through Orders and Returns, not by the success page: a page that names an order number is a page. A wish-list add waits for the item, not for the banner.
- **A check that writes carries `retry: NO_RETRY`.** A timeout after an order is placed would otherwise be retried, and the second attempt places a second order.
- **The verdict vocabulary is the kernel's**, and it is eight values rather than two. A check that cannot mean anything against this store reports `unsupported` and names the capability it lacks. It never fails, and it is never silently absent from the sign-off sheet.
- **Comments say what the code does or what it guards against**, in a sentence or two. History belongs in the commit message and the changelog.

## How the code is arranged

- `src/magento/` — the adapter and its checks, split by suite: `checks.ts` (smoke and session-less), `journeys.ts`, `regression.ts`, `depth.ts`, `checkout.ts`. Plus `selectors.ts`, `areas.ts`, `impact.ts` and `baseline.ts`.
- `src/surfaces/browser.ts` — the browser surface and the candidate resolution the drift ledger records.
- `src/cli/` — `main.ts` hands a harness to the kernel's `runCli`; `commands/baseline.ts` is the one command the shared set does not have.
- `fixtures/` — the storefront stub and its theme pages. A new defect class goes here first.
- `tests/` — run against the stub, never against a live store.

Everything else — the run, the verdicts, the ledgers, the worker pool, the reporting — belongs to [`harness-kernel`](https://github.com/kingletas/harness-kernel) and changes there.

## Sending a change

- One concern per pull request, with the reasoning in the description.
- `make check` green.
- A new check arrives with a stub defect that makes it fail, and evidence that the healthy stub keeps it passing. One direction is not a test.
- Update `CHANGELOG.md` under a new heading, in the voice of the entries already there: what changed for someone using it, not what the diff did.

## Security

Please do not open a public issue for a vulnerability. [SECURITY.md](SECURITY.md) has the model and the reporting route.
