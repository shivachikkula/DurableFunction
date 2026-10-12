import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { functionChainingOrchestrator, Order } from '../src/functions/01-functionChaining';
import { fanOutFanInOrchestrator, FanInSummary, FileResult } from '../src/functions/02-fanOutFanIn';
import { longRunningReportOrchestrator, Report } from '../src/functions/03-asyncHttpApi';
import { monitorOrchestrator, MonitorResult } from '../src/functions/04-monitor';
import { ApprovalOutcome, humanInteractionOrchestrator } from '../src/functions/05-humanInteraction';
import { FakeContext, FakeTask } from './fakeOrchestrationContext';

describe('Function chaining', () => {
    it('runs activities in order, passing each output to the next step', () => {
        const order: Order = { orderId: 'A-1', customerEmail: 'a@b.c', items: [{ sku: 'X', quantity: 2, unitPrice: 5 }] };
        const ctx = new FakeContext(order);
        const calls: string[] = [];

        const result = ctx.run(functionChainingOrchestrator, (task) => {
            assert.equal(task.kind, 'activity');
            if (task.kind !== 'activity') return;
            calls.push(task.name);
            const prev = task.input as Record<string, unknown>;
            switch (task.name) {
                case 'ValidateOrder':
                    assert.deepEqual(prev, order);
                    return { ...prev, total: 10 };
                case 'ReserveInventory':
                    assert.equal(prev.total, 10);
                    return { ...prev, reservationId: 'R1' };
                case 'ChargePayment':
                    assert.equal(prev.reservationId, 'R1');
                    return { ...prev, paymentId: 'P1' };
                case 'SendConfirmation':
                    assert.equal(prev.paymentId, 'P1');
                    return { orderId: 'A-1', total: 10, reservationId: 'R1', paymentId: 'P1', confirmationSentTo: 'a@b.c' };
            }
        });

        assert.deepEqual(calls, ['ValidateOrder', 'ReserveInventory', 'ChargePayment', 'SendConfirmation']);
        assert.deepEqual(result, { orderId: 'A-1', total: 10, reservationId: 'R1', paymentId: 'P1', confirmationSentTo: 'a@b.c' });
    });
});

describe('Fan-out / fan-in', () => {
    it('schedules one activity per file in a single Task.all and aggregates the results', () => {
        const ctx = new FakeContext({ folder: 'in', fileCount: 3 });
        const files = ['in/a', 'in/b', 'in/c'];
        const sizes: Record<string, number> = { 'in/a': 100, 'in/b': 300, 'in/c': 200 };

        const result = ctx.run(fanOutFanInOrchestrator, (task) => {
            if (task.kind === 'activity' && task.name === 'GetFilesToProcess') return files;
            assert.equal(task.kind, 'all');
            if (task.kind !== 'all') return;
            assert.equal(task.tasks.length, 3);
            return task.tasks.map((t): FileResult => {
                const file = (t as Extract<FakeTask, { kind: 'activity' }>).input as string;
                return { file, sizeBytes: sizes[file], lineCount: 1 };
            });
        }) as FanInSummary;

        assert.deepEqual(result, { folder: 'in', filesProcessed: 3, totalBytes: 600, totalLines: 3, largestFile: 'in/b' });
    });
});

describe('Async HTTP API (long-running report)', () => {
    it('reports progress through custom status and returns the report', () => {
        const ctx = new FakeContext({ reportName: 'Q3', sections: 2 });
        const progress: unknown[] = [];

        const result = ctx.run(longRunningReportOrchestrator, (task) => {
            progress.push(ctx.customStatus);
            const input = (task as Extract<FakeTask, { kind: 'activity' }>).input as { index: number };
            return `section ${input.index}`;
        }) as Report;

        assert.deepEqual(progress[1], { completedSections: 1, totalSections: 2, percentComplete: 50 });
        assert.deepEqual(ctx.customStatus, { completedSections: 2, totalSections: 2, percentComplete: 100 });
        assert.deepEqual(result.sections, ['section 1', 'section 2']);
        assert.equal(result.generatedAt, '2026-01-01T00:00:00.000Z');
    });
});

