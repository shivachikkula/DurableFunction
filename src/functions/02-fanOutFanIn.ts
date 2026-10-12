/**
 * PATTERN 2 — FAN-OUT / FAN-IN
 *
 * One activity produces a list of work items, N activities process them in parallel
 * (fan-out), and the orchestrator waits for all of them with Task.all (fan-in) before
 * aggregating the results.
 *
 *                       ┌─► ProcessFile(a) ─┐
 *   GetFilesToProcess ──┼─► ProcessFile(b) ─┼──► aggregate (sum, largest file)
 *                       └─► ProcessFile(n) ─┘
 *
 * Start: POST /api/orchestrators/FanOutFanInOrchestrator
 *        { "folder": "invoices/2026-10", "fileCount": 10 }
 */
import { InvocationContext } from '@azure/functions';
import * as df from 'durable-functions';
import { OrchestrationContext, OrchestrationHandler, Task } from 'durable-functions';

export interface FanOutInput {
    folder: string;
    fileCount?: number;
}

export interface FileResult {
    file: string;
    sizeBytes: number;
    lineCount: number;
}

export interface FanInSummary {
    folder: string;
    filesProcessed: number;
    totalBytes: number;
    totalLines: number;
    largestFile: string | null;
}

export const fanOutFanInOrchestrator: OrchestrationHandler = function* (context: OrchestrationContext) {
    const input = context.df.getInput<FanOutInput>();

    const files: string[] = yield context.df.callActivity('GetFilesToProcess', input);

    // Fan-out: schedule every activity without yielding, so they all run in parallel.
    const tasks: Task[] = files.map((file) => context.df.callActivity('ProcessFile', file));

    // Fan-in: a single yield that completes once every task has completed.
    const results: FileResult[] = yield context.df.Task.all(tasks);

    const summary: FanInSummary = {
        folder: input.folder,
        filesProcessed: results.length,
        totalBytes: results.reduce((sum, r) => sum + r.sizeBytes, 0),
        totalLines: results.reduce((sum, r) => sum + r.lineCount, 0),
        largestFile: results.reduce<FileResult | null>((max, r) => (!max || r.sizeBytes > max.sizeBytes ? r : max), null)?.file ?? null,
    };
    return summary;
};

df.app.orchestration('FanOutFanInOrchestrator', fanOutFanInOrchestrator);

df.app.activity('GetFilesToProcess', {
    handler: (input: FanOutInput, context: InvocationContext): string[] => {
        // Simulated: a real app would list blobs in a container here.
        const count = Math.min(Math.max(input?.fileCount ?? 5, 1), 100);
        const files = Array.from({ length: count }, (_, i) => `${input.folder}/file-${i + 1}.csv`);
        context.log(`Found ${files.length} files in ${input.folder}`);
        return files;
    },
});

df.app.activity('ProcessFile', {
    handler: async (file: string, context: InvocationContext): Promise<FileResult> => {
        // Simulated work of varying duration.
        await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1500));
        const sizeBytes = 1024 + Math.floor(Math.random() * 100_000);
        const result = { file, sizeBytes, lineCount: Math.floor(sizeBytes / 80) };
        context.log(`Processed ${file}: ${sizeBytes} bytes`);
        return result;
    },
});
