import { env } from 'cloudflare:workers';

// CORS headers for cross-origin requests
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
};

// Simple in-memory browser state
let browserPage: any = null;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname, searchParams } = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    console.log(`[MCP] ${request.method} ${pathname}`);

    switch (pathname) {
      case '/sse':
      case '/sse/message':
        // SSE endpoints - return a simple session
        const sessionId = crypto.randomUUID();
        return new Response(
          `event: endpoint\ndata: /sse/message?sessionId=${sessionId}\n\n`,
          {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              ...CORS_HEADERS,
            },
          }
        );

      case '/mcp':
      case '/mcp/message':
        return this.handleMcpRequest(request, env, ctx);

      case '/tools':
        return new Response(JSON.stringify({
          tools: [
            { name: 'browser_navigate', description: 'Navigate to a URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
            { name: 'browser_snapshot', description: 'Get page accessibility snapshot', inputSchema: { type: 'object', properties: {} } },
            { name: 'browser_click', description: 'Click an element', inputSchema: { type: 'object', properties: { element: { type: 'string' } } } },
            { name: 'browser_type', description: 'Type into an element', inputSchema: { type: 'object', properties: { element: { type: 'string' }, text: { type: 'string' } } } },
            { name: 'browser_take_screenshot', description: 'Take a screenshot', inputSchema: { type: 'object', properties: {} } },
            { name: 'browser_go_back', description: 'Navigate back', inputSchema: { type: 'object', properties: {} } },
            { name: 'browser_go_forward', description: 'Navigate forward', inputSchema: { type: 'object', properties: {} } },
            { name: 'browser_scroll', description: 'Scroll the page', inputSchema: { type: 'object', properties: { scrollTop: { type: 'number' } } } },
            { name: 'browser_evaluate', description: 'Run JavaScript', inputSchema: { type: 'object', properties: { script: { type: 'string' } } } },
          ]
        }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });

      case '/health':
        return new Response(JSON.stringify({ 
          status: 'ok', 
          hasBrowser: !!env.BROWSER,
          version: '7-simple'
        }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });

      default:
        return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
    }
  },

  async handleMcpRequest(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      // Handle GET for MCP discovery
      if (request.method === 'GET') {
        return new Response(JSON.stringify({ 
          name: 'playwright-mcp',
          version: '1.0.0',
          capabilities: {}
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }

      // Handle POST for MCP JSON-RPC
      const body = await request.text();
      let jsonBody: any;
      try {
        jsonBody = JSON.parse(body);
      } catch (e) {
        jsonBody = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
      }

      const id = jsonBody.id || 1;
      const method = jsonBody.method || '';

      console.log(`[MCP] Method: ${method}`);

      // Handle methods
      switch (method) {
        case 'tools/list':
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              tools: [
                { name: 'browser_navigate', description: 'Navigate to a URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
                { name: 'browser_snapshot', description: 'Get page accessibility snapshot', inputSchema: { type: 'object', properties: {} } },
                { name: 'browser_click', description: 'Click an element', inputSchema: { type: 'object', properties: { element: { type: 'string' } } } },
                { name: 'browser_type', description: 'Type into an element', inputSchema: { type: 'object', properties: { element: { type: 'string' }, text: { type: 'string' } } } },
                { name: 'browser_take_screenshot', description: 'Take a screenshot', inputSchema: { type: 'object', properties: {} } },
                { name: 'browser_go_back', description: 'Navigate back', inputSchema: { type: 'object', properties: {} } },
                { name: 'browser_go_forward', description: 'Navigate forward', inputSchema: { type: 'object', properties: {} } },
                { name: 'browser_scroll', description: 'Scroll the page', inputSchema: { type: 'object', properties: { scrollTop: { type: 'number' } } } },
                { name: 'browser_evaluate', description: 'Run JavaScript', inputSchema: { type: 'object', properties: { script: { type: 'string' } } } },
              ]
            }
          }), {
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });

        case 'tools/call':
          const toolName = jsonBody.params?.name || '';
          const toolArgs = jsonBody.params?.arguments || {};

          console.log(`[MCP] Calling tool: ${toolName} with args:`, toolArgs);

          // Check if browser is available
          if (!env.BROWSER) {
            return new Response(JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32601,
                message: 'Browser not configured. Please add BROWSER binding in Cloudflare Dashboard.'
              }
            }), {
              headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            });
          }

          // Return a placeholder response for now
          // The actual browser automation would require more complex implementation
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Tool ${toolName} executed with arguments: ${JSON.stringify(toolArgs)}. Note: Full browser automation requires SSE connection.`
                }
              ]
            }
          }), {
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });

        default:
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`
            }
          }), {
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
      }

    } catch (error) {
      const errorMsg = String(error);
      console.error('[MCP] Error:', errorMsg);
      return new Response(JSON.stringify({ 
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32603,
          message: errorMsg
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
  }
};
