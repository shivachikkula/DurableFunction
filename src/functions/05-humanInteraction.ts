/**
 * PATTERN 5 — HUMAN INTERACTION
 *
 * The orchestration sends an approval email containing approve/reject links, then
 * pauses on an external event. Clicking a link hits a webhook on this function app,
 * which raises the event and resumes the orchestration. A durable timer races the
 * event so the request escalates if nobody answers in time.
 *
 *   SendApprovalRequest ─► Task.any( waitForExternalEvent("ApprovalEvent"), timer(deadline) )
 *                                    │                                        │
 *                          approved / rejected                          ProcessEscalation
 *
 * Start:   POST /api/approvals   { "requestedBy": "jane", "description": "New laptop", "amount": 2400,
 *                                  "approverEmail": "manager@example.com", "timeoutMinutes": 60 }
 * Respond: GET  /api/approvals/{instanceId}/respond?decision=approve|reject&token=...   (link in the email)
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { app, HttpHandler, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import * as df from 'durable-functions';
import { OrchestrationContext, OrchestrationHandler, OrchestrationRuntimeStatus, Task, TimerTask } from 'durable-functions';

export const APPROVAL_EVENT = 'ApprovalEvent';

export interface ApprovalRequest {
    requestedBy: string;
    description: string;
    amount: number;
    approverEmail: string;
    timeoutMinutes?: number;
}

/** What the orchestrator receives: the request plus data the starter adds. */
export interface ApprovalOrchestrationInput extends ApprovalRequest {
    callbackBaseUrl: string;
    approvalToken: string;
}

export interface ApprovalDecision {
    approved: boolean;
    respondedAt: string;
}

export interface ApprovalOutcome {
    status: 'Approved' | 'Rejected' | 'Escalated';
    requestedBy: string;
    amount: number;
    decidedAt: string;
}

export const humanInteractionOrchestrator: OrchestrationHandler = function* (context: OrchestrationContext) {
    const input = context.df.getInput<ApprovalOrchestrationInput>();
    const instanceId = context.df.instanceId;

    yield context.df.callActivity('SendApprovalRequest', { ...input, instanceId });
    context.df.setCustomStatus('Waiting for approval');

    const deadline = new Date(context.df.currentUtcDateTime.getTime() + (input.timeoutMinutes ?? 60) * 60_000);
    const timeoutTask: TimerTask = context.df.createTimer(deadline);
    const approvalTask: Task = context.df.waitForExternalEvent(APPROVAL_EVENT);

    const winner: Task = yield context.df.Task.any([approvalTask, timeoutTask]);

    let outcome: ApprovalOutcome;
    if (winner === approvalTask) {
        // Cancel the pending timer so the orchestration can complete.
        timeoutTask.cancel();
        const decision = approvalTask.result as ApprovalDecision;
        outcome = {
            status: decision.approved ? 'Approved' : 'Rejected',
            requestedBy: input.requestedBy,
            amount: input.amount,
            decidedAt: decision.respondedAt,
        };
        yield context.df.callActivity('NotifyRequester', outcome);
    } else {
        outcome = {
            status: 'Escalated',
            requestedBy: input.requestedBy,
            amount: input.amount,
            decidedAt: context.df.currentUtcDateTime.toISOString(),
        };
        yield context.df.callActivity('ProcessEscalation', outcome);
    }

    context.df.setCustomStatus(outcome.status);
    return outcome;
};

df.app.orchestration('HumanInteractionOrchestrator', humanInteractionOrchestrator);

df.app.activity('SendApprovalRequest', {
    handler: (input: ApprovalOrchestrationInput & { instanceId: string }, context: InvocationContext): void => {
        const link = (decision: string) =>
            `${input.callbackBaseUrl}/api/approvals/${input.instanceId}/respond?decision=${decision}&token=${input.approvalToken}`;

        // A real app would send this through SendGrid / Graph / Communication Services.
        context.log(
            [
                `EMAIL to ${input.approverEmail}:`,
                `  ${input.requestedBy} requests approval for "${input.description}" (${input.amount}).`,
                `  Approve: ${link('approve')}`,
                `  Reject:  ${link('reject')}`,
            ].join('\n'),
        );
    },
});

df.app.activity('NotifyRequester', {
    handler: (outcome: ApprovalOutcome, context: InvocationContext): void => {
        context.log(`Request by ${outcome.requestedBy} for ${outcome.amount} was ${outcome.status}.`);
    },
});

df.app.activity('ProcessEscalation', {
    handler: (outcome: ApprovalOutcome, context: InvocationContext): void => {
        context.log(`No response in time; escalating request by ${outcome.requestedBy} for ${outcome.amount} to the next approver.`);
    },
});

// Starter: begins the approval workflow and returns the usual 202 + management URLs.
const startApproval: HttpHandler = async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const body = (await request.json().catch(() => null)) as ApprovalRequest | null;
    if (!body?.requestedBy || !body.approverEmail || typeof body.amount !== 'number') {
        return { status: 400, jsonBody: { error: "Body must include 'requestedBy', 'approverEmail' and numeric 'amount'." } };
    }

    const input: ApprovalOrchestrationInput = {
        ...body,
        callbackBaseUrl: new URL(request.url).origin,
        approvalToken: randomUUID(), // proves the responder received the email
    };

    const client = df.getClient(context);
    const instanceId = await client.startNew('HumanInteractionOrchestrator', { input });
    context.log(`Started approval workflow ${instanceId}`);
    return client.createCheckStatusResponse(request, instanceId);
};

app.http('StartApproval', {
    route: 'approvals',
    methods: ['POST'],
    authLevel: 'anonymous',
    extraInputs: [df.input.durableClient()],
    handler: startApproval,
});

// Webhook: the link in the email. Validates the token, then raises the external event.
const respondToApproval: HttpHandler = async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const instanceId = request.params.instanceId;
    const decision = request.query.get('decision');
    const token = request.query.get('token') ?? '';

    if (decision !== 'approve' && decision !== 'reject') {
        return { status: 400, body: "Query parameter 'decision' must be 'approve' or 'reject'." };
    }

    const client = df.getClient(context);
    const status = await client.getStatus(instanceId, { showInput: true });
    if (!status) {
        return { status: 404, body: 'Approval request not found.' };
    }

    const expected = Buffer.from((status.input as ApprovalOrchestrationInput).approvalToken);
    const actual = Buffer.from(token);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return { status: 403, body: 'Invalid approval token.' };
    }

    if (status.runtimeStatus !== OrchestrationRuntimeStatus.Running) {
        return { status: 409, body: `This request is no longer awaiting a decision (status: ${status.customStatus ?? status.runtimeStatus}).` };
    }

    const payload: ApprovalDecision = { approved: decision === 'approve', respondedAt: new Date().toISOString() };
    await client.raiseEvent(instanceId, APPROVAL_EVENT, payload);
    return { status: 200, body: `Thanks, your decision (${decision}) has been recorded.` };
};

app.http('RespondToApproval', {
    route: 'approvals/{instanceId}/respond',
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    extraInputs: [df.input.durableClient()],
    handler: respondToApproval,
});
