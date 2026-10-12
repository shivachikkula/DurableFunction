/**
 * PATTERN 4 — MONITOR
 *
 * A flexible, recurring polling loop that runs until a condition is met or it expires:
 *
 *   ┌──► CheckJobStatus ── Completed? ──yes──► SendAlert("completed") ─► done
 *   │                         │ no
 *   └── durable timer (wait) ◄┘        (expiry reached ─► SendAlert("timed out") ─► done)
 *
 * Unlike a fixed CRON timer trigger, each monitor instance has its own target, interval
 * and expiry, and stops itself when its condition is satisfied. Durable timers cost
 * nothing while waiting (the orchestrator is unloaded from memory).
 *
 * For very long-lived monitors, replace the while-loop with context.df.continueAsNew(...)
 * to keep the orchestration history small.
 *
 * Start: POST /api/orchestrators/MonitorOrchestrator
 *        { "jobId": "job-42", "pollingIntervalSeconds": 10, "expiryMinutes": 5 }
 */
import { InvocationContext } from '@azure/functions';
import * as df from 'durable-functions';
import { OrchestrationContext, OrchestrationHandler } from 'durable-functions';

export interface MonitorInput {
    jobId: string;
    pollingIntervalSeconds?: number;
    expiryMinutes?: number;
}

export type JobState = 'Queued' | 'Running' | 'Completed' | 'Failed';

export interface MonitorResult {
    jobId: string;
    finalState: JobState | 'TimedOut';
    checks: number;
}

export const monitorOrchestrator: OrchestrationHandler = function* (context: OrchestrationContext) {
    const input = context.df.getInput<MonitorInput>();
    const intervalSeconds = Math.max(input.pollingIntervalSeconds ?? 10, 1);
    const expiryTime = new Date(context.df.currentUtcDateTime.getTime() + (input.expiryMinutes ?? 5) * 60_000);

    let checks = 0;
    while (context.df.currentUtcDateTime < expiryTime) {
        const state: JobState = yield context.df.callActivity('CheckJobStatus', input.jobId);
        checks++;
        context.df.setCustomStatus({ jobId: input.jobId, lastState: state, checks });

        if (state === 'Completed' || state === 'Failed') {
            yield context.df.callActivity('SendAlert', `Job ${input.jobId} finished with state ${state}.`);
            const result: MonitorResult = { jobId: input.jobId, finalState: state, checks };
            return result;
        }

        // Sleep until the next poll. Must use a durable timer, never setTimeout.
        const nextCheck = new Date(context.df.currentUtcDateTime.getTime() + intervalSeconds * 1000);
        yield context.df.createTimer(nextCheck);
    }

    yield context.df.callActivity('SendAlert', `Monitoring of job ${input.jobId} timed out.`);
    const result: MonitorResult = { jobId: input.jobId, finalState: 'TimedOut', checks };
    return result;
};

df.app.orchestration('MonitorOrchestrator', monitorOrchestrator);

// Simulated external job: each job id completes ~30 seconds after it is first checked.
const firstSeen = new Map<string, number>();

df.app.activity('CheckJobStatus', {
    handler: (jobId: string, context: InvocationContext): JobState => {
        if (!firstSeen.has(jobId)) firstSeen.set(jobId, Date.now());
        const elapsed = Date.now() - firstSeen.get(jobId)!;
        const state: JobState = elapsed < 5_000 ? 'Queued' : elapsed < 30_000 ? 'Running' : 'Completed';
        context.log(`Job ${jobId} is ${state}`);
        return state;
    },
});

df.app.activity('SendAlert', {
    handler: (message: string, context: InvocationContext): void => {
        // A real app would send an SMS / Teams / email notification here.
        context.log(`ALERT: ${message}`);
    },
});
