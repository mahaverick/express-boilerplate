# Razorpay fixtures

Redacted Razorpay answers and webhook deliveries for the billing tests. Every
webhook fixture holds the exact `rawBody` and the `x-razorpay-event-id` and
`x-razorpay-signature` headers. Each signature is HMAC-SHA256 over `rawBody`
with the dummy secret `probe_webhook_secret`, never a real one. Personal data
is replaced with placeholders (`user@example.com`, `card_FIXTURE`).

`tests/helpers/razorpay-fixtures.ts` loads them, rewrites the ids a test needs
(the subscription, its `notes.tenantId`, the event id) and signs the result
again with the same dummy secret.

## Captured and synthetic

Files with a timestamp in their name were captured from Razorpay test mode.

Files ending `-synthetic.json` carry `"synthetic": true`. Razorpay sent these
events before the test webhook was registered, so nothing was captured. They
are written from the captured shapes and Razorpay's documented payloads:

- `subscription.authenticated`, `subscription.activated`,
  `subscription.charged`, `subscription.halted`
- `invoice.paid`, `refund.processed`
- `payment.dispute.created`, `payment.dispute.won`, `payment.dispute.lost`,
  `payment.dispute.closed`

Replace each with a captured delivery after the live Razorpay pass.
