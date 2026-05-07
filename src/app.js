const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");

const SESSION_COOKIE = "pebble_jira_sync";
const DEFAULT_JQL = "assignee = currentUser() ORDER BY updated DESC";

function createSessionStore() {
  const sessions = new Map();

  return {
    get(sessionId) {
      return sessions.get(sessionId);
    },
    set(sessionId, value) {
      sessions.set(sessionId, value);
    },
    delete(sessionId) {
      sessions.delete(sessionId);
    },
  };
}

function signValue(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function createCookieValue(sessionId, secret) {
  return `${sessionId}.${signValue(sessionId, secret)}`;
}

function parseCookies(headerValue) {
  if (!headerValue) {
    return {};
  }

  return headerValue.split(";").reduce((cookies, entry) => {
    const [name, ...valueParts] = entry.trim().split("=");
    cookies[name] = decodeURIComponent(valueParts.join("="));
    return cookies;
  }, {});
}

function readSessionId(req, secret) {
  const cookies = parseCookies(req.headers.cookie);
  const value = cookies[SESSION_COOKIE];

  if (!value) {
    return null;
  }

  const [sessionId, signature] = value.split(".");
  if (!sessionId || !signature) {
    return null;
  }

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(signValue(sessionId, secret)),
  )
    ? sessionId
    : null;
}

