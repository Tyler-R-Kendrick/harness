import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  HarnessClient,
  IssuerCredentialStore,
  IssuerMismatch,
  callWithStepUp,
  callWithToken,
  clientCredentialsGrant,
  discoverAuthorizationServer,
  dpopProof,
  identityAssertionGrant,
  listenForMetadata,
  redeemAuthorizationCode,
  serveHttp,
  type HttpServer,
} from "@harness/mcp";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listen(handler: (req: IncomingMessage, res: ServerResponse, origin: string) => Promise<void> | void): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    void Promise.resolve(handler(req, res, `http://127.0.0.1:${port}`)).catch((error: unknown) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : "error");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      });
    });
  });
}

describe("MCP authorization", () => {
  it("MCP2.1 an iss that differs from the recorded issuer is not redeemed", async () => {
    let posts = 0;
    const issuer = await listen(async (req, res, origin) => {
      if (req.url === "/.well-known/oauth-authorization-server") {
        res.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token` }));
        return;
      }
      if (req.method === "POST" && req.url === "/token") {
        posts += 1;
        res.writeHead(400);
        res.end();
      }
    });
    const resource = await serveHttp({ protection: { authorizationServer: issuer.origin, verifyToken: () => undefined } });
    const metadata = await listenForMetadata({
      client_name: "harness",
      redirect_uris: ["http://127.0.0.1/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    try {
      await expect(redeemAuthorizationCode({
        resourceMetadataUrl: `http://127.0.0.1:${resource.port}/.well-known/oauth-protected-resource`,
        clientId: metadata.url,
        redirectUri: "http://127.0.0.1/callback",
        scope: "read",
        store: new IssuerCredentialStore(),
        openAuthorization: async () => ({ code: "code-1", iss: "https://evil.example" }),
      })).rejects.toBeInstanceOf(IssuerMismatch);
      expect(posts).toBe(0);
    } finally {
      await metadata.close();
      await resource.close();
      await issuer.close();
    }
  });

  it("MCP2.2 a matching iss is redeemed and the protected call succeeds", async () => {
    const issued = new Map<string, string[]>();
    let fetchedName = "";
    const issuer = await listen(async (req, res, origin) => {
      if (req.url === "/.well-known/oauth-authorization-server") {
        res.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token` }));
        return;
      }
      if (req.method === "POST" && req.url === "/token") {
        const params = new URLSearchParams(await readBody(req));
        const document = (await (await fetch(params.get("client_id") ?? "")).json()) as { client_name?: string };
        fetchedName = document.client_name ?? "";
        const token = "access-1";
        issued.set(token, ["read", "write"]);
        res.end(JSON.stringify({ access_token: token, token_type: "Bearer", scope: "read", iss: origin }));
      }
    });
    const resource = await serveHttp({
      protection: {
        authorizationServer: issuer.origin,
        verifyToken: (token) => {
          const scopes = issued.get(token);
          return scopes ? { clientId: "harness", scopes } : undefined;
        },
      },
    });
    const metadata = await listenForMetadata({
      client_name: "harness",
      redirect_uris: ["http://127.0.0.1/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    const store = new IssuerCredentialStore();
    try {
      await expect(callWithToken({ url: resource.url })).rejects.toThrow();
      const redeemed = await redeemAuthorizationCode({
        resourceMetadataUrl: `http://127.0.0.1:${resource.port}/.well-known/oauth-protected-resource`,
        clientId: metadata.url,
        redirectUri: "http://127.0.0.1/callback",
        scope: "read",
        store,
        openAuthorization: async (authorizationUrl) => {
          expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
          expect(authorizationUrl.searchParams.get("client_id")).toBe(metadata.url);
          const state = authorizationUrl.searchParams.get("state");
          expect(state).toBeTruthy();
          return { code: "code-1", iss: issuer.origin, ...(state === null ? {} : { state }) };
        },
      });
      expect(fetchedName).toBe("harness");
      expect(redeemed.redeemed).toBe(true);
      const token = store.tokenFor(issuer.origin);
      if (token === undefined) throw new Error("missing token");
      const call = await callWithToken({ url: resource.url, token });
      expect(call.text).toBe("ok");
      await call.client.close();
    } finally {
      await metadata.close();
      await resource.close();
      await issuer.close();
    }
  });

  it("MCP2.3 a credential stored for issuer A is not presented to issuer B", async () => {
    const store = new IssuerCredentialStore();
    store.save("https://issuer-a.example", "token-a", "read");
    expect(store.authorizationFor("https://issuer-b.example")).toBeUndefined();
    expect(store.authorizationFor("https://issuer-a.example")).toBe("Bearer token-a");
    let presented: string | undefined;
    const resource = await serveHttp({
      protection: {
        authorizationServer: "https://issuer-b.example",
        verifyToken: (token) => {
          presented = token;
          return { clientId: "harness", scopes: ["read"] };
        },
      },
    });
    try {
      expect(store.tokenFor("https://issuer-b.example")).toBeUndefined();
      await expect(callWithToken({ url: resource.url })).rejects.toThrow();
      expect(presented).toBeUndefined();
    } finally {
      await resource.close();
    }
  });

  it("MCP2.4 a DPoP challenge is answered with a DPoP proof", async () => {
    const resource = await serveHttp({
      protection: {
        authorizationServer: "https://issuer.example",
        demandDpop: true,
        verifyToken: (token) => (token === "bound" ? { clientId: "harness", scopes: ["read"] } : undefined),
      },
    });
    try {
      await expect(callWithToken({ url: resource.url, token: "bound" })).rejects.toThrow();
      const proof = await dpopProof("bound", resource.url);
      expect(proof.split(".").length).toBe(3);
      const call = await callWithToken({ url: resource.url, token: "bound", proof });
      expect(call.text).toBe("ok");
      await call.client.close();
    } finally {
      await resource.close();
    }
  });

  it("MCP2.5 a scope challenge is answered by a step-up", async () => {
    const scopes = new Map<string, string[]>([["narrow", ["read"]], ["wide", ["read", "write"]]]);
    const resource = await serveHttp({
      protection: {
        authorizationServer: "https://issuer.example",
        verifyToken: (token) => {
          const held = scopes.get(token);
          return held ? { clientId: "harness", scopes: held } : undefined;
        },
      },
    });
    try {
      let elevated = "";
      const text = await callWithStepUp({
        url: resource.url,
        token: "narrow",
        tool: "stamp",
        elevate: async (scope) => {
          elevated = scope;
          return "wide";
        },
      });
      expect(elevated).toBe("write");
      expect(text).toBe("stamped");
    } finally {
      await resource.close();
    }
  });

  it("MCP2.6 a client-credentials grant authorizes the call", async () => {
    const issued = new Map<string, string[]>();
    let grant = "";
    const issuer = await listen(async (req, res, origin) => {
      if (req.method === "POST" && req.url === "/token") {
        const params = new URLSearchParams(await readBody(req));
        grant = params.get("grant_type") ?? "";
        issued.set("cc-token", ["read"]);
        res.end(JSON.stringify({ access_token: "cc-token", token_type: "Bearer", iss: origin }));
      }
    });
    const resource = await protectedResource(issuer.origin, issued);
    const store = new IssuerCredentialStore();
    try {
      const token = await clientCredentialsGrant({
        tokenEndpoint: `${issuer.origin}/token`,
        issuer: issuer.origin,
        clientId: "client",
        clientSecret: "secret",
        scope: "read",
        store,
      });
      expect(grant).toBe("client_credentials");
      expect(token).toBe(store.tokenFor(issuer.origin));
      const call = await callWithToken({ url: resource.url, token });
      expect(call.text).toBe("ok");
      await call.client.close();
    } finally {
      await resource.close();
      await issuer.close();
    }
  });

  it("MCP2.8 a redirect whose state differs from the one sent is not redeemed", async () => {
    let posts = 0;
    const issuer = await listen(async (req, res, origin) => {
      if (req.url === "/.well-known/oauth-authorization-server") {
        res.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token` }));
        return;
      }
      if (req.method === "POST" && req.url === "/token") {
        posts += 1;
        res.writeHead(400);
        res.end();
      }
    });
    const resource = await serveHttp({ protection: { authorizationServer: issuer.origin, verifyToken: () => undefined } });
    const metadata = await listenForMetadata({
      client_name: "harness",
      redirect_uris: ["http://127.0.0.1/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    try {
      await expect(redeemAuthorizationCode({
        resourceMetadataUrl: `http://127.0.0.1:${resource.port}/.well-known/oauth-protected-resource`,
        clientId: metadata.url,
        redirectUri: "http://127.0.0.1/callback",
        scope: "read",
        store: new IssuerCredentialStore(),
        openAuthorization: async () => ({ code: "code-1", state: "forged" }),
      })).rejects.toThrow("authorization response state mismatch");
      expect(posts).toBe(0);
    } finally {
      await metadata.close();
      await resource.close();
      await issuer.close();
    }
  });

  it("MCP2.9 the authorization server metadata URL keeps the issuer's path (RFC 8414)", async () => {
    const fetched: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      fetched.push(url);
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return new Response(JSON.stringify({ resource: "https://resource.example", authorization_servers: ["https://issuer.example/tenant"] }));
      }
      return new Response(JSON.stringify({ issuer: "https://issuer.example/tenant", authorization_endpoint: "https://issuer.example/tenant/authorize", token_endpoint: "https://issuer.example/tenant/token" }));
    }) as typeof fetch;
    const discovered = await discoverAuthorizationServer("https://resource.example/.well-known/oauth-protected-resource", fetchFn);
    expect(fetched[1]).toBe("https://issuer.example/.well-known/oauth-authorization-server/tenant");
    expect(discovered.authorization.issuer).toBe("https://issuer.example/tenant");
  });

  it("MCP2.10 a failed first call of a step-up closes its client before the retry", async () => {
    const scopes = new Map<string, string[]>([["narrow", ["read"]], ["wide", ["read", "write"]]]);
    const resource = await serveHttp({
      protection: {
        authorizationServer: "https://issuer.example",
        verifyToken: (token) => {
          const held = scopes.get(token);
          return held ? { clientId: "harness", scopes: held } : undefined;
        },
      },
    });
    let closed = 0;
    const original = HarnessClient.prototype.close;
    HarnessClient.prototype.close = async function (this: HarnessClient) {
      closed += 1;
      return original.call(this);
    };
    try {
      const text = await callWithStepUp({
        url: resource.url,
        token: "narrow",
        tool: "stamp",
        elevate: async () => "wide",
      });
      expect(text).toBe("stamped");
      expect(closed).toBe(2);
    } finally {
      HarnessClient.prototype.close = original;
      await resource.close();
    }
  });

  it("MCP2.7 an enterprise identity assertion authorizes the call", async () => {
    const issued = new Map<string, string[]>();
    const grants: string[] = [];
    const issuer = await listen(async (req, res, origin) => {
      const params = new URLSearchParams(await readBody(req));
      grants.push(params.get("grant_type") ?? "");
      if (req.url === "/idp") {
        expect(params.get("requested_token_type")).toBe("urn:ietf:params:oauth:token-type:id-jag");
        res.end(JSON.stringify({ access_token: "jag-1" }));
        return;
      }
      expect(params.get("assertion")).toBe("jag-1");
      issued.set("jag-token", ["read"]);
      res.end(JSON.stringify({ access_token: "jag-token", token_type: "Bearer", iss: origin }));
    });
    const resource = await protectedResource(issuer.origin, issued);
    const store = new IssuerCredentialStore();
    try {
      const token = await identityAssertionGrant({
        idpTokenEndpoint: `${issuer.origin}/idp`,
        tokenEndpoint: `${issuer.origin}/token`,
        issuer: issuer.origin,
        idToken: "id-token",
        clientId: "client",
        clientSecret: "secret",
        scope: "read",
        store,
      });
      expect(grants).toEqual([
        "urn:ietf:params:oauth:grant-type:token-exchange",
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      ]);
      const call = await callWithToken({ url: resource.url, token });
      expect(call.text).toBe("ok");
      await call.client.close();
    } finally {
      await resource.close();
      await issuer.close();
    }
  });
});

function protectedResource(issuer: string, issued: Map<string, string[]>): Promise<HttpServer> {
  return serveHttp({
    protection: {
      authorizationServer: issuer,
      verifyToken: (token) => {
        const scopes = issued.get(token);
        return scopes ? { clientId: "harness", scopes } : undefined;
      },
    },
  });
}
