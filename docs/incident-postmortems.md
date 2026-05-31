# Incident Postmortems

Incident records should link to a public postmortem after the incident is
mitigated or resolved. This keeps operator notes, transparency views, and user
communications aligned around the same source of truth.

## Template

Start from [`docs/postmortems/TEMPLATE.md`](./postmortems/TEMPLATE.md).

Create incident-specific files with this path shape:

```text
docs/postmortems/YYYY-MM-DD-incident-title-slug.md
```

Use the incident start date in UTC. Keep the slug short and based on the public
incident title.

## Required Sections

Every public postmortem must include:

- `Summary`
- `Impact`
- `Timeline`
- `Root Cause`
- `Resolution`
- `Prevention`
- `Public Transparency Note`

## Linking Flow

1. Create the incident through `POST /api/incidents` as soon as the event is
   confirmed.
2. During response, keep the incident `description` focused on current user
   impact and operational status.
3. After mitigation, copy the template to the incident-specific file path and
   complete the required sections.
4. Link the incident record to the postmortem with a `postmortemUrl` metadata
   field in API consumers or transparency data exports.
5. Render that link in transparency views when the incident is resolved or in
   monitoring status.

The current database schema does not store `postmortemUrl` directly. Until that
field is persisted, services and dashboards should use the guidance helper in
`IncidentService` to generate the expected repository path and display label.

## Link Safety

- Link only repository docs, status pages, or governance posts approved for
  public release.
- Do not link private dashboards, logs, provider consoles, internal chat, or
  raw monitoring dumps.
- Redact keys, wallet secrets, customer data, and exploit reproduction details
  before publishing.
