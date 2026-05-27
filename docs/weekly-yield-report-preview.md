# Weekly Yield Report Preview Fixture

## Overview

The weekly yield report preview fixture provides deterministic sample data for testing and previewing the weekly yield report template. This allows contributors to safely update copy and layout without affecting real user data.

## Accessing the Preview

### API Endpoint

```bash
GET /api/weekly-reports/preview
```

**Response:**

```json
{
  "success": true,
  "message": "Weekly yield report preview fixture",
  "data": {
    "userId": "preview-user",
    "walletAddress": "G...",
    "email": "user-preview-user@example.com",
    "userName": "User preview-user",
    "weeklyYield": 250.5,
    "weeklyYieldPercentage": 1.25,
    "totalYield": 13026.0,
    "vaultCount": 5,
    "topVaults": [
      {
        "vaultId": "vault-0",
        "vaultName": "Blend Yield",
        "yield": 150.25,
        "yieldPercentage": 0.75,
        "apy": 6.5,
        "tvl": 5000000,
        "deposits": 2500,
        "withdrawals": 1000
      }
    ],
    "period": {
      "startDate": "2024-01-01",
      "endDate": "2024-01-08"
    },
    "generatedAt": "2024-01-08T12:00:00.000Z"
  },
  "htmlPreview": "<html>...</html>"
}
```

## Using the Fixture

### 1. Preview in Browser

Open the preview endpoint in your browser to see the rendered HTML email template:

```
http://localhost:3001/api/weekly-reports/preview
```

The response includes both the JSON data and the rendered HTML preview.

### 2. Testing Template Changes

When updating the email template (`server/src/templates/weeklyYieldReportTemplate.ts`):

1. Make your changes to the template
2. Call the preview endpoint
3. Check the `htmlPreview` field in the response
4. Verify your changes render correctly

### 3. Running Tests

The preview fixture is tested in `server/src/__tests__/weeklyYieldReport.test.ts`:

```bash
cd server
npm test -- weeklyYieldReport.test.ts
```

Tests verify:

- Fixture data is generated correctly
- HTML renders without errors
- No real user data is included
- All required fields are present

## Fixture Data Structure

The preview fixture uses mock data generators:

- **User Data**: Generated with `generateMockUserYieldData("preview-user")`
- **Vault Data**: Generated with `generateMockVaultYieldData()`
- **Report**: Calculated with `calculateWeeklyYieldReport()`

All data is deterministic and safe for development/testing.

## Key Features

✅ **No Real User Data** - Uses mock data only  
✅ **Deterministic** - Same data on every call  
✅ **HTML Preview** - Includes rendered email template  
✅ **Easy Testing** - Simple API endpoint  
✅ **Safe for Contributors** - No production data exposure

## Example Usage

### cURL

```bash
curl http://localhost:3001/api/weekly-reports/preview | jq '.htmlPreview' > preview.html
open preview.html
```

### JavaScript

```typescript
const response = await fetch("/api/weekly-reports/preview");
const { data, htmlPreview } = await response.json();

console.log("Weekly Yield:", data.weeklyYield);
console.log("Top Vaults:", data.topVaults);
```

## Contributing

When updating the weekly yield report:

1. Use the preview endpoint to test changes
2. Verify the HTML renders correctly
3. Check that all data fields are displayed
4. Run tests to ensure no regressions
5. Document any new fields or changes

## Related Files

- Template: `server/src/templates/weeklyYieldReportTemplate.ts`
- Service: `server/src/services/weeklyYieldReportService.ts`
- Route: `server/src/routes/weeklyReports.ts`
- Tests: `server/src/__tests__/weeklyYieldReport.test.ts`
