/**
 * Proposal tools.
 *
 * These are the only channel from the model to a review. They record; none of them touches GitHub.
 * Keeping them separate from a posting tool is what makes the policy layer and the admin gate
 * enforceable rather than advisory.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

export function createProposalCollector() {
  return {
    comments: [],
    body: "",
    verdict: null,
    verdictReason: "",
    blocking: [],
    gates: [],
    submitted: false,
    summary: "",
    /** Nothing usable came out of the turn: used to decide whether to ask the session to continue. */
    isEmpty() {
      return !this.comments.length && !this.body && !this.verdict && !this.submitted;
    },
    asProposal() {
      return {
        comments: this.comments,
        body: this.body,
        verdict: this.verdict,
        blocking: this.blocking,
        gates: this.gates,
      };
    },
  };
}

const textResult = (text, details) => ({ content: [{ type: "text", text }], details });

export function createReviewTools({ collector, limits = {} }) {
  const maxComments = limits.maxComments ?? 25;

  const proposeComment = defineTool({
    name: "review_propose_comment",
    label: "Propose inline comment",
    description:
      "Queue one inline review comment on a file and line of this PR. One concrete issue per comment. The harness validates the anchor against GitHub's diff and posts it only through the policy layer.",
    promptSnippet: "Queue an inline review comment with path and line",
    promptGuidelines: [
      "Use review_propose_comment once per concrete issue, never for a summary.",
      "Give line numbers as you read them in the file; the harness re-anchors what GitHub would reject.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Repository-relative file path as it appears in the diff" }),
      line: Type.Number({ description: "Last line the comment covers, in the new file" }),
      start_line: Type.Optional(Type.Number({ description: "First line of a multi-line range" })),
      body: Type.String({ description: "Comment text, two or three sentences, factual, citing the ticket where one applies" }),
      suggestion: Type.Optional(Type.String({ description: "Replacement lines for a suggested edit, without the suggestion fence" })),
    }),
    async execute(_id, params) {
      if (collector.comments.length >= maxComments) {
        return textResult(
          `not queued: this review already has ${collector.comments.length} comments, the cap is ${maxComments}. Fold this into the body or an existing comment.`,
          { queued: false },
        );
      }
      collector.comments.push(params);
      return textResult(`queued inline comment on ${params.path}:${params.start_line ?? params.line}-${params.line}`, {
        queued: true,
        count: collector.comments.length,
      });
    },
  });

  const proposeBody = defineTool({
    name: "review_propose_body",
    label: "Propose review body",
    description:
      "Set the review body. Verdict first: an approval opens with LGTM, anything that blocks says so. Body-level findings only, no recap of inline comments.",
    parameters: Type.Object({
      body: Type.String({ description: "The review body as it should be published" }),
    }),
    async execute(_id, params) {
      collector.body = params.body;
      return textResult("review body recorded", { characters: params.body.length });
    },
  });

  const proposeVerdict = defineTool({
    name: "review_propose_verdict",
    label: "Propose verdict",
    description:
      "State the verdict you recommend: approve, request_changes, or comment. The harness decides whether that verdict reaches GitHub; with the default policy it is described in the body instead.",
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal("approve"), Type.Literal("request_changes"), Type.Literal("comment")], {
        description: "approve | request_changes | comment",
      }),
      reason: Type.String({ description: "One sentence on why" }),
      blocking: Type.Optional(Type.Array(Type.String(), { description: "What blocks, for a requested change" })),
    }),
    async execute(_id, params) {
      collector.verdict = params.verdict;
      collector.verdictReason = params.reason;
      collector.blocking = params.blocking ?? [];
      return textResult(`verdict recorded: ${params.verdict} (the harness applies the posting policy)`, { verdict: params.verdict });
    },
  });

  const recordGate = defineTool({
    name: "review_record_gate",
    label: "Record a gate result",
    description:
      "Record the outcome of a check you ran (fmt, lint, tests, a probe). A gate that passed earns no line on the PR; it belongs in the record you hand back.",
    parameters: Type.Object({
      gate: Type.String({ description: "What was run, as CI runs it" }),
      result: Type.String({ description: "pass | fail | not_run" }),
      evidence: Type.String({ description: "The observed output that proves it" }),
    }),
    async execute(_id, params) {
      collector.gates.push(params);
      return textResult(`recorded gate ${params.gate}: ${params.result}`, { gates: collector.gates.length });
    },
  });

  const submit = defineTool({
    name: "review_submit",
    label: "Submit proposal",
    description: "End the review run with a proposal. Call this last.",
    parameters: Type.Object({
      summary: Type.String({ description: "One line: what you propose to send" }),
    }),
    async execute(_id, params) {
      collector.submitted = true;
      collector.summary = params.summary;
      return textResult(
        `proposal accepted: ${collector.comments.length} comment(s), verdict ${collector.verdict ?? "unset"}, ${collector.gates.length} gate result(s). Nothing has been sent to GitHub.`,
        { submitted: true },
      );
    },
  });

  return [proposeComment, proposeBody, proposeVerdict, recordGate, submit];
}
