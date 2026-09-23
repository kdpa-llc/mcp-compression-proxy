import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { PayloadStore } from '../cli/payload-interceptor.js';
import type { CatalogTool } from '../mcp/tool-catalog.js';
import type { ModelBackend } from '../models/types.js';
import type { ToolSearch } from '../search/tool-search.js';
import type { UsageLog } from '../search/usage-log.js';
import { CallSuggester } from '../services/call-suggester.js';
import { auditCompression } from '../services/compression-audit.js';
import { readShapeSpec, shapeAndStore } from '../services/shaped-call.js';

const PREFIX = 'mcp-compression-proxy__';

export const META_TOOLS = {
  searchTools: `${PREFIX}search_tools`,
  getTool: `${PREFIX}get_tool`,
  callTool: `${PREFIX}call_tool`,
  suggestTool: `${PREFIX}suggest_tool`,
  shapeOutput: `${PREFIX}shape_output`,
  auditCompression: `${PREFIX}audit_compression`,
} as const;

const SHAPE_PROPERTIES = {
  want: {
    description:
      'Optional shape of the answer, e.g. {"items":[{"id":"integer","title":"string","user.login":"string?"}]}. Keys are kept, types checked, nothing invented.',
  },
  where: {
    type: 'string',
    description: 'Optional: keep only list items relevant to this description.',
  },
  limit: { type: 'number', minimum: 1, description: 'Items kept by where (default 20).' },
};

const DEFINITIONS: Record<string, Tool> = {
  [META_TOOLS.searchTools]: {
    name: META_TOOLS.searchTools,
    description:
      'Search every backend tool by what it does. Returns server, tool and a short description, best first. Then get_tool for the schema, and call_tool to run it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to do, or part of a tool name.' },
        limit: { type: 'number', minimum: 1, description: 'Results (default 15).' },
      },
      required: ['query'],
    },
  },
  [META_TOOLS.getTool]: {
    name: META_TOOLS.getTool,
    description: "Get one backend tool's full description, input schema and annotations.",
    inputSchema: {
      type: 'object',
      properties: { server: { type: 'string' }, tool: { type: 'string' } },
      required: ['server', 'tool'],
    },
  },
  [META_TOOLS.callTool]: {
    name: META_TOOLS.callTool,
    description:
      'Call a backend tool. Pass want and/or where to get back only the fields or items you need; the full output is kept as a payload you can read or search.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        tool: { type: 'string' },
        arguments: { type: 'object' },
        ...SHAPE_PROPERTIES,
      },
      required: ['server', 'tool'],
    },
  },
  [META_TOOLS.suggestTool]: {
    name: META_TOOLS.suggestTool,
    description:
      'Describe what you want in plain words; get candidate tools with schemas and, when the local model is configured, a proposed call to check. run:true runs it only for read-only tools the model is confident about.',
    inputSchema: {
      type: 'object',
      properties: {
        request: { type: 'string' },
        run: { type: 'boolean', default: false },
      },
      required: ['request'],
    },
  },
  [META_TOOLS.shapeOutput]: {
    name: META_TOOLS.shapeOutput,
    description: 'Shape a saved large output (payload ID) with want and/or where, without reading all of it.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Payload ID' }, ...SHAPE_PROPERTIES },
      required: ['id'],
    },
  },
  [META_TOOLS.auditCompression]: {
    name: META_TOOLS.auditCompression,
    description:
      'Check compressed descriptions: list any that now read more like another tool than their own, and tools that look duplicated across servers. requeue:true sends the confusable ones back for compression.',
    inputSchema: {
      type: 'object',
      properties: { requeue: { type: 'boolean', default: false } },
    },
  },
};

/** Meta tools each exposure lists, beyond the management tools it keeps. */
const EXPOSURE: Record<'full' | 'lazy', string[]> = {
  full: [META_TOOLS.callTool, META_TOOLS.shapeOutput, META_TOOLS.auditCompression],
  lazy: [
    META_TOOLS.searchTools,
    META_TOOLS.getTool,
    META_TOOLS.callTool,
    META_TOOLS.suggestTool,
    META_TOOLS.shapeOutput,
  ],
};

/** Management tools still listed in lazy mode; the compression workflow is not. */
export const LAZY_KEPT_MANAGEMENT_TOOLS = [
  `${PREFIX}read_output`,
  `${PREFIX}find_output`,
  `${PREFIX}run_script`,
  `${PREFIX}stats`,
];

