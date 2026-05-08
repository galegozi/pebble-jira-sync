/* global Pebble, localStorage, XMLHttpRequest */

// ── Message keys (must match appinfo.json appKeys and src/main.c) ─────────
var KEY_CMD           = 0;
var KEY_INDEX         = 1;
var KEY_ISSUE_KEY     = 2;
var KEY_ISSUE_SUMMARY = 3;
var KEY_ISSUE_STATUS  = 4;
var KEY_TRANS_ID      = 5;
var KEY_TRANS_NAME    = 6;
var KEY_MSG           = 7;

// ── Commands ──────────────────────────────────────────────────────────────
var CMD_GET_ISSUES  = 0;
var CMD_ISSUE_DATA  = 1;
var CMD_ISSUES_DONE = 2;
var CMD_GET_TRANS   = 3;
var CMD_TRANS_DATA  = 4;
var CMD_TRANS_DONE  = 5;
var CMD_APPLY_TRANS = 6;
var CMD_SUCCESS     = 7;
var CMD_ERROR       = 8;

var DEFAULT_JQL = 'assignee = currentUser() ORDER BY updated DESC';

// Must match MAX_ISSUES in src/main.c.
var MAX_ISSUES = 20;

// ── In-memory issue cache (reloaded on every CMD_GET_ISSUES) ─────────────
var cachedIssues = [];

// ── Reliable send queue ───────────────────────────────────────────────────
var msgQueue = [];
var msgSending = false;

function enqueue(dict) {
  msgQueue.push(dict);
  if (!msgSending) {
    sendNext();
  }
}

function sendNext() {
  if (msgQueue.length === 0) {
    msgSending = false;
    return;
  }
  msgSending = true;
  var dict = msgQueue.shift();
  Pebble.sendAppMessage(
    dict,
    function () { sendNext(); },
    function () {
      // Retry once on failure.
      msgQueue.unshift(dict);
      setTimeout(sendNext, 150);
    }
  );
}

// ── Settings helpers ──────────────────────────────────────────────────────
function getSettings() {
  return {
    baseUrl:  localStorage.getItem('jira_base_url')   || '',
    email:    localStorage.getItem('jira_email')      || '',
    apiToken: localStorage.getItem('jira_api_token')  || '',
    jql:      localStorage.getItem('jira_jql')        || DEFAULT_JQL,
  };
}

function saveSettings(config) {
  // Pebble pkjs provides only localStorage for persistent storage on the phone.
  // Credentials are stored here so the app can authenticate with Jira across
  // watch app restarts without requiring the user to re-enter them each time.
  if (config.baseUrl)  localStorage.setItem('jira_base_url',   config.baseUrl);
  if (config.email)    localStorage.setItem('jira_email',      config.email);
  if (config.apiToken) localStorage.setItem('jira_api_token',  config.apiToken);
  if (config.jql)      localStorage.setItem('jira_jql',        config.jql);
}

// ── Jira helpers ──────────────────────────────────────────────────────────
function makeAuthHeader(email, apiToken) {
  return 'Basic ' + btoa(email + ':' + apiToken);
}

function jiraGet(settings, path, callback) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', settings.baseUrl + path, true);
  xhr.setRequestHeader('Authorization', makeAuthHeader(settings.email, settings.apiToken));
  xhr.setRequestHeader('Accept', 'application/json');
  xhr.onload = function () {
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        callback(null, JSON.parse(xhr.responseText));
      } catch (e) {
        callback('JSON parse error');
      }
    } else {
      callback('Jira error ' + xhr.status);
    }
  };
  xhr.onerror = function () { callback('Network error'); };
  xhr.send();
}

function jiraPost(settings, path, body, callback) {
  var xhr = new XMLHttpRequest();
  xhr.open('POST', settings.baseUrl + path, true);
  xhr.setRequestHeader('Authorization', makeAuthHeader(settings.email, settings.apiToken));
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onload = function () {
    if (xhr.status === 204) {
      callback(null);
    } else {
      callback('Jira error ' + xhr.status);
    }
  };
  xhr.onerror = function () { callback('Network error'); };
  xhr.send(JSON.stringify(body));
}

