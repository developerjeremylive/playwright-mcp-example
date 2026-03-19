import { env } from 'cloudflare:workers';
import puppeteer from '@cloudflare/puppeteer';

// CORS headers for cross-origin requests
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
};

// Rate limiting configuration
const RATE_LIMIT_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

// Rate limit error detection
function isRateLimitError(error: any): boolean {
  const message = String(error?.message || error || '');
  return message.includes('429') || 
         message.includes('rate limit') || 
         message.includes('Rate limit');
}

// Exponential backoff delay
async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry wrapper with exponential backoff
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = RATE_LIMIT_CONFIG.maxRetries,
  operationName: string = 'operation'
): Promise<T> {
  let lastError: any;
  let currentDelay = RATE_LIMIT_CONFIG.initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      
      if (isRateLimitError(error) && attempt < maxRetries) {
        console.log(`[RateLimit] ${operationName}: Attempt ${attempt + 1} failed, retrying in ${currentDelay}ms...`);
        await delay(currentDelay);
        currentDelay = Math.min(
          currentDelay * RATE_LIMIT_CONFIG.backoffMultiplier,
          RATE_LIMIT_CONFIG.maxDelayMs
        );
      } else {
        throw error;
      }
    }
  }
  
  throw lastError;
}

// Browser controller class to manage browser instances
class BrowserController {
  private browser: any = null;
  private page: any = null;
  private env: Env;
  private mode: 'snapshot' | 'vision' = 'snapshot';
  
  constructor(env: Env, mode: 'snapshot' | 'vision' = 'snapshot') {
    this.env = env;
    this.mode = mode;
  }
  
  async init() {
    if (!this.browser) {
      console.log('[Browser] Launching browser with binding:', typeof this.env.BROWSER);
      try {
        this.browser = await puppeteer.launch(this.env.BROWSER);
        console.log('[Browser] Browser launched successfully');
      } catch (err) {
        console.error('[Browser] Failed to launch:', err);
        throw err;
      }
    }
    return this.browser;
  }
  
  async getPage() {
    if (!this.page) {
      const browser = await this.init();
      this.page = await browser.newPage();
      // Set default viewport
      await this.page.setViewportSize({ width: 1280, height: 720 });
    }
    return this.page;
  }

  // Navigation tools
  async navigate(url: string) {
    const page = await this.getPage();
    await withRetry(
      () => page.goto(url, { waitUntil: 'domcontentloaded' }),
      3,
      `navigate to ${url}`
    );
    return `Navigated to ${url}`;
  }

  async navigateBack() {
    const page = await this.getPage();
    await page.goBack();
    return 'Navigated back';
  }

  async navigateForward() {
    const page = await this.getPage();
    await page.goForward();
    return 'Navigated forward';
  }

  // Snapshot mode tools
  async snapshot() {
    const page = await this.getPage();
    return await withRetry(
      () => page.accessibility.snapshot(),
      3,
      'snapshot'
    );
  }

  // Screenshot tools
  async takeScreenshot(options: { raw?: boolean; filename?: string; element?: string; ref?: string } = {}) {
    const page = await this.getPage();
    
    let screenshotOptions: any = {
      type: options.raw ? 'png' : 'jpeg',
      ...(options.filename && { path: options.filename }),
    };
    
    // If element is specified, we need to locate it first
    if (options.element && options.ref) {
      const snapshot = await page.accessibility.snapshot();
      // Find element by ref in snapshot tree
      const element = this.findElementByRef(snapshot, options.ref);
      if (element) {
        // For element screenshots, we use bounding box
        // Note: full implementation would need DOM handling
        screenshotOptions.fullPage = false;
      }
    }
    
    const screenshot = await withRetry(
      () => page.screenshot(screenshotOptions),
      3,
      'takeScreenshot'
    );
    
    // Return base64 for JSON response
    const base64 = Buffer.from(screenshot).toString('base64');
    const mimeType = options.raw ? 'image/png' : 'image/jpeg';
    return `data:${mimeType};base64,${base64}`;
  }

  private findElementByRef(snapshot: any, ref: string): any {
    if (!snapshot) return null;
    if (snapshot.ref === ref) return snapshot;
    
    if (snapshot.children) {
      for (const child of snapshot.children) {
        const found = this.findElementByRef(child, ref);
        if (found) return found;
      }
    }
    return null;
  }

