/**
 * Fixture repository.
 *
 * A synthetic Go service with a medium-complexity change: a paginated list handler split into a
 * service layer, carrying issues a reviewer is expected to catch. The fake GitHub API serves the
 * patch text this generator derives from git, so the anchoring path under test is exercised against
 * a real diff rather than a hand-written guess.
 *
 * Run directly to inspect it: node tests/fixtures/repo.mjs --out /tmp/laidback-fixture
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const FIXTURE = {
  owner: "example",
  repo: "orders-svc",
  pr: 143,
  ticket: "ORD-142",
  baseRef: "main",
  headRef: "ORD-142/orders-pagination-service",
  title: "refactor: move order listing behind a service client",
  commitSubject: "refactor: list orders through a service client",
  commitBody: `${(
    "Split the orders handler into api/pagination plus service.Client.\n" +
    "Ticket: ORD-142\n" +
    "\n" +
    "The handler kept growing query parsing, downstream calls and JSON decoding in one\n" +
    "function, so the pagination rules could not be tested on their own. This moves the\n" +
    "downstream call behind service.Client and keeps the handler to decoding, calling and\n" +
    "writing the response."
  ).trim()}`,
  prBody: `## Goal of this PR

Order listing grows a filter set, so the downstream call moves behind \`service.Client\` and the
query rules move to \`internal/api/pagination.go\`. That makes the pagination rules testable without
an HTTP server.

Closes ORD-142.`,
  ticketSummary: "Order listing: filters, pagination and a service client",
  ticketDescription: `As an operator I need the order list endpoint to page and filter so large tenants do not time out.

Acceptance criteria:
1. page and per_page are parsed and validated; an invalid page returns 400 with an error message.
2. per_page is capped at 100 and defaults to 20.
3. the downstream call carries the request context so a slow upstream cannot pin a handler.
4. upstream JSON failures are surfaced, not swallowed.`,
  planted: [
    {
      id: "swallowed-unmarshal",
      path: "internal/service/orders.go",
      expectation: "json.Unmarshal error is discarded, so a malformed upstream body lists zero orders",
    },
    {
      id: "offset-off-by-one",
      path: "internal/api/pagination.go",
      expectation: "Offset() uses page*size on a 1-based page, so page 1 skips the first page",
    },
    {
      id: "no-upstream-timeout",
      path: "internal/service/orders.go",
      expectation: "http.Client with no timeout and no deadline derived from ctx",
    },
    {
      id: "table-loop-name",
      path: "internal/service/orders_test.go",
      expectation: "table loop variable is tt, against the house testing convention",
    },
    {
      id: "missing-400-test",
      path: "internal/api/orders_test.go",
      expectation: "ticket criterion 1 has no test; a body-level finding, not an inline one",
    },
    {
      id: "formatting-churn",
      path: "internal/api/routes.go",
      expectation: "whitespace and import regrouping only; must not earn a comment",
    },
  ],
};

const BASE_FILES = {
  "go.mod": `module github.com/example/orders-svc

go 1.24
`,
  "Makefile": `GOLANGCI_LINT_VERSION ?= v1.62.2

fmt:
\tgofmt -l -w .

lint:
\tgolangci-lint run --config .golangci.yml

test:
\tgo test ./...

.PHONY: fmt lint test
`,
  ".golangci.yml": `version: "2"
run:
  timeout: 3m
linters:
  default: standard
`,
  ".github/workflows/ci.yml": `name: ci
on:
  pull_request:

jobs:
  go:
    runs-on: ubuntu-latest
    env:
      GOLANGCI_LINT_VERSION: v1.62.2
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
      - run: make lint
      - run: make test
`,
  "internal/api/orders.go": `package api

import (
\t"encoding/json"
\t"fmt"
\t"io"
\t"net/http"
\t"strconv"
)

type Order struct {
\tID     string \`json:"id"\`
\tStatus string \`json:"status"\`
\tTotal  int    \`json:"total"\`
}

// ListOrders reads the query, calls the upstream order service and writes the page.
func ListOrders(upstream string) http.Handler {
\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
\t\tvalues := r.URL.Query()
\t\tpage := 1
\t\tif raw := values.Get("page"); raw != "" {
\t\t\tn, err := strconv.Atoi(raw)
\t\t\tif err != nil || n < 1 {
\t\t\t\thttp.Error(w, "invalid page", http.StatusBadRequest)
\t\t\t\treturn
\t\t\t}
\t\t\tpage = n
\t\t}
\t\tperPage := 20
\t\tif raw := values.Get("per_page"); raw != "" {
\t\t\tn, err := strconv.Atoi(raw)
\t\t\tif err != nil || n < 1 {
\t\t\t\thttp.Error(w, "invalid per_page", http.StatusBadRequest)
\t\t\t\treturn
\t\t\t}
\t\t\tif n > 100 {
\t\t\t\tn = 100
\t\t\t}
\t\t\tperPage = n
\t\t}
\t\tstatus := values.Get("status")

\t\turl := fmt.Sprintf("%s/v2/orders?page=%d&per_page=%d&status=%s", upstream, page, perPage, status)
\t\treq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, url, nil)
\t\tif err != nil {
\t\t\thttp.Error(w, "build request: "+err.Error(), http.StatusInternalServerError)
\t\t\treturn
\t\t}
\t\tresp, err := http.DefaultClient.Do(req)
\t\tif err != nil {
\t\t\thttp.Error(w, "list orders: "+err.Error(), http.StatusBadGateway)
\t\t\treturn
\t\t}
\t\tdefer resp.Body.Close()
\t\tbody, err := io.ReadAll(resp.Body)
\t\tif err != nil {
\t\t\thttp.Error(w, "read orders: "+err.Error(), http.StatusBadGateway)
\t\t\treturn
\t\t}
\t\tif resp.StatusCode != http.StatusOK {
\t\t\thttp.Error(w, fmt.Sprintf("upstream %d: %s", resp.StatusCode, string(body)), http.StatusBadGateway)
\t\t\treturn
\t\t}

\t\tvar payload struct {
\t\t\tOrders []Order \`json:"orders"\`
\t\t\tTotal  int     \`json:"total"\`
\t\t}
\t\tif err := json.Unmarshal(body, &payload); err != nil {
\t\t\thttp.Error(w, "decode orders: "+err.Error(), http.StatusBadGateway)
\t\t\treturn
\t\t}

\t\tw.Header().Set("Content-Type", "application/json")
\t\tif err := json.NewEncoder(w).Encode(payload); err != nil {
\t\t\thttp.Error(w, "write orders: "+err.Error(), http.StatusInternalServerError)
\t\t}
\t})
}
`,
  "internal/api/routes.go": `package api

import (
\t"fmt"
\t"net/http"

\t"github.com/example/orders-svc/internal/buildinfo"
)

// Register mounts the HTTP surface of the service.
func Register(mux *http.ServeMux, upstream string) {
\tmux.Handle("GET /v1/orders", ListOrders(upstream))
\tmux.Handle("GET /healthz", healthHandler())
}

func healthHandler() http.Handler {
\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
\t\tw.WriteHeader(http.StatusOK)
\t\tfmt.Fprintf(w, "orders-svc %s\\n", buildinfo.Version)
\t})
}
`,
  "internal/buildinfo/build.go": `package buildinfo

// Version is stamped at build time.
var Version = "dev"
`,
};

const HEAD_NEW = {
  "internal/api/pagination.go": `package api

import (
\t"strconv"
)

const (
\tdefaultPerPage = 20
\tmaxPerPage     = 100
)

// Query is the validated list query of the orders endpoint.
type Query struct {
\tPage     int
\tPerPage  int
\tStatus   string
\tSortBy   string
\tOrderDir string
}

// Offset is the row the page starts at.
func (q Query) Offset() int {
\treturn q.Page * q.PerPage
}

// ParseQuery reads the list query from URL values.
func ParseQuery(values map[string][]string) (Query, error) {
\tq := Query{Page: 1, PerPage: defaultPerPage}
\tif raw := first(values, "page"); raw != "" {
\t\tn, err := strconv.Atoi(raw)
\t\tif err != nil {
\t\t\treturn Query{}, err
\t\t}
\t\tq.Page = n
\t}
\tif raw := first(values, "per_page"); raw != "" {
\t\tn, err := strconv.Atoi(raw)
\t\tif err != nil {
\t\t\treturn Query{}, err
\t\t}
\t\tq.PerPage = n
\t}
\tif q.PerPage > maxPerPage {
\t\tq.PerPage = maxPerPage
\t}
\tq.Status = first(values, "status")
\tq.SortBy = first(values, "sort")
\tq.OrderDir = first(values, "order")
\treturn q, nil
}

func first(values map[string][]string, key string) string {
\tif got := values[key]; len(got) > 0 {
\t\treturn got[0]
\t}
\treturn ""
}
`,
  "internal/service/orders.go": `package service

import (
\t"context"
\t"encoding/json"
\t"fmt"
\t"io"
\t"net/http"
\t"net/url"
\t"strconv"
)

// Order is one row of the upstream order list.
type Order struct {
\tID     string \`json:"id"\`
\tStatus string \`json:"status"\`
\tTotal  int    \`json:"total"\`
}

// OrderPage is one page of the upstream order list.
type OrderPage struct {
\tOrders []Order
\tTotal  int
\tOffset int
}

// Client talks to the upstream order service.
type Client struct {
\tbase   *url.URL
\thttp   *http.Client
}

// NewClient builds a client for the upstream base URL.
func NewClient(base string) (*Client, error) {
\tparsed, err := url.Parse(base)
\tif err != nil {
\t\treturn nil, fmt.Errorf("parse upstream: %w", err)
\t}
\treturn &Client{base: parsed, http: &http.Client{}}, nil
}

// ListOrders returns one page of orders for the query.
func (c *Client) ListOrders(ctx context.Context, q ListQuery) (OrderPage, error) {
\tendpoint := c.base.JoinPath("/v2/orders")
\tparams := url.Values{}
\tparams.Set("offset", strconv.Itoa(q.Offset))
\tparams.Set("limit", strconv.Itoa(q.Limit))
\tif q.Status != "" {
\t\tparams.Set("status", q.Status)
\t}
\tif q.SortBy != "" {
\t\tparams.Set("sort", q.SortBy)
\t\tparams.Set("order", q.OrderDir)
\t}
\tendpoint.RawQuery = params.Encode()

\treq, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
\tif err != nil {
\t\treturn OrderPage{}, fmt.Errorf("build request: %w", err)
\t}
\tresp, err := c.http.Do(req)
\tif err != nil {
\t\treturn OrderPage{}, fmt.Errorf("list orders: %w", err)
\t}
\tdefer resp.Body.Close()

\tbody, err := io.ReadAll(resp.Body)
\tif err != nil {
\t\treturn OrderPage{}, fmt.Errorf("read orders: %w", err)
\t}
\tif resp.StatusCode != http.StatusOK {
\t\treturn OrderPage{}, fmt.Errorf("upstream %d: %s", resp.StatusCode, string(body))
\t}

\tvar payload struct {
\t\tOrders []Order \`json:"orders"\`
\t\tTotal  int     \`json:"total"\`
\t}
\t_ = json.Unmarshal(body, &payload)

\treturn OrderPage{Orders: payload.Orders, Total: payload.Total, Offset: q.Offset}, nil
}

// ListQuery is the upstream page request.
type ListQuery struct {
\tOffset   int
\tLimit    int
\tStatus   string
\tSortBy   string
\tOrderDir string
}
`,
  "internal/service/orders_test.go": `package service

import (
\t"context"
\t"encoding/json"
\t"net/http"
\t"net/http/httptest"
\t"strings"
\t"testing"
)

func TestListOrdersUpstreamError(t *testing.T) {
\ttests := []struct {
\t\tname    string
\t\tstatus  int
\t\tbody    string
\t\twantErr string
\t}{
\t\t{name: "not found", status: http.StatusNotFound, body: "no such tenant", wantErr: "upstream 404"},
\t\t{name: "server error", status: http.StatusInternalServerError, body: "boom", wantErr: "upstream 500"},
\t}

\tfor _, tt := range tests {
\t\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
\t\t\tw.WriteHeader(tt.status)
\t\t\tw.Write([]byte(tt.body))
\t\t}))
\t\tclient, err := NewClient(server.URL)
\t\tif err != nil {
\t\t\tt.Fatalf("new client: %v", err)
\t\t}
\t\tpage, err := client.ListOrders(context.Background(), ListQuery{Offset: 0, Limit: 20})
\t\tif err == nil {
\t\t\tt.Fatalf("expected error, got page %+v", page)
\t\t}
\t\tif !strings.Contains(err.Error(), tt.wantErr) {
\t\t\tt.Fatalf("want %q, got %q", tt.wantErr, err)
\t\t}
\t\tserver.Close()
\t}
}

func TestListOrdersReadsPage(t *testing.T) {
\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
\t\tjson.NewEncoder(w).Encode(map[string]any{
\t\t\t"orders": []map[string]any{{"id": "o-1", "status": "open", "total": 1}},
\t\t\t"total":  1,
\t\t})
\t}))
\tdefer server.Close()

\tclient, err := NewClient(server.URL)
\tif err != nil {
\t\tt.Fatalf("new client: %v", err)
\t}
\tpage, err := client.ListOrders(context.Background(), ListQuery{Offset: 20, Limit: 20})
\tif err != nil {
\t\tt.Fatalf("list orders: %v", err)
\t}
\tif len(page.Orders) != 1 {
\t\tt.Fatalf("want 1 order, got %d", len(page.Orders))
\t}
}
`,
  "internal/api/orders_test.go": `package api

import (
\t"encoding/json"
\t"net/http"
\t"net/http/httptest"
\t"testing"
)

func TestListOrdersHappyPath(t *testing.T) {
\tserver := newUpstream(t)
\tdefer server.Close()

\thandler := ListOrders(server.URL)
\trec := httptest.NewRecorder()
\thandler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/orders?per_page=5", nil))

\tif rec.Code != http.StatusOK {
\t\tt.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
\t}
\tvar payload struct {
\t\tOrders []struct {
\t\t\tID string \`json:"id"\`
\t\t} \`json:"orders"\`
\t}
\tif err := json.NewDecoder(rec.Body).Decode(&payload); err != nil {
\t\tt.Fatalf("decode: %v", err)
\t}
\tif len(payload.Orders) != 2 {
\t\tt.Fatalf("want 2 orders, got %d", len(payload.Orders))
\t}
}

func TestParseQueryDefaults(t *testing.T) {
\tq, err := ParseQuery(map[string][]string{})
\tif err != nil {
\t\tt.Fatalf("parse: %v", err)
\t}
\tif q.Page != 1 || q.PerPage != 20 {
\t\tt.Fatalf("want page 1 per_page 20, got %+v", q)
\t}
}

func TestParseQueryCapsPerPage(t *testing.T) {
\tq, err := ParseQuery(map[string][]string{"per_page": {"500"}})
\tif err != nil {
\t\tt.Fatalf("parse: %v", err)
\t}
\tif q.PerPage != 100 {
\t\tt.Fatalf("want 100, got %d", q.PerPage)
\t}
}

func newUpstream(t *testing.T) *httptest.Server {
\tt.Helper()
\treturn httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
\t\tjson.NewEncoder(w).Encode(map[string]any{
\t\t\t"orders": []map[string]any{
\t\t\t\t{"id": "o-1", "status": "open", "total": 2},
\t\t\t\t{"id": "o-2", "status": "closed", "total": 2},
\t\t\t},
\t\t\t"total": 2,
\t\t})
\t}))
}
`,
};

const HEAD_REPLACED = {
  "internal/api/orders.go": `package api

import (
\t"encoding/json"
\t"net/http"

\t"github.com/example/orders-svc/internal/service"
)

// ListOrders decodes the query, asks the order service and writes the page.
func ListOrders(upstream string) http.Handler {
\tclient, err := service.NewClient(upstream)
\tif err != nil {
\t\tpanic("api: upstream url: " + err.Error())
\t}

\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
\t\tq, err := ParseQuery(r.URL.Query())
\t\tif err != nil {
\t\t\thttp.Error(w, "invalid query: "+err.Error(), http.StatusBadRequest)
\t\t\treturn
\t\t}

\t\tpage, err := client.ListOrders(r.Context(), service.ListQuery{
\t\t\tOffset:   q.Offset(),
\t\t\tLimit:    q.PerPage,
\t\t\tStatus:   q.Status,
\t\t\tSortBy:   q.SortBy,
\t\t\tOrderDir: q.OrderDir,
\t\t})
\t\tif err != nil {
\t\t\thttp.Error(w, "list orders: "+err.Error(), http.StatusBadGateway)
\t\t\treturn
\t\t}

\t\tw.Header().Set("Content-Type", "application/json")
\t\tif err := json.NewEncoder(w).Encode(map[string]any{
\t\t\t"orders": page.Orders,
\t\t\t"total":  page.Total,
\t\t\t"offset": page.Offset,
\t\t}); err != nil {
\t\t\thttp.Error(w, "write orders: "+err.Error(), http.StatusInternalServerError)
\t\t}
\t})
}
`,
  // Formatting-only churn: import regrouping, blank lines and a reworded comment. It is the
  // negative control for the "ignore formatting noise" rule.
  "internal/api/routes.go": `package api

import (
\t"fmt"
\t"net/http"

\t"github.com/example/orders-svc/internal/buildinfo"
)

// Register mounts the service HTTP surface on mux.
func Register(mux *http.ServeMux, upstream string) {

\tmux.Handle("GET /v1/orders", ListOrders(upstream))

\tmux.Handle("GET /healthz", healthHandler())

}

func healthHandler() http.Handler {
\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
\t\tw.WriteHeader(http.StatusOK)

\t\tfmt.Fprintf(w, "orders-svc %s\\n", buildinfo.Version)
\t})
}
`,
};

function git(dir, ...args) {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  }).trim();
}

function write(dir, rel, content) {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function hunkOnly(patch) {
  const lines = patch.split("\n");
  const start = lines.findIndex((line) => line.startsWith("@@"));
  if (start < 0) return "";
  return lines.slice(start).join("\n").replace(/\n$/, "");
}

function statusFromDiff(diffHeader) {
  if (diffHeader.includes("new file mode")) return "added";
  if (diffHeader.includes("deleted file mode")) return "removed";
  return "modified";
}

/**
 * Build the fixture. Returns everything the fake GitHub API needs, plus the planted-issue map the
 * tests assert against.
 */
