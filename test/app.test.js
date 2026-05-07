const http = require("node:http");
const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp, isAllowedBaseUrl, syncStatusOrder } = require("../src/app");

function startServer(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function createMockJiraServer() {
  const issues = [
    { key: "APP-1", summary: "Investigate login bug", status: "Backlog" },
    { key: "APP-2", summary: "Polish timeline sync", status: "In Progress" },
  ];

  const transitions = {
    "APP-1": [{ id: "31", name: "Done" }],
    "APP-2": [{ id: "41", name: "Done" }],
  };

  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (!req.headers.authorization) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing auth" }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/rest/api/3/search/jql") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          issues: issues.map((issue) => ({
            key: issue.key,
            fields: {
              summary: issue.summary,
              status: { name: issue.status },
            },
          })),
        }),
      );
      return;
    }

    const transitionMatch = url.pathname.match(/^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/);
    if (transitionMatch && req.method === "GET") {
      const issueKey = decodeURIComponent(transitionMatch[1]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          transitions: (transitions[issueKey] || []).map((transition) => ({
            id: transition.id,
            to: { name: transition.name },
          })),
        }),
      );
      return;
    }

    if (transitionMatch && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const issueKey = decodeURIComponent(transitionMatch[1]);
        const payload = JSON.parse(body);
        const nextTransition = (transitions[issueKey] || []).find((transition) => {
          return transition.id === payload.transition.id;
        });
        const issue = issues.find((candidate) => candidate.key === issueKey);
        if (issue && nextTransition) {
          issue.status = nextTransition.name;
        }
        res.writeHead(204);
        res.end();
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}

async function createFixture() {
  const jiraServer = createMockJiraServer();
  const jiraAddress = await startServer(jiraServer);

  const app = createApp({ sessionSecret: "test-secret" });
  const appServer = http.createServer(app);
  const appAddress = await startServer(appServer);

  return {
    jiraServer,
    appServer,
    jiraBaseUrl: `http://127.0.0.1:${jiraAddress.port}`,
    appBaseUrl: `http://127.0.0.1:${appAddress.port}`,
  };
}

test("accepts localhost Jira URLs but rejects insecure external URLs", () => {
  assert.equal(isAllowedBaseUrl("https://example.atlassian.net"), true);
  assert.equal(isAllowedBaseUrl("http://127.0.0.1:9999"), true);
  assert.equal(isAllowedBaseUrl("http://example.atlassian.net"), false);
});

test("syncStatusOrder preserves chosen order and appends new statuses", () => {
  assert.deepEqual(syncStatusOrder(["Done", "Backlog"], ["Backlog", "In Progress", "Done"]), [
    "Done",
    "Backlog",
    "In Progress",
  ]);
});

test("stores a Jira session, returns grouped issues, and lets the phone view reorder statuses", async () => {
  const fixture = await createFixture();

  try {
    const loginResponse = await fetch(`${fixture.appBaseUrl}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: fixture.jiraBaseUrl,
        email: "user@example.com",
        apiToken: "token",
      }),
    });

    assert.equal(loginResponse.status, 201);
    const cookie = loginResponse.headers.get("set-cookie");
    const loginPayload = await loginResponse.json();
    assert.deepEqual(loginPayload.statuses, ["Backlog", "In Progress"]);
    assert.equal(loginPayload.issuesByStatus[0].issues[0].key, "APP-1");

    const orderResponse = await fetch(`${fixture.appBaseUrl}/api/status-order`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ statuses: ["In Progress", "Backlog"] }),
    });

    assert.equal(orderResponse.status, 200);
    const orderPayload = await orderResponse.json();
    assert.deepEqual(orderPayload.statuses, ["In Progress", "Backlog"]);
    assert.equal(orderPayload.issuesByStatus[0].issues[0].key, "APP-2");
  } finally {
    await closeServer(fixture.appServer);
    await closeServer(fixture.jiraServer);
  }
});

test("returns available transitions and updates issue status for the watch flow", async () => {
  const fixture = await createFixture();

  try {
    const loginResponse = await fetch(`${fixture.appBaseUrl}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: fixture.jiraBaseUrl,
        email: "user@example.com",
        apiToken: "token",
      }),
    });
    const cookie = loginResponse.headers.get("set-cookie");

    const transitionsResponse = await fetch(`${fixture.appBaseUrl}/api/issues/APP-1/transitions`, {
      headers: { Cookie: cookie },
    });
    assert.equal(transitionsResponse.status, 200);
    const transitionsPayload = await transitionsResponse.json();
    assert.deepEqual(transitionsPayload.transitions, [{ id: "31", name: "Done" }]);

    const updateResponse = await fetch(`${fixture.appBaseUrl}/api/issues/APP-1/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ status: "Done" }),
    });
    assert.equal(updateResponse.status, 200);
    const updatePayload = await updateResponse.json();
    assert.equal(updatePayload.issue.status, "Done");
    assert.deepEqual(updatePayload.statuses, ["In Progress", "Done"]);
  } finally {
    await closeServer(fixture.appServer);
    await closeServer(fixture.jiraServer);
  }
});