  // Interaction tools using accessibility snapshot for element selection
  async click(element: string, ref?: string) {
    const page = await this.getPage();
    return await withRetry(async () => {
      if (ref) {
        // Use Playwright's selector based on accessibility
        await page.click(`[data-ref="${ref}"], [aria-label*="${element}"]`, { timeout: 5000 }).catch(() => {
          // Fallback: try clicking by text content
          return page.click(`text=${element}`, { timeout: 5000 });
        });
      } else {
        await page.click(`text=${element}`, { timeout: 5000 });
      }
      return `Clicked ${element}`;
    }, 3, `click ${element}`);
  }

  async type(element: string, text: string, submit?: boolean, slowly?: boolean, ref?: string) {
    const page = await this.getPage();
    return await withRetry(async () => {
      if (ref) {
        await page.fill(`[data-ref="${ref}"], [aria-label*="${element}"]`, text).catch(() => {
          return page.fill(`text=${element}`, text);
        });
      } else {
        await page.fill(`text=${element}`, text);
      }
      
      if (submit) {
        await page.press(`text=${element}`, 'Enter');
      }
      
      if (slowly) {
        // Type character by character
        const inputSelector = ref ? `[data-ref="${ref}"]` : `text=${element}`;
        await page.focus(inputSelector);
        for (const char of text) {
          await page.keyboard.type(char, { delay: 50 });
        }
      }
      
      return `Typed "${text}" into ${element}`;
    }, 3, `type into ${element}`);
  }

  async fill(element: string, text: string, ref?: string) {
    const page = await this.getPage();
    return await withRetry(async () => {
      if (ref) {
        await page.fill(`[data-ref="${ref}"], [aria-label*="${element}"]`, text).catch(() => {
          return page.fill(`text=${element}`, text);
        });
      } else {
        await page.fill(`text=${element}`, text);
      }
      return `Filled ${element} with "${text}"`;
    }, 3, `fill ${element}`);
  }

  async hover(element: string, ref?: string) {
    const page = await this.getPage();
    return await withRetry(async () => {
      if (ref) {
        await page.hover(`[data-ref="${ref}"], [aria-label*="${element}"]`).catch(() => {
          return page.hover(`text=${element}`);
        });
      } else {
        await page.hover(`text=${element}`);
      }
      return `Hovered over ${element}`;
    }, 3, `hover ${element}`);
  }

  async scroll(scrollTop: number = 0, scrollLeft: number = 0) {
    const page = await this.getPage();
    await page.evaluate((top, left) => {
      window.scrollTo(left, top);
    }, scrollTop, scrollLeft);
    return `Scrolled to ${scrollTop},${scrollLeft}`;
  }

  async scrollDown(amount: number = 500) {
    const page = await this.getPage();
    await page.evaluate((amt) => {
      window.scrollBy(0, amt);
    }, amount);
    return `Scrolled down ${amount}px`;
  }

  async scrollUp(amount: number = 500) {
    const page = await this.getPage();
    await page.evaluate((amt) => {
      window.scrollBy(0, -amt);
    }, amount);
    return `Scrolled up ${amount}px`;
  }

  async evaluate(script: string) {
    const page = await this.getPage();
    const result = await withRetry(
      () => page.evaluate(script),
      3,
      'evaluate'
    );
    return String(result);
  }

  async selectOption(element: string, values: string[], ref?: string) {
    const page = await this.getPage();
    return await withRetry(async () => {
      const selector = ref ? `[data-ref="${ref}"]` : `text=${element}`;
      await page.selectOption(selector, values);
      return `Selected ${values.join(', ')} in ${element}`;
    }, 3, `selectOption ${element}`);
  }

  async pressKey(key: string) {
    const page = await this.getPage();
    await page.keyboard.press(key);
    return `Pressed key: ${key}`;
  }

  // Drag and drop
  async drag(startElement: string, endElement: string, startRef?: string, endRef?: string) {
    const page = await this.getPage();
    return await withRetry(async () => {
      const startSelector = startRef ? `[data-ref="${startRef}"]` : `text=${startElement}`;
      const endSelector = endRef ? `[data-ref="${endRef}"]` : `text=${endElement}`;
      await page.dragAndDrop(startSelector, endSelector);
      return `Dragged from ${startElement} to ${endElement}`;
    }, 3, `drag ${startElement} to ${endElement}`);
  }

  // Window management
  async resize(width: number, height: number) {
    const page = await this.getPage();
    await page.setViewportSize({ width, height });
    return `Resized to ${width}x${height}`;
  }

