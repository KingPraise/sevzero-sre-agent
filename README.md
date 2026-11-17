# SevZero — Autonomous SRE Incident Response Agent

**SevZero** (`sevzero-sre-agent`) is an Autonomous Site Reliability Engineering (SRE) Incident Response Agent built on **Atlassian Forge** and **Atlassian Rovo** for **Codegeist 2026**.

SevZero accelerates incident triage and post-incident documentation by correlating Jira Service Management (JSM) alerts, Bitbucket deployment history, and external observability logs (Datadog / AWS CloudWatch) via the Model Context Protocol (`rovo:mcp`), and automatically drafting structured Root Cause Analysis (RCA) pages in Confluence.

---

## Architecture & Forge Modules

Defined in [`manifest.yml`](./manifest.yml) and implemented in [`src/index.js`](./src/index.js):

1. **`rovo:agent` (`sevzero-sre-agent`)**
   - Autonomous SRE AI teammate configured with incident triage instructions and conversation starters.
   - Orchestrates log retrieval (`fetch-external-logs`) followed immediately by Confluence RCA creation (`draft-confluence-rca`).
2. **`action` (`rovo:action` modules)**
   - **`fetch-external-logs`** (`index.fetchExternalLogs`): Queries external observability endpoints (`https://api.datadoghq.com/api/v1/query`) via `@forge/api` `fetch` and returns structured `Sev-1` error telemetry and stack traces (e.g., `OOM Killed in Redis Cache Cluster`).
   - **`draft-confluence-rca`** (`index.draftConfluenceRca`): Dynamically resolves the target Confluence space via `GET /wiki/api/v2/spaces` and publishes a formatted Root Cause Analysis page via `api.asApp().requestConfluence(route'/wiki/api/v2/pages', { method: 'POST', ... })` containing:
     - **Incident Summary**
     - **Root Cause (from Datadog)**
     - **Remediation Steps**
3. **`rovo:mcp` (`sevzero-external-logs-mcp`)**
   - Exposes `fetch-external-logs` and `draft-confluence-rca` as Model Context Protocol (MCP) tools.
4. **`webtrigger` (`sevzero-agent-trigger`)**
   - Direct HTTP trigger (`index.triggerSevZeroAgent`) for CLI and automated testing when Rovo Chat UI is restricted on a workspace domain.

---

## Permissions & External Egress

- **Scopes**:
  - `read:jira-work` & `read:servicedesk-request` (Jira Service Management incident context)
  - `write:confluence-content`, `write:page:confluence`, `read:page:confluence`, `read:space:confluence` (Confluence REST API v2 RCA authoring)
  - `read:source-code:jira-software` & `read:devops-component-info:jira` (Source code & deployment correlation)
- **Backend Egress (`permissions.external.fetch.backend`)**:
  - `https://api.datadoghq.com`
  - `https://logs.amazonaws.com`
  - `https://api.bitbucket.org`

---

## Getting Started

### Prerequisites
- Node.js `^22.23.4` or `>=24.22.1`
- Atlassian Forge CLI (`npm install -g @forge/cli@latest`)

### Install Dependencies & Validate
```bash
npm install
forge lint
```

### Deploy & Install
```bash
# Deploy to development or production
forge deploy -e development --non-interactive
forge deploy -e production --non-interactive

# Install onto Jira and Confluence on your Atlassian Cloud site
forge install --non-interactive --site <your-site.atlassian.net> --product jira --environment development --confirm-scopes
forge install --non-interactive --site <your-site.atlassian.net> --product confluence --environment development --confirm-scopes
```

### Direct CLI / Webtrigger Test
```bash
forge webtrigger create -s <your-site.atlassian.net> -p confluence -e development -f sevzero-agent-trigger
```
Send a `POST` request to the generated webtrigger URL:
```json
{
  "prompt": "We have an incident in the Redis cache. Fetch the logs and draft an RCA."
}
```
