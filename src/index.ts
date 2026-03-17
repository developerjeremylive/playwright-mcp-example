import { env } from 'cloudflare:workers';

// CORS headers for cross-origin requests
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
};

// Browser controller class to manage browser instances
class BrowserController {
  private browser: any = null;
  private page: any = null;
  private env: Env;
  
  constructor(env: Env) {
    this.env = env;
  }
  
  async init() {
    if (!this.browser) {
      console.log('[Browser] Initializing browser...');
      this.browser = await env.BROWSER.launch();
    }
    return this.browser;
  }
  
  async getPage() {
    if (!this.page) {
      const browser = await this.init();
      const context = await browser.createBrowserContext();
      this.page = await context.newPage();
    }
    return this.page;
  }
  
  async navigate(url: string) {
    const page = await this.getPage();
    await page.goto(url);
    return `Navigated to ${url}`;
  }
  
  async snapshot() {
    const page = await this.getPage();
    return await page.accessibility.snapshot();
  }
  
  async screenshot() {
    const page = await this.getPage();
    return await page.screenshot();
  }
  
  async click(selector: string) {
    const page = await this.getPage();
    await page.click(selector);
    return `Clicked ${selector}`;
  }
  
  async type(selector: string, text: string) {
    const page = await this.getPage();
    await page.fill(selector, text);
    return `Typed "${text}" into ${selector}`;
  }
  
  async fill(selector: string, text: string) {
    const page = await this.getPage();
    await page.fill(selector, text);
    return `Filled ${selector} with "${text}"`;
  }
  
  async hover(selector: string) {
    const page = await this.getPage();
    await page.hover(selector);
    return `Hovered over ${selector}`;
  }
  
  async scroll(scrollTop: number) {
    const page = await this.getPage();
    await page.evaluate((top) => window.scrollTo(0, top), scrollTop);
    return `Scrolled to ${scrollTop}`;
  }
  
  async evaluate(script: string) {
    const page = await this.getPage();
    const result = await page.evaluate(script);
    return String(result);
  }
  
  async goBack() {
    const page = await this.getPage();
    await page.goBack();
    return 'Navigated back';
  }
  
  async goForward() {
    const page = await this.getPage();
    await page.goForward();
    return 'Navigated forward';
  }
  
  async resize(width: number, height: number) {
    const page = await this.getPage();
    await page.setViewportSize({ width, height });
    return `Resized to ${width}x${height}`;
  }
  
  async selectOption(selector: string, value: string) {
    const page = await this.getPage();
    await page.selectOption(selector, value);
    return `Selected ${value} in ${selector}`;
  }
  
  async drag(startSelector: string, endSelector: string) {
    const page = await this.getPage();
    await page.dragAndDrop(startSelector, endSelector);
    return `Dragged from ${startSelector} to ${endSelector}`;
  }
}

// Store active browser controllers by session
const sessions = new Map<string, BrowserController>();