  // Tab management
  async tabList() {
    const browser = await this.init();
    const pages = await browser.pages();
    return pages.map((p: any, i: number) => ({
      index: i,
      url: p.url(),
      title: p.title()
    }));
  }

  async tabNew(url?: string) {
    const browser = await this.init();
    const page = await browser.newPage();
    if (url) {
      await page.goto(url);
    }
    return `Opened new tab${url ? ` with ${url}` : ''}`;
  }

  async tabSelect(index: number) {
    const browser = await this.init();
    const pages = await browser.pages();
    if (index >= 0 && index < pages.length) {
      // Note: Playwright doesn't have direct tab switching, we'd need browser context
      return `Selected tab ${index}`;
    }
    throw new Error(`Tab index ${index} out of range`);
  }

  async tabClose(index?: number) {
    const page = await this.getPage();
    if (index !== undefined) {
      const browser = await this.init();
      const pages = await browser.pages();
      if (index >= 0 && index < pages.length) {
        await pages[index].close();
      }
    } else {
      await page.close();
      this.page = null;
    }
    return `Closed tab${index !== undefined ? ` ${index}` : ''}`;
  }

  // Wait utilities
  async waitFor(options: { time?: number; text?: string; textGone?: string } = {}) {
    const page = await this.getPage();
    
    if (options.time) {
      await delay(options.time * 1000);
      return `Waited ${options.time} seconds`;
    }
    
    if (options.text) {
      await page.waitForSelector(`text=${options.text}`, { timeout: 30000 });
      return `Text "${options.text}" appeared`;
    }
    
    if (options.textGone) {
      await page.waitForSelector(`text=${options.textGone}`, { state: 'detached', timeout: 30000 });
      return `Text "${options.textGone}" disappeared`;
    }
    
    return 'Wait completed';
  }

  // Network and console
  async networkRequests() {
    const page = await this.getPage();
    // Note: Would need to enable request interception to capture all requests
    // This is a simplified version
    return [];
  }

  async consoleMessages() {
    const page = await this.getPage();
    // Note: Would need console event listener setup
    return [];
  }

  // File upload
  async fileUpload(paths: string[], element?: string, ref?: string) {
    const page = await this.getPage();
    const selector = ref ? `[data-ref="${ref}"]` : (element ? `text=${element}` : 'input[type="file"]');
    const fileSelector = await page.$(selector);
    if (fileSelector) {
      await fileSelector.setInputFiles(paths);
      return `Uploaded files: ${paths.join(', ')}`;
    }
    throw new Error('File input not found');
  }

  // Dialog handling
  async handleDialog(accept: boolean, promptText?: string) {
    const page = await this.getPage();
    
    page.on('dialog', async (dialog: any) => {
      if (accept) {
        if (dialog.type() === 'prompt' && promptText) {
          await dialog.accept(promptText);
        } else {
          await dialog.accept();
        }
      } else {
        await dialog.dismiss();
      }
    });
    
    return accept ? 'Accepted dialog' : 'Dismissed dialog';
  }

  // PDF
  async savePdf(filename?: string) {
    const page = await this.getPage();
    const pdf = await page.pdf();
    const base64 = Buffer.from(pdf).toString('base64');
    return `data:application/pdf;base64,${base64}`;
  }

  // Browser installation
  async install() {
    // Browser is installed via Cloudflare dashboard or wrangler
    return 'Browser installation is managed by Cloudflare';
  }

  // Close browser
  async close() {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    return 'Browser closed';
  }

  // Vision mode specific tools
  async screenCapture() {
    return this.takeScreenshot();
  }

  async screenMoveMouse(x: number, y: number) {
    const page = await this.getPage();
    await page.mouse.move(x, y);
    return `Moved mouse to ${x},${y}`;
  }

  async screenClick(x: number, y: number, element?: string) {
    const page = await this.getPage();
    await page.mouse.click(x, y);
    return `Clicked at ${x},${y}`;
  }