export function buildFixtureRepo({ dir }) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", FIXTURE.baseRef);

  for (const [rel, content] of Object.entries(BASE_FILES)) write(dir, rel, content);
  git(dir, "add", "-A");
  git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "initial orders service");

  git(dir, "checkout", "-q", "-b", FIXTURE.headRef);
  for (const [rel, content] of Object.entries(HEAD_REPLACED)) write(dir, rel, content);
  for (const [rel, content] of Object.entries(HEAD_NEW)) write(dir, rel, content);
  git(dir, "add", "-A");
  git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", FIXTURE.commitSubject, "-m", FIXTURE.commitBody);

  const headSha = git(dir, "rev-parse", "HEAD");
  const baseSha = git(dir, "rev-parse", `${FIXTURE.baseRef}`);

  const perFile = git(dir, "diff", "-U3", "--name-status", `${baseSha}...${headSha}`)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));

  const files = perFile.map(([statusLetter, filename]) => {
    const raw = git(dir, "diff", "-U3", "--find-renames", `${baseSha}...${headSha}`, "--", filename);
    const header = raw.split("\n").filter((line) => /^(diff --git|index |new file|deleted file|similarity|rename)/.test(line)).join("\n");
    const body = hunkOnly(raw);
    const additions = body.split("\n").filter((line) => line.startsWith("+")).length;
    const deletions = body.split("\n").filter((line) => line.startsWith("-")).length;
    return {
      filename,
      status: statusLetter === "A" ? "added" : statusLetter === "D" ? "removed" : statusFromDiff(header),
      additions,
      deletions,
      changes: additions + deletions,
      patch: body,
    };
  });

  return {
    dir,
    owner: FIXTURE.owner,
    repo: FIXTURE.repo,
    pr: FIXTURE.pr,
    base: { ref: FIXTURE.baseRef, sha: baseSha },
    head: { ref: FIXTURE.headRef, sha: headSha },
    files,
    planted: FIXTURE.planted,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outIndex = process.argv.indexOf("--out");
  const dir = outIndex >= 0 ? process.argv[outIndex + 1] : "/tmp/laidback-fixture";
  const built = buildFixtureRepo({ dir });
  const stat = git(dir, "diff", "--stat", "-M", `${built.base.sha}...${built.head.sha}`);
  console.log(`fixture: ${dir}`);
  console.log(`head: ${built.head.sha.slice(0, 12)} (${built.head.ref})`);
  console.log(stat);
  console.log(`planted: ${built.planted.map((p) => p.id).join(", ")}`);
}