function getOrCreateController(env: Env): BrowserController {
  // For simplicity, use a single global controller
  // In production, you'd want session-based controllers
  return new BrowserController(env);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname, searchParams } = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    console.log(`[MCP] ${request.method} ${pathname}`);

    // Check browser availability
    const hasBrowser = !!env.BROWSER;
    console.log('[MCP] Browser available:', hasBrowser);

    switch (pathname) {
      case '/sse':
        // SSE endpoint - returns session info
        const sessionId = crypto.randomUUID();
        sessions.set(sessionId, new BrowserController(env));
        
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

      case '/sse/message':
        // SSE message handler - process tool calls via SSE
        const msgSessionId = searchParams.get('sessionId');
        const controller = msgSessionId ? sessions.get(msgSessionId) : getOrCreateController(env);
        
        if (request.method === 'POST') {
          const body = await request.text();
          let jsonBody: any;
          try {
            jsonBody = JSON.parse(body);
          } catch (e) {
            jsonBody = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
          }

          const id = jsonBody.id || 1;
          const method = jsonBody.method || '';
          const toolName = jsonBody.params?.name || '';
          const toolArgs = jsonBody.params?.arguments || {};

          console.log(`[MCP SSE] Method: ${method}, Tool: ${toolName}`);

          let result: any;
          
          try {
            if (!hasBrowser) {
              throw new Error('Browser not configured. Please add BROWSER binding in Cloudflare Dashboard.');
            }

            switch (toolName) {
              case 'browser_navigate':
                result = await controller.navigate(toolArgs.url);
                break;
              case 'browser_snapshot':
                result = await controller.snapshot();
                break;
              case 'browser_take_screenshot':
                result = await controller.screenshot();
                break;
              case 'browser_click':
                result = await controller.click(toolArgs.element);
                break;
              case 'browser_type':
                result = await controller.type(toolArgs.element, toolArgs.text);
                break;
              case 'browser_fill':
                result = await controller.fill(toolArgs.element, toolArgs.text);
                break;
              case 'browser_hover':
                result = await controller.hover(toolArgs.element);
                break;
              case 'browser_scroll':
                result = await controller.scroll(toolArgs.scrollTop || 0);
                break;
              case 'browser_evaluate':
                result = await controller.evaluate(toolArgs.script);
                break;
              case 'browser_go_back':
                result = await controller.goBack();
                break;
              case 'browser_go_forward':
                result = await controller.goForward();
                break;
              case 'browser_resize':
                result = await controller.resize(toolArgs.width || 800, toolArgs.height || 600);
                break;
              case 'browser_select_option':
                result = await controller.selectOption(toolArgs.element, toolArgs.option);
                break;
              case 'browser_drag':
                result = await controller.drag(toolArgs.startElement, toolArgs.endElement);
                break;
              default:
                throw new Error(`Unknown tool: ${toolName}`);
            }

            // Send result via SSE
            const sseData = JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: String(result) }]
              }
            });
            
            return new Response(
              `event: message\ndata: ${sseData}\n\n`,
              {
                headers: {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  ...CORS_HEADERS,
                },
              }
            );
          } catch (toolError: any) {
            const errorData = JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: { code: -32603, message: toolError.message }
            });
            
            return new Response(
              `event: message\ndata: ${errorData}\n\n`,
              {
                headers: {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  ...CORS_HEADERS,
                },
              }
            );
          }
        }
        
        return new Response('Expected POST', { status: 405, headers: CORS_HEADERS });

      case '/install':
        return new Response(JSON.stringify({
          name: 'playwright-mcp',
          description: 'Playwright browser automation via Cloudflare',
          version: '1.0.0',
          tools: [
            { name: 'browser_navigate', description: 'Navigate to a URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
            { name: 'browser_snapshot', description: 'Get page accessibility snapshot', inputSchema: { type: 'object', properties: {} } },
            { name: 'browser_click', description: 'Click an element', inputSchema: { type: 'object', properties: { element: { type: 'string' } } } },
            { name: 'browser_type', description: 'Type into an element', inputSchema: { type: 'object', properties: { element: { type: 'string' }, text: { type: 'string' } } } },
            { name: 'browser_take_screenshot', description: 'Take a screenshot', inputSchema: { type: 'object', properties: {} } },
            { name: 'browser_go_back', description: 'Navigate back', inputSchema: { type: 'object', properties: {} } },
            { name: 'browser_go_forward', description: 'Navigate forward', inputSchema: { type: 'object', properties: {} } },
            { name: 'browser_scroll', description: 'Scroll the page', inputSchema: { type: 'object', properties: { scrollTop: { type: 'number' } } } },
            { name: 'browser_hover', description: 'Hover over element', inputSchema: { type: 'object', properties: { element: { type: 'string' } } } },
            { name: 'browser_fill', description: 'Fill input field', inputSchema: { type: 'object', properties: { element: { type: 'string' }, text: { type: 'string' } } } },
            { name: 'browser_drag', description: 'Drag between elements', inputSchema: { type: 'object', properties: { startElement: { type: 'string' }, endElement: { type: 'string' } } } },
            { name: 'browser_select_option', description: 'Select dropdown option', inputSchema: { type: 'object', properties: { element: { type: 'string' }, option: { type: 'string' } } } },
            { name: 'browser_evaluate', description: 'Run JavaScript', inputSchema: { type: 'object', properties: { script: { type: 'string' } } } },
            { name: 'browser_resize', description: 'Resize browser', inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } } } },
          ]
        }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });

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
            { name: 'browser_hover', description: 'Hover over element', inputSchema: { type: 'object', properties: { element: { type: 'string' } } } },
            { name: 'browser_fill', description: 'Fill input field', inputSchema: { type: 'object', properties: { element: { type: 'string' }, text: { type: 'string' } } } },
            { name: 'browser_drag', description: 'Drag between elements', inputSchema: { type: 'object', properties: { startElement: { type: 'string' }, endElement: { type: 'string' } } } },
            { name: 'browser_select_option', description: 'Select dropdown option', inputSchema: { type: 'object', properties: { element: { type: 'string' }, option: { type: 'string' } } } },
            { name: 'browser_evaluate', description: 'Run JavaScript', inputSchema: { type: 'object', properties: { script: { type: 'string' } } } },
            { name: 'browser_resize', description: 'Resize browser', inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } } } },
          ]
        }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });

      case '/health':
        return new Response(JSON.stringify({ 
          status: 'ok', 
          hasBrowser: !!env.BROWSER,
          version: '8-sse'
        }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });

      default:
        return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
    }
  },

  async handleMcpRequest(request: Request, env: Env, ctx: ExecutionContext) {
    const controller = getOrCreateController(env);
    
    try {
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
                { name: 'browser_hover', description: 'Hover over element', inputSchema: { type: 'object', properties: { element: { type: 'string' } } } },
                { name: 'browser_fill', description: 'Fill input field', inputSchema: { type: 'object', properties: { element: { type: 'string' }, text: { type: 'string' } } } },
                { name: 'browser_drag', description: 'Drag between elements', inputSchema: { type: 'object', properties: { startElement: { type: 'string' }, endElement: { type: 'string' } } } },
                { name: 'browser_select_option', description: 'Select dropdown option', inputSchema: { type: 'object', properties: { element: { type: 'string' }, option: { type: 'string' } } } },
                { name: 'browser_evaluate', description: 'Run JavaScript', inputSchema: { type: 'object', properties: { script: { type: 'string' } } } },
                { name: 'browser_resize', description: 'Resize browser', inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } } } },
              ]
            }
          }), {
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });

        case 'tools/call':
          const toolName = jsonBody.params?.name || '';
          const toolArgs = jsonBody.params?.arguments || {};

          console.log(`[MCP] Calling tool: ${toolName}`);

          if (!env.BROWSER) {
            return new Response(JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: { code: -32601, message: 'Browser not configured' }
            }), {
              headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            });
          }

          let result: any;
          
          try {
            switch (toolName) {
              case 'browser_navigate':
                result = await controller.navigate(toolArgs.url);
                break;
              case 'browser_snapshot':
                result = await controller.snapshot();
                break;
              case 'browser_take_screenshot':
                result = await controller.screenshot();
                break;
              case 'browser_click':
                result = await controller.click(toolArgs.element);
                break;
              case 'browser_type':
                result = await controller.type(toolArgs.element, toolArgs.text);
                break;
              case 'browser_fill':
                result = await controller.fill(toolArgs.element, toolArgs.text);
                break;
              case 'browser_hover':
                result = await controller.hover(toolArgs.element);
                break;
              case 'browser_scroll':
                result = await controller.scroll(toolArgs.scrollTop || 0);
                break;
              case 'browser_evaluate':
                result = await controller.evaluate(toolArgs.script);
                break;
              case 'browser_go_back':
                result = await controller.goBack();
                break;
              case 'browser_go_forward':
                result = await controller.goForward();
                break;
              case 'browser_resize':
                result = await controller.resize(toolArgs.width || 800, toolArgs.height || 600);
                break;
              case 'browser_select_option':
                result = await controller.selectOption(toolArgs.element, toolArgs.option);
                break;
              case 'browser_drag':
                result = await controller.drag(toolArgs.startElement, toolArgs.endElement);
                break;
              default:
                throw new Error(`Unknown tool: ${toolName}`);
            }

            return new Response(JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: String(result) }]
              }
            }), {
              headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            });
          } catch (toolError: any) {
            return new Response(JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: { code: -32603, message: toolError.message }
            }), {
              headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            });
          }

        default:
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` }
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
        error: { code: -32603, message: errorMsg }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
  }
};
