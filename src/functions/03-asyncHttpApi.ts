/**
 * PATTERN 3 — ASYNC HTTP API
 *
 * Coordinates a long-running operation with an external HTTP client:
 *
 *   1. Client  POST /api/reports              → 202 Accepted + Location: /api/reports/{id}/status
 *   2. Client  GET  /api/reports/{id}/status  → 202 + Retry-After while running (with progress)
 *                                             → 200 + report when completed
 *                                             → 500 when failed
 *
 * The client never holds a connection open for the duration of the work. The built-in
 * `createCheckStatusResponse` (used by httpStart.ts) gives the same behaviour with the
 * runtime's own webhook URLs; this file shows the hand-rolled equivalent so the moving
 * parts are visible.
 *
 * Start: POST /api/reports   { "reportName": "Q3-sales", "sections": 5 }
 */
import { app, HttpHandler, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import * as df from 'durable-functions';
import { OrchestrationContext, OrchestrationHandler, OrchestrationRuntimeStatus } from 'durable-functions';

export interface ReportRequest {
    reportName: string;
    sections?: number;
}

export interface ReportProgress {
    completedSections: number;
    totalSections: number;
    percentComplete: number;
}

export interface Report {
    reportName: string;
    sections: string[];
    generatedAt: string;
}

export const longRunningReportOrchestrator: OrchestrationHandler = function* (context: OrchestrationContext) {
    const input = context.df.getInput<ReportRequest>();
    const totalSections = Math.min(Math.max(input?.sections ?? 3, 1), 20);
    const sections: string[] = [];

    for (let i = 1; i <= totalSections; i++) {
        const section: string = yield context.df.callActivity('GenerateReportSection', { reportName: input.reportName, index: i });
        sections.push(section);

        // Custom status is visible to clients polling the status endpoint.
        const progress: ReportProgress = {
            completedSections: i,
            totalSections,
            percentComplete: Math.round((i / totalSections) * 100),
        };
        context.df.setCustomStatus(progress);
    }

    const report: Report = {
        reportName: input.reportName,
        sections,
        // Deterministic time: never use new Date() inside an orchestrator.
        generatedAt: context.df.currentUtcDateTime.toISOString(),
    };
    return report;
};

df.app.orchestration('LongRunningReportOrchestrator', longRunningReportOrchestrator);

df.app.activity('GenerateReportSection', {
    handler: async (input: { reportName: string; index: number }, context: InvocationContext): Promise<string> => {
        await new Promise((resolve) => setTimeout(resolve, 3000)); // simulated slow work
        context.log(`Generated section ${input.index} of ${input.reportName}`);
        return `${input.reportName} - section ${input.index}`;
    },
});

// 1. Kick off: returns 202 immediately with a Location header to poll.
const startReport: HttpHandler = async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const body = (await request.json().catch(() => null)) as ReportRequest | null;
    if (!body?.reportName) {
        return { status: 400, jsonBody: { error: "Body must include 'reportName'." } };
    }

    const client = df.getClient(context);
    const instanceId = await client.startNew('LongRunningReportOrchestrator', { input: body });
    const statusUrl = `${new URL(request.url).origin}/api/reports/${instanceId}/status`;

    return {
        status: 202,
        headers: { Location: statusUrl, 'Retry-After': '5' },
        jsonBody: { instanceId, statusUrl },
    };
};

app.http('StartReport', {
    route: 'reports',
    methods: ['POST'],
    authLevel: 'anonymous',
    extraInputs: [df.input.durableClient()],
    handler: startReport,
});

// 2. Poll: 202 while running, 200 with the result once done.
const getReportStatus: HttpHandler = async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const client = df.getClient(context);
    const instanceId = request.params.instanceId;
    const status = await client.getStatus(instanceId);

    if (!status) {
        return { status: 404, jsonBody: { error: `No report with id '${instanceId}'.` } };
    }

    switch (status.runtimeStatus) {
        case OrchestrationRuntimeStatus.Pending:
        case OrchestrationRuntimeStatus.Running:
        case OrchestrationRuntimeStatus.ContinuedAsNew:
            return {
                status: 202,
                headers: { Location: request.url, 'Retry-After': '5' },
                jsonBody: { instanceId, runtimeStatus: status.runtimeStatus, progress: status.customStatus },
            };
        case OrchestrationRuntimeStatus.Completed:
            return { status: 200, jsonBody: { instanceId, runtimeStatus: status.runtimeStatus, report: status.output } };
        default: // Failed, Terminated, Canceled
            return { status: 500, jsonBody: { instanceId, runtimeStatus: status.runtimeStatus, error: status.output } };
    }
};

app.http('GetReportStatus', {
    route: 'reports/{instanceId}/status',
    methods: ['GET'],
    authLevel: 'anonymous',
    extraInputs: [df.input.durableClient()],
    handler: getReportStatus,
});
