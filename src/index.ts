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
    const { pathname } = new URL(request.url);

    console.log(`[MCP] ${request.method} ${pathname}`);

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
          // Handle GET for MCP discovery (what most MCP UIs use)
          if (request.method === 'GET') {
            return new Response(JSON.stringify({ 
              name: 'playwright-mcp',
              version: '1.0.0',
              capabilities: {}
            }), {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...CORS_HEADERS,
              },
            });
          }
          
          // Handle POST for MCP JSON-RPC
          if (request.method === 'POST') {
            let body = '';
            try {
              body = await request.text();
            } catch (e) {
              body = '{}';
            }
            
            console.log('[MCP] POST body:', body);
            
            // Create a new request with proper body
            const mcpRequest = new Request(request.url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              body: body,
            });
            
            const mcpServer = PlaywrightMCP.serve('/mcp');
            const mcpResponse = await mcpServer.fetch(mcpRequest, env, ctx);
            
            const responseText = await mcpResponse.text();
            console.log('[MCP] Response:', mcpResponse.status, responseText.substring(0, 200));
            
            return new Response(responseText, {
              status: mcpResponse.status || 200,
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                ...CORS_HEADERS,
              },
            });
          }
          
          // Method not allowed
          return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
          
        } catch (error) {
          const errorMsg = String(error);
          console.error('[MCP] Error:', errorMsg);
          return new Response(JSON.stringify({ 
            error: errorMsg, 
            stack: error?.stack 
          }), {
            status: 200, // Return 200 even on error so the UI can parse the JSON
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
        }
      case '/tools':
        // Alias for /mcp tools/list
        if (request.method === 'GET' || request.method === 'POST') {
          try {
            const mcpServer = PlaywrightMCP.serve('/mcp');
            const mockRequest = new Request(request.url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
            });
            const mcpResponse = await mcpServer.fetch(mockRequest, env, ctx);
            const text = await mcpResponse.text();
            return new Response(text, {
              status: 200,
              headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            });
          } catch (e) {
            return new Response(JSON.stringify({ error: String(e) }), {
              status: 200,
              headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            });
          }
        }
        return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
      case '/health':
        return new Response(JSON.stringify({ 
          status: 'ok', 
          hasBrowser: !!env.BROWSER,
          version: '3'
        }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      default:
        return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
    }
  },
};
