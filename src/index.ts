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
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
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
        try {
          // Add CORS headers to MCP responses
          const mcpResponse = await PlaywrightMCP.serve('/mcp').fetch(request, env, ctx);
          
          // Read the response body
          const bodyText = await mcpResponse.text();
          
          return new Response(bodyText, {
            status: mcpResponse.status,
            headers: {
              'Content-Type': 'application/json',
              ...CORS_HEADERS,
            },
          });
        } catch (error) {
          return new Response(JSON.stringify({ error: String(error) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
        }
      default:
        return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
    }
  },
};
