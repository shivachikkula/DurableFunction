# DurableFunction

An Azure Durable Functions app (Node.js 22, TypeScript, Functions v4 programming model,
`durable-functions` v3) that implements the five primary orchestration patterns in one
function app. Each pattern is self-contained in one file under `src/functions/`.

| # | Pattern | File | Start it with |
|---|---------|------|---------------|
| 1 | Function chaining | `01-functionChaining.ts` | `POST /api/orchestrators/FunctionChainingOrchestrator` |
| 2 | Fan-out / fan-in | `02-fanOutFanIn.ts` | `POST /api/orchestrators/FanOutFanInOrchestrator` |
| 3 | Async HTTP API | `03-asyncHttpApi.ts` (+ `httpStart.ts`) | `POST /api/reports`, then `GET /api/reports/{id}/status` |
| 4 | Monitor | `04-monitor.ts` | `POST /api/orchestrators/MonitorOrchestrator` |
| 5 | Human interaction | `05-humanInteraction.ts` | `POST /api/approvals`, then the emailed link |

Sample payloads for every endpoint are in [`requests.http`](requests.http).

## Running locally

Prerequisites: Node.js 20+, [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local),
and [Azurite](https://learn.microsoft.com/azure/storage/common/storage-use-azurite) (the storage emulator Durable Functions uses for state).

```bash
npm install
cp local.settings.example.json local.settings.json
azurite --silent --location .azurite &   # or start Azurite from VS Code
npm start                                # builds, then runs `func start`
```

Run the orchestrator unit tests (no host or emulator needed):

```bash
npm test
```

The tests in `test/` drive each orchestrator generator with a fake orchestration context,
checking call order, parallel scheduling, timers, external events and timeouts.

---

## The patterns

### 1. Function chaining

Runs activities in a fixed order; each step's output is the next step's input.

```
ValidateOrder ──► ReserveInventory ──► ChargePayment ──► SendConfirmation
```

```ts
const validated = yield context.df.callActivity('ValidateOrder', order);
const reserved  = yield context.df.callActivity('ReserveInventory', validated);
const paid      = yield context.df.callActivityWithRetry('ChargePayment', new df.RetryOptions(5000, 3), reserved);
return yield context.df.callActivity('SendConfirmation', paid);
```

Key points:
- Every `yield` is a checkpoint. After a crash or restart the orchestrator **replays** from
  its history and does not run completed activities again.
- `callActivityWithRetry` adds declarative retries for transient failures.
- Orchestrator code must be **deterministic**: no `new Date()`, `Math.random()`, I/O or
  `setTimeout`. Use `context.df.currentUtcDateTime` and activities instead.

### 2. Fan-out / fan-in

Runs many activities in parallel, then waits for all of them and aggregates.

```
                     ┌─► ProcessFile(a) ─┐
GetFilesToProcess ───┼─► ProcessFile(b) ─┼──► sum / max
                     └─► ProcessFile(n) ─┘
```

```ts
const files = yield context.df.callActivity('GetFilesToProcess', input);
const tasks = files.map((f) => context.df.callActivity('ProcessFile', f)); // fan-out: no yield yet
const results = yield context.df.Task.all(tasks);                          // fan-in
```

Key points:
- Create all the tasks **before** yielding; yielding inside the loop would serialize them.
- The work is spread across all instances of the app, so it scales out.
- If any task fails, `Task.all` throws, and you can catch the error in the orchestrator.
  For very large fan-outs, batch the work or use sub-orchestrations.

### 3. Async HTTP API

Coordinates a long-running operation with an HTTP client without holding a connection open.

```
Client ── POST /api/reports ─────────────► 202 Accepted, Location: /api/reports/{id}/status
Client ── GET  /api/reports/{id}/status ─► 202 + Retry-After + progress   (still running)
Client ── GET  /api/reports/{id}/status ─► 200 + result                   (completed)
```

Two versions are included:
- **Built-in** (`httpStart.ts`): `client.createCheckStatusResponse(request, instanceId)`
  returns 202 with `statusQueryGetUri`, `sendEventPostUri`, `terminatePostUri`, `purgeHistoryDeleteUri`, etc.
  Add `?wait=10` to use `waitForCompletionOrCreateCheckStatusResponse`, which returns 200 directly
  if the orchestration finishes within 10 seconds.
- **Hand-rolled** (`03-asyncHttpApi.ts`): a custom starter and a status endpoint that
  maps `runtimeStatus` to 202/200/500 and exposes progress written with `context.df.setCustomStatus`.

### 4. Monitor

A polling loop with its own interval and expiry that ends as soon as its condition is met.

```ts
const expiry = addMinutes(context.df.currentUtcDateTime, input.expiryMinutes);
while (context.df.currentUtcDateTime < expiry) {
    const state = yield context.df.callActivity('CheckJobStatus', input.jobId);
    if (state === 'Completed' || state === 'Failed') { /* alert and return */ }
    yield context.df.createTimer(addSeconds(context.df.currentUtcDateTime, interval)); // durable sleep
}
// timed out
```

Key points:
- `createTimer` is a **durable timer**. The orchestration is unloaded while it waits, so
  waiting costs nothing and survives restarts. Never use `setTimeout` in an orchestrator.
- Unlike a CRON timer trigger, each instance has its own target, interval and expiry, and stops itself.
- For monitors that run indefinitely, use `context.df.continueAsNew(state)` instead of a `while`
  loop so the history stays small.

### 5. Human interaction

Pauses the workflow until a person responds, with a timeout that escalates the request.

```
SendApprovalRequest (email with approve / reject links)
        │
        ▼
Task.any([ waitForExternalEvent('ApprovalEvent'), createTimer(deadline) ])
        │ event wins                       │ timer wins
        ▼                                  ▼
NotifyRequester (Approved/Rejected)   ProcessEscalation
```

```ts
const timeout  = context.df.createTimer(deadline);
const approval = context.df.waitForExternalEvent('ApprovalEvent');
const winner   = yield context.df.Task.any([approval, timeout]);
if (winner === approval) { timeout.cancel(); /* use approval.result */ } else { /* escalate */ }
```

The link in the email calls the `RespondToApproval` webhook
(`GET /api/approvals/{instanceId}/respond?decision=approve&token=...`). The webhook checks the
per-request token, then calls `client.raiseEvent(instanceId, 'ApprovalEvent', { approved })`
to resume the orchestration. Locally, the "email" (with clickable links) is written to the `func` log.

Key points:
- Always **cancel the timer** when the event wins. Otherwise the orchestration stays running until the timer fires.
- Events can also be raised through the built-in `sendEventPostUri` from the 202 response.
- In production, consider a confirmation page behind the GET link (mail scanners can prefetch
  links) and `authLevel: 'function'` or signed URLs on the webhook.

---

## Project layout

```
host.json                     Durable Task hub settings, extension bundle
src/functions/httpStart.ts    Generic HTTP starter (any orchestrator by name)
src/functions/01-…05-*.ts     One file per pattern: orchestrator + activities (+ HTTP triggers)
test/                         Orchestrator unit tests using a fake context
requests.http                 Sample requests for every endpoint
```

## Deploying

```bash
npm run build
func azure functionapp publish <your-function-app-name>
```

The function app needs a storage account (`AzureWebJobsStorage`), which Durable Functions uses
for its queues and history tables. The HTTP triggers use `authLevel: 'anonymous'` so they are
easy to try locally; switch to `function` before exposing the app publicly.
