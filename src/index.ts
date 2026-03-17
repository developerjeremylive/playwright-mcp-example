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

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Log the request
    console.log(`[MCP] ${request.method} ${pathname}`);

    switch (pathname) {
      case '/sse':
      case '/sse/message':
        return PlaywrightMCP.serveSSE('/sse').fetch(request, env, ctx);
        
      case '/mcp':
        return this.handleMcpRequest(request, env, ctx);
        
      case '/mcp/message':
        // Handle MCP messages with session ID
        const sessionId = searchParams.get('sessionId');
        return this.handleMcpRequest(request, env, ctx, sessionId || undefined);
        
      case '/tools':
        // Return list of available tools
        if (!env.BROWSER) {
          return new Response(JSON.stringify({ 
            error: 'Browser not configured. Please add BROWSER binding in Cloudflare Dashboard.' 
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
        }
        
        return new Response(JSON.stringify({
          tools: [
            { name: 'browser_navigate', description: 'Navigate to a URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
            { name: 'browser_snapshot', description: 'Get page accessibility snapshot', inputSchema: { type: 'object', properties: {} } },
            { name: 'browser_click', description: 'Click an element', inputSchema: { type: 'object', properties: { ref: { type: 'string' }, element: { type: 'string' } } } },
            { name: 'browser_type', description: 'Type into an element', inputSchema: { type: 'object', properties: { element: { type: 'string' }, text: { type: 'string' } } } },
            { name: 'browser_take_screenshot', description: 'Take a screenshot', inputSchema: { type: 'object', properties: {} } },
            { name: 'browser_go_back', description: 'Navigate back', inputSchema: { type: 'object', properties: {} } },
            { name: 'browser_go_forward', description: 'Navigate forward', inputSchema: { type: 'object', properties: {} } },
            { name: 'browser_scroll', description: 'Scroll the page', inputSchema: { type: 'object', properties: { scrollTop: { type: 'number' } } } },
            { name: 'browser_evaluate', description: 'Run JavaScript', inputSchema: { type: 'object', properties: { script: { type: 'string' } } } },
            { name: 'browser_fill', description: 'Fill input field', inputSchema: { type: 'object', properties: { element: { type: 'string' }, text: { type: 'string' } } } },
            { name: 'browser_hover', description: 'Hover over element', inputSchema: { type: 'object', properties: { element: { type: 'string' } } } },
            { name: 'browser_drag', description: 'Drag and drop', inputSchema: { type: 'object', properties: { startElement: { type: 'string' }, endElement: { type: 'string' } } } },
            { name: 'browser_select_option', description: 'Select dropdown option', inputSchema: { type: 'object', properties: { element: { type: 'string' }, option: { type: 'string' } } } },
            { name: 'browser_resize', description: 'Resize browser', inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } } } },
          ]
        }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
        
      case '/health':
        return new Response(JSON.stringify({ 
          status: 'ok', 
          hasBrowser: !!env.BROWSER,
          version: '6'
        }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
        
      case '/call':
        // Simple HTTP endpoint for calling tools directly
        // This is what mcporter expects
        try {
          const body = await request.json();
          const { tool, args } = body;
          
          console.log(`[MCP /call] tool: ${tool}, args:`, args);
          
          if (!env.BROWSER) {
            return new Response(JSON.stringify({ 
              error: 'Browser not configured' 
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            });
          }
          
          // For now, return a simple response indicating the tool was called
          // Real implementation would need to create a browser session
          return new Response(JSON.stringify({ 
            result: `Tool ${tool} called with args: ${JSON.stringify(args)}. Note: HTTP calls not fully implemented - use SSE.`,
            tool,
            args
          }), {
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
        }
        
      default:
        return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
    }
  },
  
  async handleMcpRequest(request: Request, env: Env, ctx: ExecutionContext, sessionId?: string) {
    try {
      // Handle GET for MCP discovery
      if (request.method === 'GET') {
        return new Response(JSON.stringify({ 
          name: 'playwright-mcp',
          version: '1.0.0',
          capabilities: {}
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            ...CORS_HEADERS,
          },
        });
      }
      
      // Handle POST for MCP JSON-RPC
      if (request.method === 'POST') {
        const body = await request.text();
        console.log('[MCP] POST body:', body);
        
        let jsonBody: any;
        try {
          jsonBody = JSON.parse(body);
        } catch (e) {
          jsonBody = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
        }
        
        // For tools/call, we need to handle it directly since SSE won't work via HTTP
        if (jsonBody.method === 'tools/call') {
          let toolName = '';
          let toolArgs = {};
          
          if (jsonBody.params && typeof jsonBody.params === 'object') {
            toolName = jsonBody.params.name || '';
            toolArgs = jsonBody.params.arguments || {};
          }
          
          console.log(`[MCP] Calling tool: ${toolName} with args:`, toolArgs);
          
          // Return a response indicating the call was made
          // The actual execution happens via SSE in a real scenario
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id: jsonBody.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Tool ${toolName} called with: ${JSON.stringify(toolArgs)}. Use SSE for full execution.`
                }
              ]
            }
          }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              ...CORS_HEADERS,
            },
          });
        }
        
        // For other methods, use the SSE handler
        const mcpServer = PlaywrightMCP.serve('/mcp');
        
        const mcpRequest = new Request(request.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
          },
          body: JSON.stringify(jsonBody),
        });
        
        const mcpResponse = await mcpServer.fetch(mcpRequest, env, ctx);
        
        const responseText = await mcpResponse.text();
        
        return new Response(responseText, {
          status: mcpResponse.status || 200,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          },
        });
      }
      
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
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
  }
};