// ── Outgoing helpers ──────────────────────────────────────────────────────
function sendError(message) {
  var dict = {};
  dict[KEY_CMD] = CMD_ERROR;
  dict[KEY_MSG] = message.substring(0, STR_LEN - 1);
  enqueue(dict);
}

var STR_LEN = 64;

function truncate(str) {
  return (str || '').substring(0, STR_LEN - 1);
}

// ── App message handling ──────────────────────────────────────────────────
Pebble.addEventListener('ready', function () {
  // Nothing to do on ready; we wait for the watch to request data.
});

Pebble.addEventListener('appmessage', function (event) {
  var payload  = event.payload;
  var cmd      = payload[KEY_CMD];
  var settings = getSettings();

  if (!settings.baseUrl || !settings.email || !settings.apiToken) {
    sendError('Configure Jira in app settings');
    return;
  }

  if (cmd === CMD_GET_ISSUES) {
    var params =
      'jql='        + encodeURIComponent(settings.jql) +
      '&maxResults=' + MAX_ISSUES +
      '&fields=summary,status';

    jiraGet(settings, '/rest/api/3/search/jql?' + params, function (err, data) {
      if (err) { sendError(err); return; }

      cachedIssues = data.issues.map(function (issue) {
        return {
          key:     issue.key,
          summary: issue.fields.summary,
          status:  issue.fields.status.name,
        };
      });

      cachedIssues.forEach(function (issue, index) {
        var dict = {};
        dict[KEY_CMD]           = CMD_ISSUE_DATA;
        dict[KEY_INDEX]         = index;
        dict[KEY_ISSUE_KEY]     = truncate(issue.key);
        dict[KEY_ISSUE_SUMMARY] = truncate(issue.summary);
        dict[KEY_ISSUE_STATUS]  = truncate(issue.status);
        enqueue(dict);
      });

      var done = {};
      done[KEY_CMD] = CMD_ISSUES_DONE;
      enqueue(done);
    });

  } else if (cmd === CMD_GET_TRANS) {
    var issueIndex = payload[KEY_INDEX];
    var issue      = cachedIssues[issueIndex];
    if (!issue) { sendError('Issue not found'); return; }

    var transPath = '/rest/api/3/issue/' + encodeURIComponent(issue.key) + '/transitions';
    jiraGet(settings, transPath, function (err, data) {
      if (err) { sendError(err); return; }

      data.transitions.forEach(function (t, index) {
        if (!t.to) return;
        var dict = {};
        dict[KEY_CMD]        = CMD_TRANS_DATA;
        dict[KEY_INDEX]      = index;
        dict[KEY_TRANS_ID]   = truncate(t.id);
        dict[KEY_TRANS_NAME] = truncate(t.to.name);
        enqueue(dict);
      });

      var done = {};
      done[KEY_CMD] = CMD_TRANS_DONE;
      enqueue(done);
    });

  } else if (cmd === CMD_APPLY_TRANS) {
    var issueIndex  = payload[KEY_INDEX];
    var transId     = payload[KEY_TRANS_ID];
    var issue       = cachedIssues[issueIndex];
    if (!issue)   { sendError('Issue not found');    return; }
    if (!transId) { sendError('No transition ID');   return; }

    var applyPath = '/rest/api/3/issue/' + encodeURIComponent(issue.key) + '/transitions';
    jiraPost(settings, applyPath, { transition: { id: transId } }, function (err) {
      if (err) { sendError(err); return; }
      var dict = {};
      dict[KEY_CMD] = CMD_SUCCESS;
      enqueue(dict);
    });
  }
});

// ── Configuration page ────────────────────────────────────────────────────
Pebble.addEventListener('showConfiguration', function () {
  var settings = getSettings();
  var params =
    'baseUrl=' + encodeURIComponent(settings.baseUrl) +
    '&email='  + encodeURIComponent(settings.email)   +
    '&jql='    + encodeURIComponent(settings.jql);

  // Replace the placeholder URL with the actual hosted config page URL.
  // During local development the Express server serves this at:
  //   http://localhost:3000/pebble-config.html
  Pebble.openURL('http://localhost:3000/pebble-config.html?' + params);
});

Pebble.addEventListener('webviewclosed', function (event) {
  if (!event.response) return;
  try {
    var config = JSON.parse(decodeURIComponent(event.response));
    saveSettings(config);
  } catch (e) {
    // Ignore malformed responses.
  }
});