export interface MetaToolDeps {
  catalog: { list(): Promise<CatalogTool[]>; find(server: string, tool: string): Promise<CatalogTool | undefined> };
  search: ToolSearch;
  usage?: UsageLog;
  compression: {
    getCompressedDescription(serverName: string, toolName: string): string | undefined;
    applySchemaDescriptions?<T>(serverName: string, toolName: string, schema: T, liveOriginal?: string): T;
    invalidate(serverName: string, toolName: string): boolean;
    saveToDisk(): Promise<void>;
  };
  payloadStore: PayloadStore;
  threshold(): number;
  model(): ModelBackend | undefined;
  /** A backend call as the client would see it, payload capture applied. */
  callBackend(server: string, tool: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** A backend call's joined text, for shaping. */
  executeText(server: string, tool: string, args: Record<string, unknown>): Promise<{ output: string; isError?: boolean }>;
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorText(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * The native proxy's discovery, shaping and audit tools.
 *
 * In lazy exposure these replace the full tool list: a client sees a handful
 * of small tools and loads a backend schema only when it asks for one, the way
 * mcp-cli works. In full exposure, call_tool and shape_output add the wrapper
 * call to a client that already sees every tool.
 */
export class MetaTools {
  constructor(private readonly deps: MetaToolDeps) {}

  definitions(mode: 'full' | 'lazy'): Tool[] {
    return EXPOSURE[mode].map((name) => DEFINITIONS[name]);
  }

  handles(name: string): boolean {
    return name in DEFINITIONS;
  }

  async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      switch (name) {
        case META_TOOLS.searchTools:
          return await this.searchTools(args);
        case META_TOOLS.getTool:
          return await this.getTool(args);
        case META_TOOLS.callTool:
          return await this.callTool(args);
        case META_TOOLS.suggestTool:
          return await this.suggestTool(args);
        case META_TOOLS.shapeOutput:
          return await this.shapeSaved(args);
        case META_TOOLS.auditCompression:
          return await this.audit(args);
        default:
          return errorText(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return errorText(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async searchTools(args: Record<string, unknown>): Promise<CallToolResult> {
    const query = String(args.query ?? '').trim();
    if (!query) return errorText('Error: query is required');
    const limit = Number(args.limit);
    const result = await this.deps.search.search(
      query,
      Number.isInteger(limit) && limit > 0 ? limit : undefined
    );
    return json({
      tools: result.hits.map(({ server, tool, description }) => ({ server, tool, description })),
      shown: result.hits.length,
      total: result.total,
    });
  }

  private async getTool(args: Record<string, unknown>): Promise<CallToolResult> {
    const server = String(args.server ?? '');
    const tool = String(args.tool ?? '');
    const found = await this.deps.catalog.find(server, tool);
    if (!found) return errorText(`Error: Tool '${tool}' not found on server '${server}'`);
    this.deps.usage?.recordSelection(server, tool);
    return json({
      server,
      tool,
      description: found.description ?? '',
      inputSchema:
        this.deps.compression.applySchemaDescriptions?.(server, tool, found.inputSchema, found.description) ??
        found.inputSchema,
      ...(found.title !== undefined ? { title: found.title } : {}),
      ...(found.annotations !== undefined ? { annotations: found.annotations } : {}),
    });
  }

  private async callTool(args: Record<string, unknown>): Promise<CallToolResult> {
    const server = String(args.server ?? '');
    const tool = String(args.tool ?? '');
    if (!server || !tool) return errorText('Error: server and tool are required');
    const toolArgs = (args.arguments ?? {}) as Record<string, unknown>;
    this.deps.usage?.recordSelection(server, tool);

    const spec = readShapeSpec(args);
    if (!spec) {
      return this.deps.callBackend(server, tool, toolArgs);
    }

    const { output, isError } = await this.deps.executeText(server, tool, toolArgs);
    if (isError) return errorText(output);
    return json(
      await shapeAndStore(output, spec, this.deps.payloadStore, this.deps.threshold(), this.deps.model())
    );
  }

  private async suggestTool(args: Record<string, unknown>): Promise<CallToolResult> {
    const request = String(args.request ?? '').trim();
    if (!request) return errorText('Error: request is required');
    const suggestion = await new CallSuggester(
      this.deps.search,
      this.deps.catalog,
      this.deps.model()
    ).suggest(request);

    if (args.run !== true || !suggestion.runnable || !suggestion.proposal) {
      return json({ suggestion });
    }

    const { server, tool, arguments: toolArgs } = suggestion.proposal;
    this.deps.usage?.recordSelection(server, tool);
    const ran = await this.deps.callBackend(server, tool, toolArgs);
    return {
      ...ran,
      content: [
        { type: 'text', text: JSON.stringify({ suggestion }, null, 2) },
        ...ran.content,
      ],
    };
  }

  private async shapeSaved(args: Record<string, unknown>): Promise<CallToolResult> {
    const spec = readShapeSpec(args);
    if (!spec) return errorText('Error: pass want and/or where');
    const content = this.deps.payloadStore.read(String(args.id ?? ''), { all: true }).content;
    return json(
      await shapeAndStore(content, spec, this.deps.payloadStore, this.deps.threshold(), this.deps.model())
    );
  }

  private async audit(args: Record<string, unknown>): Promise<CallToolResult> {
    const audit = await auditCompression(
      await this.deps.catalog.list(),
      this.deps.compression,
      this.deps.model()
    );
    let requeued = 0;
    if (args.requeue === true) {
      for (const finding of audit.confusable) {
        const slash = finding.tool.indexOf('/');
        if (this.deps.compression.invalidate(finding.tool.slice(0, slash), finding.tool.slice(slash + 1))) {
          requeued++;
        }
      }
      if (requeued > 0) await this.deps.compression.saveToDisk();
    }
    return json({ ...audit, requeued });
  }
}
