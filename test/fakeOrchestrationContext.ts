/**
 * Minimal stand-in for the Durable Functions orchestration context so orchestrator
 * generators can be unit tested without the Functions host or a storage emulator.
 */
import { OrchestrationContext, OrchestrationHandler } from 'durable-functions';

export type FakeTask =
    | { kind: 'activity'; name: string; input: unknown; result?: unknown }
    | { kind: 'timer'; fireAt: Date; isCancelled: boolean; cancel(): void; result?: unknown }
    | { kind: 'event'; name: string; result?: unknown }
    | { kind: 'all'; tasks: FakeTask[] }
    | { kind: 'any'; tasks: FakeTask[] };

export class FakeContext {
    now: Date;
    customStatus: unknown;
    readonly scheduled: FakeTask[] = [];

    constructor(
        private readonly input: unknown,
        start = new Date('2026-01-01T00:00:00Z'),
        readonly instanceId = 'test-instance',
    ) {
        this.now = start;
    }

    asOrchestrationContext(): OrchestrationContext {
        const self = this;
        const track = <T extends FakeTask>(t: T): T => {
            self.scheduled.push(t);
            return t;
        };
        const df = {
            get instanceId() {
                return self.instanceId;
            },
            get currentUtcDateTime() {
                return self.now;
            },
            isReplaying: false,
            getInput: () => self.input,
            setCustomStatus: (s: unknown) => {
                self.customStatus = s;
            },
            callActivity: (name: string, input?: unknown) => track({ kind: 'activity', name, input }),
            callActivityWithRetry: (name: string, _retry: unknown, input?: unknown) => track({ kind: 'activity', name, input }),
            createTimer: (fireAt: Date) => {
                const timer: FakeTask = {
                    kind: 'timer',
                    fireAt,
                    isCancelled: false,
                    cancel() {
                        this.isCancelled = true;
                    },
                };
                return track(timer);
            },
            waitForExternalEvent: (name: string) => track({ kind: 'event', name }),
            Task: {
                all: (tasks: FakeTask[]) => ({ kind: 'all', tasks }),
                any: (tasks: FakeTask[]) => ({ kind: 'any', tasks }),
            },
        };
        return { df } as unknown as OrchestrationContext;
    }

    /**
     * Runs the orchestrator to completion. `resolve` supplies the outcome of every
     * yielded task; timers advance the fake clock to their fire time.
     */
    run(handler: OrchestrationHandler, resolve: (task: FakeTask) => unknown): unknown {
        const gen = handler(this.asOrchestrationContext()) as Generator<FakeTask, unknown, unknown>;
        let step = gen.next();
        while (!step.done) {
            const task = step.value;
            if (task.kind === 'timer' && task.fireAt > this.now) this.now = task.fireAt;
            step = gen.next(resolve(task));
        }
        return step.value;
    }
}
