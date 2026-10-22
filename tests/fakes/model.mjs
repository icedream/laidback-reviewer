/**
 * Scripted OpenAI-compatible model for tests.
 *
 * It is not a stand-in for review quality; it is a stand-in for *turn shape*. Pi asks for a
 * streaming chat completion, so this answers in SSE with the same tool-call structure a real review
 * run produces. That lets the pipeline (tool policy, anchoring, verdict mapping, banner, gate,
 * poster) be tested in CI with no GPU and no network.
 *
 * Real review behaviour is the live smoke run's job: tests/integration/live-smoke.mjs.
 */

import http from "node:http";

function chunk(body) {
  return `data: ${JSON.stringify(body)}\n\n`;
}

export function createScriptedModel({ turns, model = "scripted-review", failAttempts = [], status = null }) {
  const requests = [];
  const failing = new Set(failAttempts);
  let turn = 0;

  const server = http.createServer((req, res) => {
    // The queue probe reads a status document rather than a completion, so a busy server can be
    // simulated without spending a script turn or parsing an empty body.
    if (status && req.method === "GET" && (/^\/status/.test(req.url) || /^\/slots/.test(req.url))) {
      res.writeHead(200, { "Content-Type": "application/json" });
      // A function lets one test flip the server from occupied to free between cycles.
      res.end(JSON.stringify(typeof status === "function" ? status() : status));
      return;
    }
    // A completion endpoint answers POST; anything else is a probe, and a probe deserves a 404 rather
    // than a parse failure on an empty body.
    if (req.method === "GET") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found", type: "not_found_error" } }));
      return;
    }
    const chunks = [];
    req.on("data", (chunkData) => chunks.push(chunkData));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));

      // A busy upstream: the attempt is recorded but consumes no script turn, so the client's retry
      // resumes with the turn it never got.
      if (failing.has(requests.length)) {
        requests.push({
          path: req.url,
          model: body.model,
          messages: body.messages,
          tools: (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name),
          turn,
          failed: true,
          status: 503,
        });
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "model server is busy", type: "server_error", code: "model_overloaded" } }));
        return;
      }

      const script = turns[turn] ?? { content: "script exhausted" };
      const request = {
        path: req.url,
        model: body.model,
        messages: body.messages,
        tools: (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name),
        turn,
      };
      requests.push(request);
      turn += 1;

      const id = `chatcmpl-script-${request.turn}`;
      const created = Math.floor(Date.now() / 1000);

      if (body.stream === false) {
        const message = { role: "assistant", content: script.content ?? "" };
        if (script.tool_calls?.length) {
          message.tool_calls = script.tool_calls.map((call, index) => ({
            id: `call_${request.turn}_${index}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
          }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created,
            model,
            choices: [{ index: 0, message, finish_reason: script.tool_calls?.length ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
        );
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(chunk({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }));
      if (script.content) {
        res.write(chunk({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: script.content }, finish_reason: null }] }));
      }
      for (const [index, call] of (script.tool_calls ?? []).entries()) {
        res.write(
          chunk({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: `call_${request.turn}_${index}`,
                      type: "function",
                      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        );
      }
      res.write(
        chunk({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: script.tool_calls?.length ? "tool_calls" : "stop" }],
        }),
      );
      res.write(chunk({ id, object: "chat.completion.chunk", created, model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return {
    start() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve({ baseUrl: `http://127.0.0.1:${server.address().port}/v1` }));
      });
    },
    requests: () => requests,
    turnsAsked: () => turn,
    /** A second run over the same script needs the counter back at the start. */
    resetTurns: () => {
      turn = 0;
    },
    close() {
      server.close();
      server.closeAllConnections?.();
    },
  };
}

/**
 * A turn sequence that behaves like a short review run: read the diff, comment, record gates,
 * propose the body and verdict, submit. `buildScript` receives the fixture so the comments it emits
 * target real lines of the real diff, including one out-of-diff line and one cross-hunk range to
 * exercise re-anchoring.
 */
