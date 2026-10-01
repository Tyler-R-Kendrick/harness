/** Protocol revision this package speaks. */
export const PROTOCOL_VERSION = "2026-07-28";

/** JSON-RPC code for a protocol version the peer does not support. */
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** JSON-RPC code for a method the peer does not offer. */
export const METHOD_NOT_FOUND = -32601;

export const EXTENSIONS = {
  ui: "io.modelcontextprotocol/ui",
  tasks: "io.modelcontextprotocol/tasks",
  skills: "io.modelcontextprotocol/skills",
  events: "io.modelcontextprotocol/events",
  clientCredentials: "io.modelcontextprotocol/oauth-client-credentials",
} as const;

/** Media type required by the stable MCP Apps spec of 2026-01-26. */
export const APP_MIME_TYPE = "text/html;profile=mcp-app";

export const UI_PROTOCOL_VERSION = "2026-01-26";

export const META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  serverInfo: "io.modelcontextprotocol/serverInfo",
  logLevel: "io.modelcontextprotocol/logLevel",
  subscriptionId: "io.modelcontextprotocol/subscriptionId",
} as const;
