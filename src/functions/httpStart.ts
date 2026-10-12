/**
 * Generic HTTP starter (also the entry point of the Async HTTP API pattern).
 *
 *   POST /api/orchestrators/{orchestratorName}   body = orchestration input (JSON)
 *
 * Starts any orchestration by name and immediately returns 202 Accepted with the
 * management URLs (statusQueryGetUri, sendEventPostUri, terminatePostUri, ...).
 * Add `?wait=<seconds>` to wait briefly for completion and return 200 with the output
 * if the orchestration finishes in time.
 */
import { app, HttpHandler, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import * as df from 'durable-functions';

const httpStart: HttpHandler = async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const client = df.getClient(context);
    const orchestratorName = request.params.orchestratorName;

    const text = await request.text();
    let input: unknown = undefined;
    if (text) {
        try {
            input = JSON.parse(text);
        } catch {
            return { status: 400, jsonBody: { error: 'Request body must be valid JSON.' } };
        }
    }

    const instanceId = await client.startNew(orchestratorName, { input });
    context.log(`Started orchestration '${orchestratorName}' with ID = '${instanceId}'.`);

    const waitSeconds = Number(request.query.get('wait') ?? 0);
    if (waitSeconds > 0) {
        return client.waitForCompletionOrCreateCheckStatusResponse(request, instanceId, {
            timeoutInMilliseconds: waitSeconds * 1000,
        });
    }
    return client.createCheckStatusResponse(request, instanceId);
};

app.http('httpStart', {
    route: 'orchestrators/{orchestratorName}',
    methods: ['POST'],
    authLevel: 'anonymous',
    extraInputs: [df.input.durableClient()],
    handler: httpStart,
});
