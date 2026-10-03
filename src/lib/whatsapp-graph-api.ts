// whatsapp-graph-api.ts — The Meta Graph API version every WhatsApp Cloud
// API call uses. Both senders build their URLs from it: sendWhatsAppMessage
// in whatsapp-notifier.ts and the replies in pages/api/whatsapp/webhook.ts.
//
// It is a constant on purpose, not an env var. A new Graph version can change
// request and response shapes, so a bump belongs in a reviewed PR, never in a
// dashboard edit. The retired WHATSAPP_API_VERSION variable was never read,
// and the setup docs told operators to set it to v21.0, so reading it here
// would silently move production back to v21.0.
//
// Meta supports v23.0 until 2027-10-08. Each version's end date is listed at
// https://developers.facebook.com/docs/graph-api/changelog/versions
export const WHATSAPP_GRAPH_API_VERSION = 'v23.0';
