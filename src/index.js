import api, { route, fetch } from '@forge/api';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * MCP Action Handler: fetch-external-logs
 * Accepts an incidentId or serviceName payload, performs a mocked HTTP GET request
 * to https://api.datadoghq.com/api/v1/query (via permissions.external.fetch.backend),
 * and returns a simulated Sev-1 error stack trace ("OOM Killed in Redis Cache Cluster").
 */
export async function fetchExternalLogs(payload = {}, context) {
  const incidentId = payload.incidentId || payload.incidentKey || 'INC-REDIS-701';
  const serviceName = payload.serviceName || 'redis-cache-cluster';
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - 900;

  const datadogUrl = `https://api.datadoghq.com/api/v1/query?from=${fromSec}&to=${nowSec}&query=${encodeURIComponent(
    `avg:redis.mem.used{service:${serviceName}}`
  )}`;

  console.log(`[SevZero MCP] Fetching external Datadog logs for incidentId=${incidentId}, serviceName=${serviceName}`);
  console.log(`[SevZero MCP] Outbound GET ${datadogUrl}`);

  let datadogHttpStatus = 'mocked-200';
  try {
    const ddResponse = await fetch(datadogUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'DD-API-KEY': 'sevzero-hackathon-mock-dd-api-key',
        'DD-APPLICATION-KEY': 'sevzero-hackathon-mock-dd-app-key'
      }
    });
    datadogHttpStatus = ddResponse.status;
  } catch (err) {
    console.warn(`[SevZero MCP] Datadog fetch completed via simulated fallback: ${err.message}`);
  }

  const simulatedStackTrace = [
    `[SEV-1 CRITICAL] OOM Killed in Redis Cache Cluster`,
    `Service: ${serviceName} | Incident ID: ${incidentId}`,
    `Timestamp: ${new Date(nowSec * 1000).toISOString()}`,
    `Node: redis-cache-cluster-primary-01 (10.42.19.84:6379)`,
    `Kernel Event: Out of memory: Killed process 9412 (redis-server) total-vm:33554432kB, anon-rss:32768000kB`,
    `Error Trace:`,
    `  at zmalloc_oom_handler (zmalloc.c:296) -> OOM Killed in Redis Cache Cluster: maxmemory (32GB) exhausted`,
    `  at freeMemoryIfNeeded (evict.c:614) -> eviction policy set to 'noeviction', write command rejected (OOM command not allowed when used memory > 'maxmemory')`,
    `  at processInputBuffer (networking.c:2410) -> unbounded client pipeline burst on hot key prefix 'session:cart:*'`,
    `  at replicationFeedSlaves (replication.c:1842) -> replica output buffer overflow (client-output-buffer-limit slave 512mb exceeded)`
  ].join('\n');

  return {
    status: 'success',
    source: 'https://api.datadoghq.com/api/v1/query',
    datadogHttpStatus,
    severity: 'Sev-1',
    incidentId,
    serviceName,
    rootCauseHeadline: 'OOM Killed in Redis Cache Cluster',
    logs: simulatedStackTrace
  };
}

/**
 * Helper to discover a target Confluence spaceId on the tenant so POST /wiki/api/v2/pages succeeds.
 */
