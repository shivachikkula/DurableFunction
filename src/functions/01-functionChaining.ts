/**
 * PATTERN 1 — FUNCTION CHAINING
 *
 * Activities run in a fixed order; the output of each step is the input of the next.
 *
 *   ValidateOrder ──► ReserveInventory ──► ChargePayment ──► SendConfirmation
 *
 * Every `yield` is a checkpoint: if the host restarts mid-chain, the orchestrator is
 * replayed from history and already-completed activities are not executed again.
 *
 * Start: POST /api/orchestrators/FunctionChainingOrchestrator
 *        { "orderId": "A-100", "customerEmail": "jane@example.com", "items": [{ "sku": "BOOK-1", "quantity": 2, "unitPrice": 15 }] }
 */
import { InvocationContext } from '@azure/functions';
import * as df from 'durable-functions';
import { OrchestrationContext, OrchestrationHandler } from 'durable-functions';

export interface OrderItem {
    sku: string;
    quantity: number;
    unitPrice: number;
}

export interface Order {
    orderId: string;
    customerEmail: string;
    items: OrderItem[];
}

export interface ValidatedOrder extends Order {
    total: number;
}

export interface ReservedOrder extends ValidatedOrder {
    reservationId: string;
}

export interface PaidOrder extends ReservedOrder {
    paymentId: string;
}

export interface OrderReceipt {
    orderId: string;
    total: number;
    reservationId: string;
    paymentId: string;
    confirmationSentTo: string;
}

export const functionChainingOrchestrator: OrchestrationHandler = function* (context: OrchestrationContext) {
    const order = context.df.getInput<Order>();

    // Transient failures (e.g. payment gateway timeouts) are retried: first retry after 5s, max 3 attempts.
    const retry = new df.RetryOptions(5000, 3);

    const validated: ValidatedOrder = yield context.df.callActivity('ValidateOrder', order);
    const reserved: ReservedOrder = yield context.df.callActivity('ReserveInventory', validated);
    const paid: PaidOrder = yield context.df.callActivityWithRetry('ChargePayment', retry, reserved);
    const receipt: OrderReceipt = yield context.df.callActivity('SendConfirmation', paid);

    return receipt;
};

df.app.orchestration('FunctionChainingOrchestrator', functionChainingOrchestrator);

df.app.activity('ValidateOrder', {
    handler: (order: Order, context: InvocationContext): ValidatedOrder => {
        if (!order?.orderId || !order.items?.length) {
            throw new Error('Order must have an orderId and at least one item.');
        }
        const total = order.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
        context.log(`Order ${order.orderId} validated. Total = ${total}`);
        return { ...order, total };
    },
});

df.app.activity('ReserveInventory', {
    handler: (order: ValidatedOrder, context: InvocationContext): ReservedOrder => {
        const reservationId = `RES-${order.orderId}-${Date.now()}`;
        context.log(`Inventory reserved for ${order.orderId}: ${reservationId}`);
        return { ...order, reservationId };
    },
});

df.app.activity('ChargePayment', {
    handler: (order: ReservedOrder, context: InvocationContext): PaidOrder => {
        const paymentId = `PAY-${order.orderId}-${Date.now()}`;
        context.log(`Charged ${order.total} for ${order.orderId}: ${paymentId}`);
        return { ...order, paymentId };
    },
});

df.app.activity('SendConfirmation', {
    handler: (order: PaidOrder, context: InvocationContext): OrderReceipt => {
        context.log(`Confirmation email sent to ${order.customerEmail} for ${order.orderId}`);
        return {
            orderId: order.orderId,
            total: order.total,
            reservationId: order.reservationId,
            paymentId: order.paymentId,
            confirmationSentTo: order.customerEmail,
        };
    },
});
