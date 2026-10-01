import { request as httpRequest } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { InsufficientScopeError } from "@modelcontextprotocol/client";
import {
  AppHost,
  AppView,
  IssuerCredentialStore,
  IssuerMismatch,
  callWithStepUp,
  clientCredentialsGrant,
  connectHttp,
  connectStdio,
  discoverAuthorizationServer,
  identityAssertionGrant,
  listenForMetadata,
  negotiatedCapabilities,
  probeProtocolVersion,
  readRpc,
  redeemAuthorizationCode,
  rewriteTaskMethod,
  serveArgs,
  serveHttp,
  signWebhook,
  taskIdOf,
  textOf,
  verifyWebhook,
  webhookKey,
  withResultType,
} from "@harness/mcp";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("MCP edge paths", () => {
  it("MCP6.1 result helpers and webhook keys cover empty and raw inputs", () => {
    expect(textOf(undefined)).toBe("");
    expect(textOf({ content: "nope" })).toBe("");
    expect(textOf({ content: [null] })).toBe("");
    expect(textOf({ content: [{ text: 1 }] })).toBe("");
    expect(textOf({ content: [{ text: "ok" }] })).toBe("ok");
    expect(textOf({ content: [] })).toBe("");
    expect(withResultType({}).resultType).toBe("complete");
    expect(withResultType({ resultType: 1 }).resultType).toBe("complete");
    expect(withResultType({ resultType: "input_required" }).resultType).toBe("input_required");
    expect(taskIdOf(undefined)).toBeUndefined();
    expect(taskIdOf({ taskId: 1 })).toBeUndefined();
    expect(taskIdOf({ taskId: "direct" })).toBe("direct");
    expect(taskIdOf({ structuredContent: { taskId: 2 } })).toBeUndefined();
    expect(taskIdOf({ structuredContent: { taskId: "nested" } })).toBe("nested");
    expect(taskIdOf({ structuredContent: null })).toBeUndefined();
    expect(taskIdOf({ nope: true })).toBeUndefined();
    expect(webhookKey("raw-secret").toString("utf8")).toBe("raw-secret");
    const signature = signWebhook("raw-secret", "id", "1", "body");
    expect(verifyWebhook("raw-secret", { id: "id", timestamp: "1", signature: `${signature} v1,other` }, "body")).toBe(true);
    expect(rewriteTaskMethod("not-json")).toBe("not-json");
    expect(rewriteTaskMethod("{")).toBe("{");
    expect(rewriteTaskMethod(JSON.stringify({ method: "tasks/get", id: 1 }))).toContain("harness/tasks/get");
    expect(rewriteTaskMethod(JSON.stringify({ method: "tools/list" }))).toContain("tools/list");
  });

  it("MCP6.2 authorization failures stay on the failing step", async () => {
    const store = new IssuerCredentialStore();
    const fetchFn = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/missing")) return jsonResponse(404, {});
      if (url.endsWith("/empty")) return jsonResponse(200, { resource: "x", authorization_servers: [] });
      if (url.endsWith("/bad-as")) return jsonResponse(200, { resource: "x", authorization_servers: ["http://down.example"] });
      if (url.endsWith("/mismatch")) return jsonResponse(200, { resource: "x", authorization_servers: ["http://wrong.example"] });
      if (url.endsWith("/ready")) return jsonResponse(200, { resource: "http://mcp", authorization_servers: ["http://ok.example"] });
      if (url.endsWith("/ready-iss")) return jsonResponse(200, { resource: "http://mcp", authorization_servers: ["http://iss-bad.example"] });
      if (url.endsWith("/ready-empty")) return jsonResponse(200, { resource: "http://mcp", authorization_servers: ["http://iss-empty.example"] });
      if (url.includes("down.example") && url.includes("oauth-authorization-server")) return jsonResponse(503, {});
      if (url.includes("wrong.example") && url.includes("oauth-authorization-server")) {
        return jsonResponse(200, {
          issuer: "http://other.example",
          authorization_endpoint: "http://other.example/a",
          token_endpoint: "http://other.example/t",
        });
      }
      if (url.includes("iss-bad.example") && url.includes("oauth-authorization-server")) {
        return jsonResponse(200, {
          issuer: "http://iss-bad.example",
          authorization_endpoint: "http://iss-bad.example/a",
          token_endpoint: "http://iss-bad.example/token-iss",
        });
      }
      if (url.includes("iss-empty.example") && url.includes("oauth-authorization-server")) {
        return jsonResponse(200, {
          issuer: "http://iss-empty.example",
          authorization_endpoint: "http://iss-empty.example/a",
          token_endpoint: "http://iss-empty.example/token-empty",
        });
      }
      if (url.includes("ok.example") && url.includes("oauth-authorization-server")) {
        return jsonResponse(200, {
          issuer: "http://ok.example",
          authorization_endpoint: "http://ok.example/a",
          token_endpoint: "http://ok.example/token-down",
        });
      }
      if (url.endsWith("/token-down")) return jsonResponse(401, {});
      if (url.endsWith("/token-iss")) return jsonResponse(200, { access_token: "t", iss: "http://other.example" });
      if (url.endsWith("/token-empty")) return jsonResponse(200, {});
      if (url.endsWith("/token-ok")) return jsonResponse(200, { access_token: "jag" });
      return jsonResponse(500, {});
    };
    await expect(discoverAuthorizationServer("http://resource.example/missing", fetchFn)).rejects.toThrow(/resource metadata 404/);
    await expect(discoverAuthorizationServer("http://resource.example/empty", fetchFn)).rejects.toThrow(/no authorization server/);
    await expect(discoverAuthorizationServer("http://resource.example/bad-as", fetchFn)).rejects.toThrow(/authorization server metadata 503/);
    await expect(discoverAuthorizationServer("http://resource.example/mismatch", fetchFn)).rejects.toBeInstanceOf(IssuerMismatch);
    const discovered = {
      resourceMetadataUrl: "http://resource.example/ready",
      clientId: "http://127.0.0.1/client.json",
      redirectUri: "http://127.0.0.1/callback",
      scope: "read",
      store,
      fetchFn,
    };
    await expect(redeemAuthorizationCode({ ...discovered, openAuthorization: async () => ({}) })).rejects.toThrow(/no code/);
    expect(store.current).toBe("http://ok.example");
    await expect(redeemAuthorizationCode({
      ...discovered,
      openAuthorization: async () => ({ code: "c", iss: "http://ok.example" }),
    })).rejects.toThrow(/token endpoint 401/);
    await expect(redeemAuthorizationCode({
      ...discovered,
      resourceMetadataUrl: "http://resource.example/ready-iss",
      openAuthorization: async () => ({ code: "c", iss: "http://iss-bad.example" }),
    })).rejects.toBeInstanceOf(IssuerMismatch);
    await expect(redeemAuthorizationCode({
      ...discovered,
      resourceMetadataUrl: "http://resource.example/ready-empty",
      openAuthorization: async () => ({ code: "c", iss: "http://iss-empty.example" }),
    })).rejects.toThrow(/no access_token/);
    await expect(clientCredentialsGrant({
      tokenEndpoint: "http://issuer.example/token-down",
      issuer: "http://issuer.example",
      clientId: "c",
      clientSecret: "s",
      scope: "read",
      resource: "http://mcp",
      store,
      fetchFn,
    })).rejects.toThrow(/client credentials 401/);
    await expect(clientCredentialsGrant({
      tokenEndpoint: "http://issuer.example/token-iss",
      issuer: "http://issuer.example",
      clientId: "c",
      clientSecret: "s",
      scope: "read",
      store,
      fetchFn,
    })).rejects.toBeInstanceOf(IssuerMismatch);
    await expect(clientCredentialsGrant({
      tokenEndpoint: "http://issuer.example/token-empty",
      issuer: "http://issuer.example",
      clientId: "c",
      clientSecret: "s",
      scope: "read",
      store,
      fetchFn,
    })).rejects.toThrow(/no access_token/);
    await expect(identityAssertionGrant({
      idpTokenEndpoint: "http://issuer.example/token-down",
      tokenEndpoint: "http://issuer.example/token-ok",
      issuer: "http://issuer.example",
      idToken: "id",
      clientId: "c",
      clientSecret: "s",
      scope: "read",
      resource: "http://mcp",
      store,
      fetchFn,
    })).rejects.toThrow(/identity assertion exchange 401/);
    await expect(identityAssertionGrant({
      idpTokenEndpoint: "http://issuer.example/token-empty",
      tokenEndpoint: "http://issuer.example/token-ok",
      issuer: "http://issuer.example",
      idToken: "id",
      clientId: "c",
      clientSecret: "s",
      scope: "read",
      store,
      fetchFn,
    })).rejects.toThrow(/no assertion/);
    await expect(identityAssertionGrant({
      idpTokenEndpoint: "http://issuer.example/token-ok",
      tokenEndpoint: "http://issuer.example/token-down",
      issuer: "http://issuer.example",
      idToken: "id",
      clientId: "c",
      clientSecret: "s",
      scope: "read",
      resource: "http://mcp",
      store,
      fetchFn,
    })).rejects.toThrow(/jwt bearer 401/);
    await expect(identityAssertionGrant({
      idpTokenEndpoint: "http://issuer.example/token-ok",
      tokenEndpoint: "http://issuer.example/token-iss",
      issuer: "http://issuer.example",
      idToken: "id",
      clientId: "c",
      clientSecret: "s",
      scope: "read",
      store,
      fetchFn,
    })).rejects.toBeInstanceOf(IssuerMismatch);
    await expect(identityAssertionGrant({
      idpTokenEndpoint: "http://issuer.example/token-ok",
      tokenEndpoint: "http://issuer.example/token-empty",
      issuer: "http://issuer.example",
      idToken: "id",
      clientId: "c",
      clientSecret: "s",
      scope: "read",
      store,
      fetchFn,
    })).rejects.toThrow(/no access token/);
    await expect(callWithStepUp({
      url: "http://127.0.0.1:1/mcp",
      token: "nope",
      elevate: async () => "nope",
    })).rejects.toThrow();
    expect(new InsufficientScopeError({ requiredScope: "write" }).requiredScope).toBe("write");
    const metadata = await listenForMetadata({
      client_name: "harness",
      redirect_uris: ["http://127.0.0.1/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    try {
      expect((await fetch(new URL("/missing", metadata.url))).status).toBe(404);
    const scopes: string[] = [];
    let steps = 0;
    await expect(callWithStepUp({
      url: "http://127.0.0.1:9/mcp",
      token: "t",
      elevate: async (scope) => {
        scopes.push(scope);
        return "next";
      },
      fetch: async () => {
        steps += 1;
        if (steps === 1) {
          const error = new Error('HTTP 403 insufficient_scope scope="admin"');
          throw Object.assign(error, { data: { scope: "admin" } });
        }
        throw new Error("later");
      },
    })).rejects.toThrow(/later/);
    expect(scopes).toEqual(["admin"]);
    let plain = "";
    let plainSteps = 0;
    await expect(callWithStepUp({
      url: "http://127.0.0.1:9/mcp",
      token: "t",
      elevate: async (scope) => {
        plain = scope;
        return "next";
      },
      fetch: async () => {
        plainSteps += 1;
        if (plainSteps === 1) throw new Error("insufficient_scope");
        throw new Error("later");
      },
    })).rejects.toThrow(/later/);
    expect(plain).toBe("write");
    await expect(callWithStepUp({
      url: "http://127.0.0.1:9/mcp",
      token: "t",
      elevate: async () => "next",
      fetch: async () => {
        throw "403";
      },
    })).rejects.toThrow(/probe failed/);
    } finally {
      await metadata.close();
    }
  });

  it("MCP6.3 rejected frames, unknown skills, and bad webhook subscriptions", async () => {
    const ignored = new MessageChannel();
    const host = new AppHost("<p>x</p>", { callTool: async () => ({ content: [] }) });
    host.attach(ignored.port1);
    ignored.port2.postMessage({ jsonrpc: "1.0", id: 1, method: "ui/initialize" });
    const channel = new MessageChannel();
    const view = new AppView({ name: "demo", version: "0" });
    await expect(view.callTool("echo", {})).rejects.toThrow(/not attached/);
    view.attach(channel.port2);
    channel.port1.onmessage = () => undefined;
    const pending = view.initialize();
    channel.port1.postMessage({ jsonrpc: "2.0", id: 99, result: {} });
    channel.port1.postMessage({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "no" } });
    await expect(pending).rejects.toThrow("no");
    const tools = new MessageChannel();
    const names: string[] = [];
    const toolHost = new AppHost("<p>y</p>", {
      callTool: async (name) => {
        names.push(name);
        return { ok: true };
      },
    });
    toolHost.attach(tools.port1);
    const echoed = new Promise<unknown>((resolve) => {
      tools.port2.onmessage = (event: { data: { id?: number; result?: unknown } }) => {
        if (event.data?.id === 5) resolve(event.data.result);
      };
    });
    tools.port2.postMessage(null);
    tools.port2.postMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: 1, arguments: "nope" } });
    tools.port2.postMessage({ jsonrpc: "2.0", id: 4, method: "nope" });
    tools.port2.postMessage({ jsonrpc: "2.0", id: 5, method: "tools/call" });
    expect(await echoed).toEqual({ ok: true });
    expect(names).toEqual(["", ""]);
    const server = await serveHttp();
    const client = await connectHttp(server.url);
    try {
      await expect(client.request("skills/get", { uri: "skill://missing" })).rejects.toThrow(/not found/);
      await expect(client.request("events/subscribe", { name: "demo.ping", delivery: { mode: "poll" } })).rejects.toThrow(/url/);
      await expect(client.request("tasks/get", { taskId: "missing" })).rejects.toThrow(/Unknown task/);
      await expect(client.request("tasks/update", { taskId: "missing" })).rejects.toThrow(/Unknown task/);
      const created = await client.callTool("work", {});
      const taskId = taskIdOf(created);
      if (taskId === undefined) throw new Error("missing task");
      await expect(client.request("tasks/update", { taskId })).rejects.toThrow(/input responses/);
      await client.callTool("revise", {});
      await client.callTool("revise", {});
      expect(textOf(await client.callTool("extra", {}))).toBe("extra");
      expect(textOf(await client.callTool("progress", {}))).toBe("stepped");
      const skill = await client.readResource("skill://code-review/SKILL.md");
      const skillBody = skill.contents[0];
      expect(skillBody && "text" in skillBody ? skillBody.text : "").toContain("Follow the checklist");
      const prompt = await client.request("prompts/get", { name: "hello" });
      expect(JSON.stringify(prompt)).toContain("Hello");
      const known = await client.request("skills/get", { uri: "skill://code-review/SKILL.md" });
      expect(known["uri"]).toBe("skill://code-review/SKILL.md");
      const listed = await client.listTools();
      expect(listed.tools.some((tool) => tool.name === "extra")).toBe(true);
      await client.request("events/subscribe", {
        name: "demo.ping",
        delivery: { mode: "webhook", url: "http://127.0.0.1:1/hook", secret: "raw-secret" },
      });
      await client.callTool("emit", {});
      expect((await client.request("events/stream", { name: "demo.ping" }))["resultType"]).toBe("complete");
      expect(negotiatedCapabilities({ tasks: false, skills: false, ui: false, events: false }).extensions).toEqual({});
    } finally {
      await client.close().catch(() => undefined);
      await server.close();
    }
  });

  it("MCP6.4 protected resource metadata and an invalid token", async () => {
    const server = await serveHttp({
      protection: {
        authorizationServer: "https://issuer.example",
        verifyToken: () => undefined,
      },
    });
    try {
      expect((await fetch(`http://127.0.0.1:${server.port}/.well-known/oauth-protected-resource/mcp`)).status).toBe(200);
      const response = await fetch(server.url, {
        method: "POST",
        headers: { authorization: "Bearer nope", "content-type": "application/json", accept: "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(401);
      expect((await fetch(server.url)).status).toBeGreaterThanOrEqual(400);
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(server.url, { method: "POST", headers: { "set-cookie": ["a=1", "b=2"], "content-type": "application/json" } }, (res) => {
          res.resume();
          res.on("end", () => resolve());
        });
        req.on("error", reject);
        req.end("{}");
      });
    } finally {
      await server.close();
    }
    const broken = await serveHttp({
      protection: {
        authorizationServer: "https://issuer.example",
        verifyToken: (token) => {
          if (token === "text") throw "nope";
          throw new Error("boom");
        },
      },
    });
    try {
      const response = await fetch(broken.url, {
        method: "POST",
        headers: { authorization: "Bearer nope", "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("boom");
      const text = await fetch(broken.url, {
        method: "POST",
        headers: { authorization: "Bearer text", "content-type": "application/json" },
        body: "{}",
      });
      expect(text.status).toBe(500);
      expect(await text.text()).toBe("error");
    } finally {
      await broken.close();
    }
    const plain = await serveHttp();
    try {
      expect((await fetch(`http://127.0.0.1:${plain.port}/.well-known/oauth-protected-resource`)).status).toBe(404);
    } finally {
      await plain.close();
    }
  });

  it("MCP6.5 sse responses and a stdio command", async () => {
    expect(await readRpc(new Response("data: {\"result\":{\"ok\":true}}\n\n"))).toMatchObject({ result: { ok: true } });
    expect(await readRpc(new Response('{"result":{"ok":1}}'))).toMatchObject({ result: { ok: 1 } });
    expect(await readRpc(new Response("event: message\ndata: {\"result\":{\"ok\":2}}\n"))).toMatchObject({ result: { ok: 2 } });
    await expect(readRpc(new Response("data: [DONE]\n"))).rejects.toThrow();
    await expect(readRpc(new Response("data: {\"jsonrpc\":\"2.0\"}\n"))).rejects.toThrow();
    await expect(serveArgs(["nope"])).rejects.toThrow(/unknown mcp command nope/);
    const input = new PassThrough();
    const output = new PassThrough();
    const running = await serveArgs(["stdio"], { stdin: input, stdout: output });
    input.end("{");
    await running.close();
  });

  it("MCP6.6 a probe that gets no error, and a call that is not a dropped stream", async () => {
    const server = await serveHttp();
    try {
      await expect(probeProtocolVersion({ url: server.url }, "2026-07-28")).rejects.toThrow(/expected an error/);
      await expect(probeProtocolVersion({ command: process.execPath, args: ["-e", "process.exit(3)"] }, "1999-01-01")).rejects.toThrow(/exited 3/);
      await expect(probeProtocolVersion({
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify({result:true})+'\\n'); setInterval(()=>{}, 1000000)"],
      }, "1999-01-01")).rejects.toThrow(/no error code/);
      await expect(probeProtocolVersion({ command: "/no/such/mcp-bin", args: [] }, "1999-01-01")).rejects.toThrow();
      const bodyOf = (init: RequestInit | undefined): string => {
        const body = init?.body;
        return body == null ? "" : String(body);
      };
      const client = await connectHttp(server.url, {
        fetch: async (input, init) => {
          if (bodyOf(init).includes("tools/call")) throw new Error("nope");
          return fetch(input, init);
        },
      });
      try {
        await expect(client.callTool("echo", { text: "x" })).rejects.toThrow(/nope/);
        expect(await callWithStepUp({ url: server.url, token: "t", elevate: async () => "t" })).toBe("ok");
      } finally {
        await client.close();
      }
      const shaped = await connectHttp(server.url, {
        fetch: async (input, init) => {
          const body = init?.body == null ? "" : String(init.body);
          if (body.includes("prompts/list")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 }), { status: 500 });
          if (body.includes("resources/templates/list")) throw new Error("plain");
          if (body.includes("tools/call")) throw "down";
          return fetch(input, init);
        },
      });
      try {
        await expect(shaped.request("prompts/list", {})).rejects.toThrow();
        await expect(shaped.request("resources/templates/list", {})).rejects.toThrow(/plain/);
        await expect(shaped.callTool("echo", { text: "x" })).rejects.toBe("down");
      } finally {
        await shaped.close();
      }
      const failing = await connectHttp(server.url, {
        fetch: async (input, init) => {
          if (bodyOf(init).includes("resources/list")) return new Response("not-json", { status: 500, headers: { "content-type": "text/plain" } });
          return fetch(input, init);
        },
      });
      try {
        await expect(failing.request("resources/list", {})).rejects.toThrow();
      } finally {
        await failing.close();
      }
    } finally {
      await server.close();
    }
    await expect(connectStdio({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      env: { OK: "1", SKIP: undefined as unknown as string },
    })).rejects.toThrow();
  });
});
