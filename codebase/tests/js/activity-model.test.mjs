import { test } from "node:test";
import assert from "node:assert/strict";
import { describeRequest, createActivity, elapsedText, activityLine } from "../../src/DashboardBuilder/Features/Core/activity-model.js";

test("labels come from the method and path, in words", () => {
  assert.equal(describeRequest("GET", "/api/databases"), "Loading databases");
  assert.equal(describeRequest("GET", "/api/databases/sales/tables"), "Loading tables in sales");
  assert.equal(describeRequest("GET", "/api/databases/sales/tables/orders/columns"), "Loading columns of orders");
  assert.equal(describeRequest("GET", "/api/databases/sales/tables/orders/columns/status/distinct?limit=200"), "Loading values of status in orders");
  assert.equal(describeRequest("POST", "/api/databases/sales/tables/orders/profile"), "Profiling a column of sales.orders");
  assert.equal(describeRequest("POST", "/api/query"), "Running the worksheet query");
  assert.equal(describeRequest("POST", "/api/query/export.csv"), "Exporting the worksheet as CSV");
  assert.equal(describeRequest("POST", "/api/connection"), "Connecting to ClickHouse");
  assert.equal(describeRequest("GET", "/api/connection"), "Checking the connection");
  assert.equal(describeRequest("POST", "/api/connection/disconnect"), "Disconnecting from ClickHouse");
  assert.equal(describeRequest("POST", "/api/relationships/preview"), "Checking how well the join matches");
  assert.equal(describeRequest("GET", "/api/never-heard-of-it"), "Loading data");
});
test("encoded names are decoded; a malformed escape does not throw", () => {
  assert.equal(describeRequest("GET", "/api/databases/my%20db/tables"), "Loading tables in my db");
  assert.doesNotThrow(() => describeRequest("GET", "/api/databases/%E0%A4%A/tables"));
});
test("tracker counts in-flight requests and notifies on start and end", () => {
  let t = 1000; const a = createActivity({ now: () => t }); let n = 0; a.subscribe(() => n++);
  const x = a.start("Loading databases"); t = 4000; const y = a.start("Loading databases");
  assert.deepEqual(a.snapshot(), { count: 2, labels: ["Loading databases ×2"], oldestMs: 3000 });
  a.end(x); a.end(x); a.end(y); // a second end of the same id is a no-op
  assert.equal(a.snapshot().count, 0); assert.equal(n, 4);
});
test("elapsed text is quiet under 2 s and then plain", () => {
  assert.equal(elapsedText(1900), ""); assert.equal(elapsedText(3200), "3 s"); assert.equal(elapsedText(65000), "1 min 5 s");
});
test("the line names the oldest request, the others, the time, and reassures on a long wait", () => {
  assert.equal(activityLine({ count: 0, labels: [], oldestMs: 0 }), "");
  assert.equal(activityLine({ count: 1, labels: ["Loading databases"], oldestMs: 500 }), "Loading databases…");
  assert.equal(activityLine({ count: 3, labels: ["Running the worksheet query", "Loading rows"], oldestMs: 4000 }), "Running the worksheet query… (+2 more) · 4 s");
  assert.match(activityLine({ count: 1, labels: ["Running the worksheet query"], oldestMs: 12000 }), /12 s — still waiting on ClickHouse$/);
});