describe('Monitor', () => {
    it('polls on a durable timer until the job completes, then alerts', () => {
        const ctx = new FakeContext({ jobId: 'j1', pollingIntervalSeconds: 10, expiryMinutes: 5 });
        const states = ['Queued', 'Running', 'Completed'];
        let timers = 0;
        const alerts: string[] = [];

        const result = ctx.run(monitorOrchestrator, (task) => {
            if (task.kind === 'timer') return void timers++;
            if (task.kind === 'activity' && task.name === 'CheckJobStatus') return states.shift();
            if (task.kind === 'activity' && task.name === 'SendAlert') return void alerts.push(task.input as string);
        }) as MonitorResult;

        assert.deepEqual(result, { jobId: 'j1', finalState: 'Completed', checks: 3 });
        assert.equal(timers, 2);
        assert.equal(ctx.now.toISOString(), '2026-01-01T00:00:20.000Z');
        assert.match(alerts[0], /finished with state Completed/);
    });

    it('stops with TimedOut once the expiry passes', () => {
        const ctx = new FakeContext({ jobId: 'j2', pollingIntervalSeconds: 30, expiryMinutes: 1 });

        const result = ctx.run(monitorOrchestrator, (task) =>
            task.kind === 'activity' && task.name === 'CheckJobStatus' ? 'Running' : undefined,
        ) as MonitorResult;

        assert.deepEqual(result, { jobId: 'j2', finalState: 'TimedOut', checks: 2 });
    });
});

describe('Human interaction', () => {
    const input = {
        requestedBy: 'jane',
        description: 'Laptop',
        amount: 2400,
        approverEmail: 'boss@example.com',
        timeoutMinutes: 60,
        callbackBaseUrl: 'http://localhost:7071',
        approvalToken: 'tok',
    };

    it('resumes on the approval event and cancels the timeout timer', () => {
        const ctx = new FakeContext(input);
        const activities: string[] = [];

        const result = ctx.run(humanInteractionOrchestrator, (task) => {
            if (task.kind === 'activity') {
                activities.push(task.name);
                if (task.name === 'SendApprovalRequest') assert.equal((task.input as { instanceId: string }).instanceId, 'test-instance');
                return;
            }
            assert.equal(task.kind, 'any');
            if (task.kind !== 'any') return;
            const event = task.tasks.find((t) => t.kind === 'event')!;
            assert.equal((event as { name: string }).name, 'ApprovalEvent');
            event.result = { approved: true, respondedAt: '2026-01-01T00:10:00Z' };
            return event;
        }) as ApprovalOutcome;

        assert.equal(result.status, 'Approved');
        assert.deepEqual(activities, ['SendApprovalRequest', 'NotifyRequester']);
        const timer = ctx.scheduled.find((t) => t.kind === 'timer') as Extract<FakeTask, { kind: 'timer' }>;
        assert.equal(timer.isCancelled, true);
        assert.equal(timer.fireAt.toISOString(), '2026-01-01T01:00:00.000Z');
    });

    it('records a rejection', () => {
        const ctx = new FakeContext(input);
        const result = ctx.run(humanInteractionOrchestrator, (task) => {
            if (task.kind !== 'any') return;
            const event = task.tasks.find((t) => t.kind === 'event')!;
            event.result = { approved: false, respondedAt: 'now' };
            return event;
        }) as ApprovalOutcome;
        assert.equal(result.status, 'Rejected');
    });

    it('escalates when the timer wins', () => {
        const ctx = new FakeContext(input);
        const activities: string[] = [];

        const result = ctx.run(humanInteractionOrchestrator, (task) => {
            if (task.kind === 'activity') return void activities.push(task.name);
            if (task.kind === 'any') return task.tasks.find((t) => t.kind === 'timer');
        }) as ApprovalOutcome;

        assert.equal(result.status, 'Escalated');
        assert.deepEqual(activities, ['SendApprovalRequest', 'ProcessEscalation']);
    });
});
