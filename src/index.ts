import { env } from 'cloudflare:workers';

import { createMcpAgent } from '@cloudflare/playwright-mcp';

export const PlaywrightMCP = createMcpAgent(env.BROWSER);

// CORS headers for cross-origin requests
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const { pathname } = new URL(request.url);

    switch (pathname) {
      case '/sse':
      case '/sse/message':
        return PlaywrightMCP.serveSSE('/sse').fetch(request, env, ctx);
      case '/mcp':
        // Add CORS headers to MCP responses
        const mcpResponse = PlaywrightMCP.serve('/mcp').fetch(request, env, ctx);
        return new Response(mcpResponse.body, {
          status: mcpResponse.status,
          headers: {
            ...Object.fromEntries(mcpResponse.headers),
            ...CORS_HEADERS,
          },
        });
      default:
        return new Response('Not Found', { status: 404 });
    }
  },
};
