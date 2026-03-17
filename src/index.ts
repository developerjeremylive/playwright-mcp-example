import { env } from 'cloudflare:workers';

import { createMcpAgent } from '@cloudflare/playwright-mcp';

// Create and export the Playwright MCP agent as required by wrangler
export const PlaywrightMCP = createMcpAgent(env.BROWSER);

// CORS headers for cross-origin requests
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname, searchParams } = new URL(request.url);

    // Log the request for debugging
    console.log(`[MCP] ${request.method} ${pathname}`, {
      accept: request.headers.get('Accept'),
      contentType: request.headers.get('Content-Type'),
    });

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    switch (pathname) {
      case '/sse':
      case '/sse/message':
        return PlaywrightMCP.serveSSE('/sse').fetch(request, env, ctx);
      case '/mcp':
        try {
          // Clone the request to read body for POST
          let requestClone = request;
          let bodyText = '';
          
          if (request.method === 'POST') {
            try {
              const cloned = request.clone();
              bodyText = await cloned.text();
              // Create a new request with the body
              requestClone = new Request(request.url, {
                method: 'POST',
                headers: request.headers,
                body: bodyText,
              });
            } catch (e) {
              console.error('[MCP] Failed to read body:', e);
            }
          }
          
          const mcpServer = PlaywrightMCP.serve('/mcp');
          const mcpResponse = await mcpServer.fetch(requestClone, env, ctx);
          
          const responseText = await mcpResponse.text();
          console.log(`[MCP] Response status: ${mcpResponse.status}, body: ${responseText.substring(0, 200)}`);
          
          return new Response(responseText, {
            status: mcpResponse.status || 200,
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              ...CORS_HEADERS,
            },
          });
        } catch (error) {
          const errorMsg = String(error);
          console.error('[MCP] Error:', errorMsg);
          return new Response(JSON.stringify({ 
            error: errorMsg, 
            stack: error?.stack,
            message: 'MCP server error'
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
        }
      case '/health':
        return new Response(JSON.stringify({ 
          status: 'ok', 
          hasBrowser: !!env.BROWSER,
          version: '2'
        }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      default:
        return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
    }
  },
};
