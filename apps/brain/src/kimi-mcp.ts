import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

export interface PocketMcpHandle {
  url: string;
  close(): Promise<void>;
}

/** Exposes the exact Pocket tool handlers over localhost so Kimi gets the same tools as Claude. */
export async function startPocketMcp(definitions: SdkMcpToolDefinition<any>[]): Promise<PocketMcpHandle> {
  const mcp = new McpServer({ name: 'pocket', version: '0.1.0' });
  for (const definition of definitions) {
    mcp.registerTool(
      definition.name,
      { description: definition.description, inputSchema: definition.inputSchema },
      async (args: any, extra: any) => definition.handler(args, extra),
    );
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcp.connect(transport);
  const server: Server = createServer((req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    void transport.handleRequest(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500).end(String(error));
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await transport.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
    },
  };
}