function buildSessionCookie(sessionId, secret, secure) {
  const parts = [
    `${SESSION_COOKIE}=${createCookieValue(sessionId, secret)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ];

  if (secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function isAllowedBaseUrl(baseUrl) {
  let parsedUrl;

  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return false;
  }

  if (parsedUrl.protocol === "https:") {
    return true;
  }

  return (
    parsedUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(parsedUrl.hostname)
  );
}

function normalizeBaseUrl(baseUrl) {
  let normalized = baseUrl;

  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

function toIssueSummary(issue) {
  return {
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status.name,
  };
}

function syncStatusOrder(existingOrder, availableStatuses) {
  const dedupedExisting = (existingOrder || []).filter((status, index, values) => {
    return availableStatuses.includes(status) && values.indexOf(status) === index;
  });

  const missingStatuses = availableStatuses.filter((status) => {
    return !dedupedExisting.includes(status);
  });

  return [...dedupedExisting, ...missingStatuses];
}

async function jiraRequest(session, endpoint, options = {}, fetchImpl = fetch) {
  const requestUrl = new URL(endpoint, session.baseUrl);
  const response = await fetchImpl(requestUrl, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${session.email}:${session.apiToken}`).toString("base64")}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(errorText || `Jira request failed with status ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function loadBoard(session, fetchImpl = fetch) {
  const searchParams = new URLSearchParams({
    jql: session.jql || DEFAULT_JQL,
    maxResults: "50",
    fields: "summary,status",
  });
  const payload = await jiraRequest(
    session,
    `/rest/api/3/search/jql?${searchParams.toString()}`,
    {},
    fetchImpl,
  );
  const issues = payload.issues.map(toIssueSummary);
  const availableStatuses = [...new Set(issues.map((issue) => issue.status))];
  const statusOrder = syncStatusOrder(session.statusOrder, availableStatuses);

  session.statusOrder = statusOrder;

  return {
    statuses: statusOrder,
    issuesByStatus: statusOrder.map((status) => ({
      status,
      issues: issues.filter((issue) => issue.status === status),
    })),
  };
}

async function loadTransitions(session, issueKey, fetchImpl = fetch) {
  const payload = await jiraRequest(
    session,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    {},
    fetchImpl,
  );

  return payload.transitions.map((transition) => ({
    id: transition.id,
    name: transition.to.name,
  }));
}

function getSession(req, store, secret) {
  const sessionId = readSessionId(req, secret);
  if (!sessionId) {
    return null;
  }

  const session = store.get(sessionId);
  if (!session) {
    return null;
  }

  return { sessionId, session };
}

function createApp({ fetchImpl = fetch, sessionSecret, sessionStore } = {}) {
  const app = express();
  const secret = sessionSecret || process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
  const store = sessionStore || createSessionStore();

  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/api/status-board", async (req, res) => {
    const sessionState = getSession(req, store, secret);
    if (!sessionState) {
      res.json({ authenticated: false, defaultJql: DEFAULT_JQL });
      return;
    }

    try {
      const board = await loadBoard(sessionState.session, fetchImpl);
      res.json({
        authenticated: true,
        baseUrl: sessionState.session.baseUrl,
        email: sessionState.session.email,
        jql: sessionState.session.jql,
        ...board,
      });
    } catch (error) {
      res.status(error.statusCode || 502).json({
        authenticated: false,
        error: "Unable to load Jira issues.",
        details: error.message,
      });
    }
  });

  app.post("/api/session", async (req, res) => {
    const { baseUrl, email, apiToken, jql } = req.body;

    if (!baseUrl || !email || !apiToken || !isAllowedBaseUrl(baseUrl)) {
      res.status(400).json({
        error: "Provide a Jira base URL over HTTPS (or localhost for local development), email, and API token.",
      });
      return;
    }

    const sessionId = crypto.randomUUID();
    const session = {
      baseUrl: normalizeBaseUrl(baseUrl),
      email,
      apiToken,
      jql: jql || DEFAULT_JQL,
      statusOrder: [],
    };

    try {
      const board = await loadBoard(session, fetchImpl);
      store.set(sessionId, session);
      res.setHeader(
        "Set-Cookie",
        buildSessionCookie(sessionId, secret, req.secure || req.headers["x-forwarded-proto"] === "https"),
      );
      res.status(201).json({
        authenticated: true,
        baseUrl: session.baseUrl,
        email: session.email,
        jql: session.jql,
        ...board,
      });
    } catch (error) {
      res.status(error.statusCode || 502).json({
        error: "Unable to authenticate with Jira.",
        details: error.message,
      });
    }
  });

  app.delete("/api/session", (req, res) => {
    const sessionState = getSession(req, store, secret);
    if (sessionState) {
      store.delete(sessionState.sessionId);
    }

    res.setHeader("Set-Cookie", clearSessionCookie());
    res.status(204).end();
  });

  app.put("/api/status-order", async (req, res) => {
    const sessionState = getSession(req, store, secret);
    if (!sessionState) {
      res.status(401).json({ error: "Sign in to Jira first." });
      return;
    }

    const { statuses } = req.body;
    const board = await loadBoard(sessionState.session, fetchImpl);

    if (
      !Array.isArray(statuses) ||
      statuses.length !== board.statuses.length ||
      new Set(statuses).size !== statuses.length ||
      statuses.some((status) => !board.statuses.includes(status))
    ) {
      res.status(400).json({ error: "Send a complete ordered list of known statuses." });
      return;
    }

    sessionState.session.statusOrder = [...statuses];
    res.json({
      statuses: sessionState.session.statusOrder,
      issuesByStatus: sessionState.session.statusOrder.map((status) => ({
        status,
        issues: board.issuesByStatus.find((group) => group.status === status)?.issues || [],
      })),
    });
  });

  app.get("/api/issues/:issueKey/transitions", async (req, res) => {
    const sessionState = getSession(req, store, secret);
    if (!sessionState) {
      res.status(401).json({ error: "Sign in to Jira first." });
      return;
    }

    try {
      const transitions = await loadTransitions(sessionState.session, req.params.issueKey, fetchImpl);
      res.json({ issueKey: req.params.issueKey, transitions });
    } catch (error) {
      res.status(error.statusCode || 502).json({
        error: "Unable to load transitions for the issue.",
        details: error.message,
      });
    }
  });

  app.post("/api/issues/:issueKey/status", async (req, res) => {
    const sessionState = getSession(req, store, secret);
    if (!sessionState) {
      res.status(401).json({ error: "Sign in to Jira first." });
      return;
    }

    const { status } = req.body;
    if (!status) {
      res.status(400).json({ error: "Choose a target status." });
      return;
    }

    try {
      const transitions = await loadTransitions(sessionState.session, req.params.issueKey, fetchImpl);
      const transition = transitions.find((candidate) => candidate.name === status);

      if (!transition) {
        res.status(400).json({ error: "That transition is not available for the issue." });
        return;
      }

      await jiraRequest(
        sessionState.session,
        `/rest/api/3/issue/${encodeURIComponent(req.params.issueKey)}/transitions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ transition: { id: transition.id } }),
        },
        fetchImpl,
      );

      const board = await loadBoard(sessionState.session, fetchImpl);
      const issue = board.issuesByStatus
        .flatMap((group) => group.issues)
        .find((candidate) => candidate.key === req.params.issueKey);

      res.json({ issue, statuses: board.statuses, issuesByStatus: board.issuesByStatus });
    } catch (error) {
      res.status(error.statusCode || 502).json({
        error: "Unable to update the issue status.",
        details: error.message,
      });
    }
  });

  return app;
}

module.exports = {
  DEFAULT_JQL,
  createApp,
  createSessionStore,
  isAllowedBaseUrl,
  syncStatusOrder,
};