  async screenDrag(startX: number, startY: number, endX: number, endY: number) {
    const page = await this.getPage();
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY);
    await page.mouse.up();
    return `Dragged from ${startX},${startY} to ${endX},${endY}`;
  }

  async screenType(text: string, submit?: boolean) {
    const page = await this.getPage();
    await page.keyboard.type(text);
    if (submit) {
      await page.keyboard.press('Enter');
    }
    return `Typed "${text}"`;
  }

  // Generate Playwright test
  async generateTest(name: string, description: string, steps: string[]) {
    const testCode = `import { test, expect } from '@playwright/test';

test('${name}', async ({ page }) => {
  ${steps.map((step, i) => `// Step ${i + 1}: ${step}`).join('\n  ')}
});`;
    
    return testCode;
  }
}

// Store active browser controllers by session
const sessions = new Map<string, BrowserController>();

function getOrCreateController(env: Env, mode: 'snapshot' | 'vision' = 'snapshot'): BrowserController {
  return new BrowserController(env, mode);
}

// All available tools definition (matching Cloudflare playwright-mcp)
const TOOLS = [
  // Navigation
  { name: 'browser_navigate', description: 'Navigate to a URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_navigate_back', description: 'Go back to previous page', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_navigate_forward', description: 'Go forward to next page', inputSchema: { type: 'object', properties: {} } },
  
  // Snapshot mode
  { name: 'browser_snapshot', description: 'Capture accessibility snapshot of the current page', inputSchema: { type: 'object', properties: {} } },
  
  // Interaction
  { name: 'browser_click', description: 'Click on a web page element', inputSchema: { type: 'object', properties: { element: { type: 'string' }, ref: { type: 'string' }, doubleClick: { type: 'boolean' } } } },
  { name: 'browser_drag', description: 'Perform drag and drop between two elements', inputSchema: { type: 'object', properties: { startElement: { type: 'string' }, startRef: { type: 'string' }, endElement: { type: 'string' }, endRef: { type: 'string' } } } },
  { name: 'browser_hover', description: 'Hover over element on page', inputSchema: { type: 'object', properties: { element: { type: 'string' }, ref: { type: 'string' } } } },
  { name: 'browser_type', description: 'Type text into editable element', inputSchema: { type: 'object', properties: { element: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' }, slowly: { type: 'boolean' } } } },
  { name: 'browser_select_option', description: 'Select an option in a dropdown', inputSchema: { type: 'object', properties: { element: { type: 'string' }, ref: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } } } },
  { name: 'browser_press_key', description: 'Press a key on the keyboard', inputSchema: { type: 'object', properties: { key: { type: 'string' } } } },
  
  // Wait
  { name: 'browser_wait_for', description: 'Wait for text to appear/disappear or specified time', inputSchema: { type: 'object', properties: { time: { type: 'number' }, text: { type: 'string' }, textGone: { type: 'string' } } } },
  
  // File
  { name: 'browser_file_upload', description: 'Upload files', inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, element: { type: 'string' }, ref: { type: 'string' } } } },
  
  // Dialog
  { name: 'browser_handle_dialog', description: 'Handle a dialog', inputSchema: { type: 'object', properties: { accept: { type: 'boolean' }, promptText: { type: 'string' } } } },
  
  // Resources
  { name: 'browser_take_screenshot', description: 'Take a screenshot of the current page', inputSchema: { type: 'object', properties: { raw: { type: 'boolean' }, filename: { type: 'string' }, element: { type: 'string' }, ref: { type: 'string' } } } },
  { name: 'browser_pdf_save', description: 'Save page as PDF', inputSchema: { type: 'object', properties: { filename: { type: 'string' } } } },
  { name: 'browser_network_requests', description: 'Returns all network requests since loading the page', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_console_messages', description: 'Returns all console messages', inputSchema: { type: 'object', properties: {} } },
  
  // Utilities
  { name: 'browser_install', description: 'Install the browser specified in the config', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_close', description: 'Close the browser', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_resize', description: 'Resize browser window', inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } } } },
  { name: 'browser_scroll', description: 'Scroll the page', inputSchema: { type: 'object', properties: { scrollTop: { type: 'number' }, scrollLeft: { type: 'number' } } } },
  { name: 'browser_evaluate', description: 'Run JavaScript in browser context', inputSchema: { type: 'object', properties: { script: { type: 'string' } } } },
  
  // Tabs
  { name: 'browser_tab_list', description: 'List browser tabs', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_tab_new', description: 'Open a new tab', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
  { name: 'browser_tab_select', description: 'Select a tab by index', inputSchema: { type: 'object', properties: { index: { type: 'number' } } } },
  { name: 'browser_tab_close', description: 'Close a tab', inputSchema: { type: 'object', properties: { index: { type: 'number' } } } },
  
  // Vision mode
  { name: 'browser_screen_capture', description: 'Take a screenshot (vision mode)', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_screen_move_mouse', description: 'Move mouse to position (vision mode)', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, element: { type: 'string' } } } },
  { name: 'browser_screen_click', description: 'Click at position (vision mode)', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, element: { type: 'string' } } } },
  { name: 'browser_screen_drag', description: 'Drag mouse (vision mode)', inputSchema: { type: 'object', properties: { startX: { type: 'number' }, startY: { type: 'number' }, endX: { type: 'number' }, endY: { type: 'number' }, element: { type: 'string' } } } },
  { name: 'browser_screen_type', description: 'Type text (vision mode)', inputSchema: { type: 'object', properties: { text: { type: 'string' }, submit: { type: 'boolean' } } } },
  
  // Testing
  { name: 'browser_generate_playwright_test', description: 'Generate a Playwright test', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } } } },
];

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

    // Get mode from query param (default: snapshot)
    const mode = (searchParams.get('mode') === 'vision' ? 'vision' : 'snapshot') as 'snapshot' | 'vision';

    switch (pathname) {
      case '/sse':
        // SSE endpoint - returns session info
        const sessionId = crypto.randomUUID();
        sessions.set(sessionId, new BrowserController(env, mode));
        
        return new Response(
          `event: endpoint\ndata: /sse/message?sessionId=${sessionId}&mode=${mode}\n\n`,
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
        const msgMode = (searchParams.get('mode') as 'snapshot' | 'vision') || mode;
        const controller = msgSessionId 
          ? (sessions.get(msgSessionId) || new BrowserController(env, msgMode))
          : getOrCreateController(env, msgMode);
        
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

          console.log(`[MCP SSE] Method: ${method}, Tool: ${toolName}, Mode: ${msgMode}`);

          let result: any;
          
          try {
            if (!hasBrowser) {
              throw new Error('Browser not configured. Please add BROWSER binding in Cloudflare Dashboard.');
            }

            result = await executeTool(controller, toolName, toolArgs, msgMode);

            // Send result via SSE
            const sseData = JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }]
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
              error: { 
                code: isRateLimitError(toolError) ? 429 : -32603, 
                message: toolError.message 
              }
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
          description: 'Playwright browser automation via Cloudflare with rate limiting',
          version: '2.0.0',
          tools: TOOLS
        }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });

      case '/mcp':
      case '/mcp/message':
        return this.handleMcpRequest(request, env, ctx, mode);

      case '/tools':
        return new Response(JSON.stringify({
          tools: TOOLS
        }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });

      case '/health':
        return new Response(JSON.stringify({ 
          status: 'ok', 
          hasBrowser: !!env.BROWSER,
          version: '2.0.0',
          mode: mode,
          rateLimitConfig: RATE_LIMIT_CONFIG
        }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });

      default:
        return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
    }
  },

  async handleMcpRequest(request: Request, env: Env, ctx: ExecutionContext, mode: 'snapshot' | 'vision' = 'snapshot') {
    const controller = getOrCreateController(env, mode);
    
    try {
      if (request.method === 'GET') {
        return new Response(JSON.stringify({ 
          name: 'playwright-mcp',
          version: '2.0.0',
          capabilities: {
            snapshot: true,
            vision: true,
            rateLimiting: true
          }
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

      console.log(`[MCP] Method: ${method}, Mode: ${mode}`);

      switch (method) {
        case 'tools/list':
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { tools: TOOLS }
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
              error: { code: -32601, message: 'Browser not configured. Please add BROWSER binding in Cloudflare Dashboard.' }
            }), {
              headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            });
          }

          try {
            const result = await executeTool(controller, toolName, toolArgs, mode);

            return new Response(JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }]
              }
            }), {
              headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            });
          } catch (toolError: any) {
            const errorCode = isRateLimitError(toolError) ? 429 : -32603;
            return new Response(JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: { 
                code: errorCode, 
                message: toolError.message,
                data: isRateLimitError(toolError) ? { retryAfter: RATE_LIMIT_CONFIG.initialDelayMs } : undefined
              }
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

// Execute tool with rate limiting and error handling
async function executeTool(
  controller: BrowserController, 
  toolName: string, 
  toolArgs: any, 
  mode: 'snapshot' | 'vision'
): Promise<any> {
  // Route to vision mode tools if in vision mode
  if (mode === 'vision') {
    switch (toolName) {
      case 'browser_snapshot':
      case 'browser_screen_capture':
        return controller.screenCapture();
      case 'browser_click':
        return controller.screenClick(toolArgs.x || 0, toolArgs.y || 0, toolArgs.element);
      case 'browser_hover':
        return controller.screenMoveMouse(toolArgs.x || 0, toolArgs.y || 0);
      case 'browser_type':
        return controller.screenType(toolArgs.text || '', toolArgs.submit);
      case 'browser_drag':
        return controller.screenDrag(
          toolArgs.startX || 0, 
          toolArgs.startY || 0, 
          toolArgs.endX || 0, 
          toolArgs.endY || 0
        );
      case 'browser_press_key':
        return controller.pressKey(toolArgs.key);
    }
  }

  // Snapshot mode tools (and shared tools)
  switch (toolName) {
    // Navigation
    case 'browser_navigate':
      return controller.navigate(toolArgs.url);
    case 'browser_navigate_back':
      return controller.navigateBack();
    case 'browser_navigate_forward':
      return controller.navigateForward();
    
    // Snapshot
    case 'browser_snapshot':
      return controller.snapshot();
    
    // Interactions
    case 'browser_click':
      return controller.click(toolArgs.element, toolArgs.ref);
    case 'browser_drag':
      return controller.drag(toolArgs.startElement, toolArgs.endElement, toolArgs.startRef, toolArgs.endRef);
    case 'browser_hover':
      return controller.hover(toolArgs.element, toolArgs.ref);
    case 'browser_type':
      return controller.type(toolArgs.element, toolArgs.text, toolArgs.submit, toolArgs.slowly, toolArgs.ref);
    case 'browser_fill':
      return controller.fill(toolArgs.element, toolArgs.text, toolArgs.ref);
    case 'browser_select_option':
      return controller.selectOption(toolArgs.element, toolArgs.values || [], toolArgs.ref);
    case 'browser_press_key':
      return controller.pressKey(toolArgs.key);
    
    // Wait
    case 'browser_wait_for':
      return controller.waitFor({ time: toolArgs.time, text: toolArgs.text, textGone: toolArgs.textGone });
    
    // File
    case 'browser_file_upload':
      return controller.fileUpload(toolArgs.paths || [], toolArgs.element, toolArgs.ref);
    
    // Dialog
    case 'browser_handle_dialog':
      return controller.handleDialog(toolArgs.accept, toolArgs.promptText);
    
    // Resources
    case 'browser_take_screenshot':
      return controller.takeScreenshot({ 
        raw: toolArgs.raw, 
        filename: toolArgs.filename,
        element: toolArgs.element,
        ref: toolArgs.ref
      });
    case 'browser_pdf_save':
      return controller.savePdf(toolArgs.filename);
    case 'browser_network_requests':
      return controller.networkRequests();
    case 'browser_console_messages':
      return controller.consoleMessages();
    
    // Utilities
    case 'browser_install':
      return controller.install();
    case 'browser_close':
      return controller.close();
    case 'browser_resize':
      return controller.resize(toolArgs.width || 1280, toolArgs.height || 720);
    case 'browser_scroll':
      return controller.scroll(toolArgs.scrollTop || 0, toolArgs.scrollLeft || 0);
    case 'browser_evaluate':
      return controller.evaluate(toolArgs.script);
    
    // Tabs
    case 'browser_tab_list':
      return controller.tabList();
    case 'browser_tab_new':
      return controller.tabNew(toolArgs.url);
    case 'browser_tab_select':
      return controller.tabSelect(toolArgs.index);
    case 'browser_tab_close':
      return controller.tabClose(toolArgs.index);
    
    // Vision mode aliases
    case 'browser_screen_capture':
      return controller.screenCapture();
    case 'browser_screen_move_mouse':
      return controller.screenMoveMouse(toolArgs.x || 0, toolArgs.y || 0);
    case 'browser_screen_click':
      return controller.screenClick(toolArgs.x || 0, toolArgs.y || 0, toolArgs.element);
    case 'browser_screen_drag':
      return controller.screenDrag(
        toolArgs.startX || 0, 
        toolArgs.startY || 0, 
        toolArgs.endX || 0, 
        toolArgs.endY || 0
      );
    case 'browser_screen_type':
      return controller.screenType(toolArgs.text || '', toolArgs.submit);
    
    // Testing
    case 'browser_generate_playwright_test':
      return controller.generateTest(toolArgs.name, toolArgs.description, toolArgs.steps || []);
    
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