async function resolveConfluenceSpaceId(preferredSpaceId) {
  if (preferredSpaceId && /^\d+$/.test(String(preferredSpaceId))) {
    return String(preferredSpaceId);
  }

  try {
    const response = await api.asApp().requestConfluence(route`/wiki/api/v2/spaces?limit=25`, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    if (response.ok) {
      const data = await response.json();
      const spaces = data?.results || [];
      if (spaces.length > 0) {
        const targetSpace = spaces.find((s) => s.key === 'SD' || s.type !== 'personal') || spaces[0];
        return String(targetSpace.id);
      }
    } else {
      console.warn(`[SevZero RCA] GET /wiki/api/v2/spaces returned ${response.status}`);
    }
  } catch (err) {
    console.warn(`[SevZero RCA] Space lookup error: ${err.message}`);
  }
  return '491524';
}

/**
 * Rovo Action Handler: draft-confluence-rca
 * Accepts the incident summary and the logs fetched from the MCP tool,
 * and calls @forge/api asApp().requestConfluence(...) to POST /wiki/api/v2/pages
 * with sections for "Incident Summary", "Root Cause (from Datadog)", and "Remediation Steps".
 */
export async function draftConfluenceRca(payload = {}, context) {
  const incidentId = payload.incidentId || payload.incidentKey || 'INC-REDIS-701';
  const summary =
    payload.summary ||
    'Sev-1 production incident in the Redis Cache Cluster causing elevated latency and failed cache writes.';
  const logs =
    payload.logs ||
    payload.rootCause ||
    '[SEV-1 CRITICAL] OOM Killed in Redis Cache Cluster (maxmemory exhausted with noeviction policy).';
  const remediation =
    payload.remediation ||
    [
      '1. Immediately scale Redis Cache Cluster memory tier and switch maxmemory-policy from noeviction to allkeys-lru.',
      '2. Enforce TTL bounds and rate-limiting on session:cart:* pipeline writes.',
      '3. Configure Datadog memory utilization monitors to page on-call SREs at 75% and 85% RSS thresholds.'
    ].join('\n');

  const timestampSuffix = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const pageTitle = `RCA: ${incidentId} - Redis Cache Cluster Incident (${timestampSuffix})`;

  const rcaStorageHtml = [
    `<p><strong>Incident ID:</strong> ${escapeHtml(incidentId)} | <strong>Severity:</strong> Sev-1 | <strong>Generated by:</strong> SevZero Autonomous SRE Agent</p>`,
    `<h2>Incident Summary</h2>`,
    `<p>${escapeHtml(summary)}</p>`,
    `<h2>Root Cause (from Datadog)</h2>`,
    `<p>Telemetry retrieved from Datadog (<code>https://api.datadoghq.com/api/v1/query</code>) confirmed an Out-Of-Memory (OOM) kill event in the Redis Cache Cluster:</p>`,
    `<pre><code>${escapeHtml(logs)}</code></pre>`,
    `<h2>Remediation Steps</h2>`,
    `<ol>`,
    `<li><strong>Immediate Mitigation:</strong> Scale up the Redis Cache Cluster memory allocation and update <code>maxmemory-policy</code> from <code>noeviction</code> to <code>allkeys-lru</code> to prevent write lockouts.</li>`,
    `<li><strong>Application Fix:</strong> Bound pipeline batch sizes and enforce strict TTL expiration on <code>session:cart:*</code> keys.</li>`,
    `<li><strong>Observability &amp; Prevention:</strong> Add Datadog composite alerts at 75% memory saturation and replica buffer thresholds.</li>`,
    `</ol>`,
    `<p><em>Additional Notes:</em> ${escapeHtml(remediation)}</p>`
  ].join('');

  const spaceId = await resolveConfluenceSpaceId(payload.spaceId);
  const requestBody = {
    spaceId: spaceId || '491524',
    status: 'current',
    title: pageTitle,
    body: {
      representation: 'storage',
      value: rcaStorageHtml
    }
  };

  console.log(`[SevZero RCA] Creating Confluence RCA page "${pageTitle}" in spaceId=${requestBody.spaceId}`);

  const pageResponse = await api.asApp().requestConfluence(route`/wiki/api/v2/pages`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (pageResponse.ok) {
    const createdPage = await pageResponse.json();
    const webuiLink = createdPage?._links?.webui
      ? `${createdPage._links.base || 'https://sevzero-workspace.atlassian.net/wiki'}${createdPage._links.webui}`
      : `https://sevzero-workspace.atlassian.net/wiki/spaces/SD/pages/${createdPage.id}`;

    console.log(`[SevZero RCA] Successfully created Confluence page id=${createdPage.id} at ${webuiLink}`);
    return {
      status: 'created',
      pageId: createdPage.id,
      spaceId: createdPage.spaceId || requestBody.spaceId,
      title: createdPage.title || pageTitle,
      pageUrl: webuiLink,
      sectionsIncluded: ['Incident Summary', 'Root Cause (from Datadog)', 'Remediation Steps'],
      incidentSummary: summary,
      rootCauseFromDatadog: logs,
      remediationSteps: remediation
    };
  }

  const errText = await pageResponse.text();
  console.warn(`[SevZero RCA] POST /wiki/api/v2/pages returned ${pageResponse.status}: ${errText}`);

  return {
    status: 'drafted',
    httpStatus: pageResponse.status,
    errorDetails: errText,
    title: pageTitle,
    spaceId: requestBody.spaceId,
    sectionsIncluded: ['Incident Summary', 'Root Cause (from Datadog)', 'Remediation Steps'],
    incidentSummary: summary,
    rootCauseFromDatadog: logs,
    remediationSteps: remediation,
    rcaHtml: rcaStorageHtml
  };
}

/**
 * Direct CLI / Webtrigger entrypoint to invoke the deployed SevZero SRE Agent
 * end-to-end (executes fetch-external-logs and draft-confluence-rca on Forge Cloud).
 */
export async function triggerSevZeroAgent(request, context) {
  let body = {};
  try {
    body = request?.body ? JSON.parse(request.body) : {};
  } catch (e) {
    body = { prompt: request?.body || '' };
  }

  const prompt =
    body.prompt || 'We have an incident in the Redis cache. Fetch the logs and draft an RCA.';
  const serviceName = body.serviceName || 'redis-cache-cluster';
  const incidentId = body.incidentId || 'INC-REDIS-701';

  console.log(`[SevZero Agent] Invoked with prompt: "${prompt}"`);

  // Step 1: Execute MCP Action `fetch-external-logs`
  const logResult = await fetchExternalLogs({ serviceName, incidentId }, context);

  // Step 2: Execute Rovo Action `draft-confluence-rca`
  const summary = `Sev-1 Production Incident in Redis Cache Cluster (${serviceName}): Out-Of-Memory (OOM) process termination causing cache write rejections and elevated service latency.`;
  const rcaResult = await draftConfluenceRca(
    {
      incidentId: logResult.incidentId,
      summary,
      logs: logResult.logs
    },
    context
  );

  const agentResponse = [
    `### SevZero Autonomous SRE Agent — Incident Response Complete`,
    ``,
    `**Prompt Received:** "${prompt}"`,
    ``,
    `#### 1. External Telemetry & Logs (\`fetch-external-logs\` MCP Action)`,
    `- **Endpoint Queried:** \`${logResult.source}\` (HTTP Status: \`${logResult.datadogHttpStatus}\`)`,
    `- **Service:** \`${logResult.serviceName}\` (\`${logResult.incidentId}\`)`,
    `- **Severity:** \`${logResult.severity}\``,
    `- **Root Cause Identified:** \`${logResult.rootCauseHeadline}\``,
    `\`\`\`text`,
    logResult.logs,
    `\`\`\``,
    ``,
    `#### 2. Confluence Root Cause Analysis (\`draft-confluence-rca\` Rovo Action)`,
    `- **Status:** \`${rcaResult.status}\``,
    `- **Page ID:** \`${rcaResult.pageId || 'N/A'}\``,
    `- **Page Title:** ${rcaResult.title}`,
    `- **Confluence RCA URL:** ${rcaResult.pageUrl || 'N/A'}`,
    `- **Sections Drafted:** ${rcaResult.sectionsIncluded.join(', ')}`,
    ``,
    `#### 3. Recommended Remediation Steps`,
    `1. **Immediate Mitigation:** Scale up the Redis Cache Cluster memory allocation and update \`maxmemory-policy\` from \`noeviction\` to \`allkeys-lru\` to prevent write lockouts.`,
    `2. **Application Fix:** Bound pipeline batch sizes and enforce strict TTL expiration on \`session:cart:*\` keys.`,
    `3. **Observability & Prevention:** Add Datadog composite alerts at 75% memory saturation and replica buffer thresholds.`
  ].join('\n');

  return {
    statusCode: 200,
    headers: { 'Content-Type': ['application/json'] },
    body: JSON.stringify(
      {
        agent: 'SevZero SRE Agent (sevzero-sre-agent)',
        prompt,
        actionsExecuted: ['fetch-external-logs', 'draft-confluence-rca'],
        mcpLogsResult: logResult,
        confluenceRcaResult: rcaResult,
        finalResponse: agentResponse
      },
      null,
      2
    )
  };
}

export function messageLogger(payload) {
  console.log(`Logging message: ${payload?.message}`);
}
