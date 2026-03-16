import { env } from 'cloudflare:workers';

import { createMcpAgent } from '@cloudflare/playwright-mcp';

// Check if BROWSER binding is available
let playwrightMCP: ReturnType<typeof createMcpAgent> | null = null;

try {
  if (env.BROWSER) {
    playwrightMCP = createMcpAgent(env.BROWSER);
  } else {
    console.error('BROWSER binding not found in env');
  }
} catch (e) {
  console.error('Failed to create Playwright MCP agent:', e);
}

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
        if (!playwrightMCP) {
          return new Response(JSON.stringify({ error: 'BROWSER binding not configured' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
        }
        return playwrightMCP.serveSSE('/sse').fetch(request, env, ctx);
      case '/mcp':
        if (!playwrightMCP) {
          return new Response(JSON.stringify({ error: 'BROWSER binding not configured' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
        }
        try {
          const mcpResponse = await playwrightMCP.serve('/mcp').fetch(request, env, ctx);
          const bodyText = await mcpResponse.text();
          return new Response(bodyText, {
            status: mcpResponse.status,
            headers: {
              'Content-Type': 'application/json',
              ...CORS_HEADERS,
            },
          });
        } catch (error) {
          return new Response(JSON.stringify({ error: String(error), stack: error?.stack }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
        }
      case '/health':
        return new Response(JSON.stringify({ 
          status: 'ok', 
          hasBrowser: !!playwrightMCP,
          hasBrowserBinding: !!env.BROWSER 
        }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      default:
        return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
    }
  },
};
