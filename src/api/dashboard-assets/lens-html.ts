import type { DashboardClientConfig } from './types';

export function renderLensHtml(config?: DashboardClientConfig): string {
  const revision = encodeURIComponent(config?.asset_revision || 'dev');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="symphony-lens-asset-revision" content="${revision}" />
  <title>Symphony Control Constellation — Living Agent Lens</title>
  <link rel="icon" href="data:," />
  <link rel="stylesheet" href="/lens/styles.css?v=${revision}" />
  <script src="/lens/client.js?v=${revision}" defer></script>
</head>
<body>
  <div id="lens-root"></div>
</body>
</html>`;
}
