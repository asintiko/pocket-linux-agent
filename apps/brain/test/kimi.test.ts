import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startPocketMcp } from '../src/kimi-mcp.js';
import { isKimiModel, KIMI_FALLBACK_MODELS, KIMI_PREFIX, kimiCliModel, kimiModelsFromConfig, withKimi } from '../src/kimi-models.js';

describe('Kimi model pool', () => {
  it('keeps Claude values intact and routes only the kimi namespace', () => {
    expect(isKimiModel('opus')).toBe(false);
    expect(isKimiModel(`${KIMI_PREFIX}kimi-code/kimi-for-coding`)).toBe(true);
    expect(kimiCliModel(`${KIMI_PREFIX}kimi-code/kimi-for-coding`)).toBe('kimi-code/kimi-for-coding');
    const models = withKimi([{ value: 'opus', displayName: 'Opus', description: 'Claude' }]);
    expect(models.map((m) => m.value)).toEqual([
      'opus',
      `${KIMI_PREFIX}kimi-code/kimi-for-coding`,
      `${KIMI_PREFIX}kimi-code/kimi-for-coding-highspeed`,
      `${KIMI_PREFIX}kimi-code/k3`,
      `${KIMI_PREFIX}kimi-code/k3-256k`,
      `${KIMI_PREFIX}kimi-code/k3.1-pro`,
      `${KIMI_PREFIX}kimi-code/k3.1-pro-highspeed`,
    ]);
    expect(withKimi(models)).toHaveLength(7);
  });

  it('reads model choices advertised by ACP', () => {
    const option = {
      id: 'model', category: 'model', type: 'select', currentValue: 'kimi-code/kimi-for-coding',
      options: [
        { value: 'kimi-code/kimi-for-coding', name: 'Kimi for Coding', description: 'Coding model' },
        { group: 'other', name: 'Other', options: [{ value: 'kimi-code/k3', name: 'Kimi K3' }] },
      ],
    } as unknown as SessionConfigOption;
    const models = kimiModelsFromConfig([option]);
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ value: `${KIMI_PREFIX}kimi-code/kimi-for-coding`, displayName: 'Kimi for Coding' });
    expect(models[1]).toMatchObject({ value: `${KIMI_PREFIX}kimi-code/k3`, displayName: 'Kimi K3' });
  });

  it('serves Pocket tools over real localhost MCP', async () => {
    const definition = tool('pc_test', 'Pocket MCP test', { value: z.string() }, async ({ value }) => ({ content: [{ type: 'text', text: `ok ${value}` }] }));
    const handle = await startPocketMcp([definition]);
    const client = new Client({ name: 'kimi-test', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
      const tools = await client.listTools();
      expect(tools.tools.map((item) => item.name)).toContain('pc_test');
      const result = await client.callTool({ name: 'pc_test', arguments: { value: 'works' } });
      expect(result.content).toEqual([{ type: 'text', text: 'ok works' }]);
    } finally {
      await client.close().catch(() => undefined);
      await handle.close();
    }
  }, 15_000);
});
