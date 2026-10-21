/**
 * The ticket the fixture PR is supposed to follow.
 *
 * Criteria 1 to 4 are met or visibly violated by the change; criterion 5 is not implemented at all,
 * which is the case a reviewer has to catch by reading the ticket rather than the diff: nothing in
 * the diff points at it.
 */

export const TICKET_KEY = "ORD-142";

export const FIXTURE_TICKET = {
  key: TICKET_KEY,
  fields: {
    summary: "Order listing: filters, pagination and a service client",
    status: { name: "In Progress" },
    issuetype: { name: "Story" },
    priority: { name: "High" },
    description: `As an operator I need the order list endpoint to page and filter so large tenants do not time out.

Acceptance criteria:
1. page and per_page are parsed and validated; an invalid value returns 400 with an error message.
2. per_page defaults to 20 and is capped at 100.
3. the downstream call carries the request context so a slow upstream cannot pin a handler.
4. an upstream body that is not valid JSON fails the request instead of returning an empty page.
5. the list can be filtered by customer id, and a test covers the filter.`,
  },
  issuelinks: [{ type: { name: "Blocks", inward: "blocks", outward: "is blocked by" }, inwardIssue: { key: "ORD-150", fields: { summary: "Order list timeouts on large tenants" } } }],
};

/** The criteria as a checklist, so a test can name what should have been found. */
export const TICKET_CRITERIA = [
  { id: 1, text: "page and per_page validated, invalid returns 400", outcome: "regressed by this change" },
  { id: 2, text: "per_page defaults to 20, capped at 100", outcome: "implemented" },
  { id: 3, text: "downstream call carries the request context", outcome: "implemented" },
  { id: 4, text: "invalid upstream JSON fails the request", outcome: "violated by the discarded decode error" },
  { id: 5, text: "filter by customer id, with a test", outcome: "not implemented anywhere in the branch" },
];