export function reviewScript({ fixture, scratchDir, verdict = "approve", blocking = [] }) {
  const fileOf = (name) => fixture.files.find((f) => f.filename === name);
  const lineOf = (name, needle) => {
    const file = fileOf(name);
    let line = null;
    let current = null;
    for (const raw of file.patch.split("\n")) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (header) {
        current = Number(header[1]);
        continue;
      }
      if (current === null) continue;
      if (raw[0] === "-") continue;
      if (raw.includes(needle)) line = current;
      current += 1;
    }
    if (!line) throw new Error(`fixture line not found: ${name} :: ${needle}`);
    return line;
  };

  const unmarshal = lineOf("internal/service/orders.go", "_ = json.Unmarshal");
  const offset = lineOf("internal/api/pagination.go", "return q.Page * q.PerPage");
  const clientLine = lineOf("internal/service/orders.go", "http: &http.Client{}");
  const loopLine = lineOf("internal/service/orders_test.go", "for _, tt := range tests");
  const paginationStart = lineOf("internal/api/pagination.go", "type Query struct");
  const paginationEnd = lineOf("internal/api/pagination.go", "OrderDir string");

  return [
    { content: "Reading the change before anything else.", tool_calls: [{ name: "bash", args: { command: `cd ${scratchDir} && git log --oneline -1 && git diff --stat -M HEAD~1` } }] },
    {
      tool_calls: [
        { name: "review_propose_comment", args: { path: "internal/service/orders.go", line: unmarshal, body: "The `json.Unmarshal` error is discarded, so a malformed upstream body yields an empty order list with a 200 response. Ticket ORD-142 criterion 4 asks for upstream JSON failures to be surfaced." } },
        { name: "review_propose_comment", args: { path: "internal/api/pagination.go", line: offset, body: "`Offset()` multiplies a 1-based page by the page size, so page 1 starts at row 20 and the first 20 orders are never returned. `page == 1` should be offset 0." } },
        // Deliberately off-diff: the harness must anchor it rather than post a bad range.
        { name: "review_propose_comment", args: { path: "internal/service/orders.go", line: clientLine + 400, body: "The upstream client has no timeout, and no deadline is derived from the request context, so a stalled upstream pins a handler." } },
        { name: "review_propose_comment", args: { path: "internal/service/orders_test.go", line: loopLine, body: "Table loop variable is `tt`; the house testing convention names it `test`." } },
        // Deliberately a range across an uncommitted gap; must narrow to one commentable run.
        { name: "review_propose_comment", args: { path: "internal/api/pagination.go", start_line: paginationStart, line: paginationEnd + 200, body: "Parsing accepts page 0 and negative pages, so `Offset()` can go negative and reach the upstream as a negative offset." } },
        // A comment on the formatting-churn file: the harness keeps it, the live model should not write one.
        { name: "review_propose_comment", args: { path: "internal/api/routes.go", line: lineOf("internal/api/routes.go", "mux.Handle(\"GET /healthz\""), body: "Blank line added inside the handler body." } },
      ],
    },
    {
      tool_calls: [
        { name: "review_record_gate", args: { gate: "gofmt", result: "fail", evidence: "gofmt -l lists internal/service/orders.go" } },
        { name: "review_record_gate", args: { gate: "go test ./...", result: "pass", evidence: "ok github.com/example/orders-svc/internal/api" } },
        // Blocked by the guard: proves a push attempt cannot escape the session.
        { name: "bash", args: { command: `cd ${scratchDir} && git push origin HEAD` } },
      ],
    },
    {
      tool_calls: [
        { name: "review_propose_body", args: { body: verdict === "approve"
          ? "LGTM on the split itself: the pagination rules are now testable on their own, and the handler is down to decoding, calling and writing.\n\nTwo things are not right yet. The upstream decode error is swallowed, which turns a broken upstream into a successful empty list. And the offset is off by one page, so the first page of orders is never served."
          : "The split into pagination plus a service client is the right shape, and the handler is down to decoding, calling and writing.\n\nTwo things block. The upstream decode error is swallowed, which turns a broken upstream into a successful empty list. And the offset is off by one page, so the first page of orders is never served." } },
        { name: "review_propose_verdict", args: { verdict, reason: verdict === "approve" ? "Both defects are two-line fixes and neither is a correctness risk in the merged state as shipped." : "The offset skips a page of orders, which is user-visible.", blocking } },
        { name: "review_submit", args: { summary: "approve with 5 inline comments and 2 gate results" } },
      ],
    },
    { content: "Review proposed: 5 inline comments, 2 gate results, verdict approve." },
  ];
}
