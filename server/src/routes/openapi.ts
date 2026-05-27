import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import rateLimit from "express-rate-limit";

const router = Router();

const docsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: "Too many API documentation requests. Please try again later.",
});

/**
 * Serve the OpenAPI specification in YAML format
 */
router.get("/", docsLimiter, (_req: Request, res: Response) => {
  try {
    const specPath = path.join(__dirname, "../../openapi.yaml");
    const spec = fs.readFileSync(specPath, "utf-8");
    res.setHeader("Content-Type", "application/yaml");
    res.send(spec);
  } catch {
    res.status(500).json({ error: "Failed to load OpenAPI specification" });
  }
});

/**
 * Serve a simple HTML page with Swagger UI for interactive API documentation
 */
router.get("/docs", docsLimiter, (_req: Request, res: Response) => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>StellarYield API Documentation</title>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@3/swagger-ui.css">
        <style>
          body { margin: 0; padding: 0; }
        </style>
      </head>
      <body>
        <div id="swagger-ui"></div>
        <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@3/swagger-ui-bundle.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@3/swagger-ui-standalone-preset.js"></script>
        <script>
          SwaggerUIBundle({
            url: "/api/openapi",
            dom_id: '#swagger-ui',
            presets: [
              SwaggerUIBundle.presets.apis,
              SwaggerUIStandalonePreset
            ],
            layout: "BaseLayout"
          });
        </script>
      </body>
    </html>
  `;
  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

export default router;
