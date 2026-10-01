import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { DpopSession, InsufficientScopeError } from "@modelcontextprotocol/client";
import { EXTENSIONS } from "./constants.ts";
import { connectHttp, type HarnessClient } from "./client.ts";
import { textOf } from "./results.ts";

export class IssuerMismatch extends Error {
  readonly expected: string;
  readonly received: string;
  constructor(expected: string, received: string) {
    super(`authorization response iss ${received} does not match ${expected}`);
    this.name = "IssuerMismatch";
    this.expected = expected;
    this.received = received;
  }
}

/** Credentials keyed by the authorization server that issued them. */
export class IssuerCredentialStore {
  private readonly tokens = new Map<string, { accessToken: string; scope: string }>();
  private currentIssuer: string | undefined;

  get current(): string | undefined {
    return this.currentIssuer;
  }

  useIssuer(issuer: string): void {
    this.currentIssuer = issuer;
  }

  save(issuer: string, accessToken: string, scope: string): void {
    this.tokens.set(issuer, { accessToken, scope });
    this.currentIssuer = issuer;
  }

  /** A token is returned only for the issuer that issued it. */
  tokenFor(issuer: string): string | undefined {
    return this.tokens.get(issuer)?.accessToken;
  }

  /** Header for `audience`, or undefined when the stored credential belongs to a different issuer. */
  authorizationFor(audience: string): string | undefined {
    const token = this.tokens.get(audience)?.accessToken;
    return token ? `Bearer ${token}` : undefined;
  }
}

export interface ClientMetadataDocument {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope?: string;
}

export interface MetadataServer {
  url: string;
  document: ClientMetadataDocument;
  close: () => Promise<void>;
}

/** Serve a Client ID Metadata Document. Loopback HTTP is accepted; every other client id is HTTPS. */
export function listenForMetadata(document: Omit<ClientMetadataDocument, "client_id"> & { client_id?: string }): Promise<MetadataServer> {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/client.json")) {
      const url = `http://127.0.0.1:${port()}/client.json`;
      const body = JSON.stringify({ ...document, client_id: url });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = (): number => {
    const address = server.address();
    return address && typeof address === "object" ? address.port : 0;
  };
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${port()}/client.json`;
      resolve({
        url,
        document: { ...document, client_id: url },
        close: () => new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      });
    });
  });
}

interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
}

export async function discoverAuthorizationServer(resourceMetadataUrl: string, fetchFn: typeof fetch = fetch): Promise<{
  resource: ProtectedResourceMetadata;
  authorization: AuthorizationServerMetadata;
}> {
  const resourceResponse = await fetchFn(resourceMetadataUrl);
  if (!resourceResponse.ok) throw new Error(`resource metadata ${resourceResponse.status}`);
  const resource = (await resourceResponse.json()) as ProtectedResourceMetadata;
  const issuer = resource.authorization_servers[0];
  if (!issuer) throw new Error("resource metadata has no authorization server");
  // RFC 8414: the well-known segment goes before any path of the issuer.
  const issuerUrl = new URL(issuer);
  const metadataUrl = new URL(`/.well-known/oauth-authorization-server${issuerUrl.pathname.replace(/\/$/, "")}`, issuerUrl.origin);
  const metadataResponse = await fetchFn(metadataUrl);
  if (!metadataResponse.ok) throw new Error(`authorization server metadata ${metadataResponse.status}`);
  const authorization = (await metadataResponse.json()) as AuthorizationServerMetadata;
  if (authorization.issuer !== issuer) throw new IssuerMismatch(issuer, authorization.issuer);
  return { resource, authorization };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export interface RedeemResult {
  redeemed: boolean;
  accessToken?: string;
  issuer: string;
}

/**
 * Discover the authorization server, identify the client with a metadata document,
 * and redeem an authorization code only when `iss` matches the recorded issuer.
 */
export async function redeemAuthorizationCode(options: {
  resourceMetadataUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  /** Fetch the authorize URL. The scripted server returns the redirect query. */
  openAuthorization: (authorizationUrl: URL) => Promise<{ code?: string; iss?: string; state?: string }>;
  store: IssuerCredentialStore;
  fetchFn?: typeof fetch;
}): Promise<RedeemResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const discovered = await discoverAuthorizationServer(options.resourceMetadataUrl, fetchFn);
  const issuer = discovered.authorization.issuer;
  options.store.useIssuer(issuer);
  const { verifier, challenge } = pkce();
  const authorizationUrl = new URL(discovered.authorization.authorization_endpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", options.clientId);
  authorizationUrl.searchParams.set("redirect_uri", options.redirectUri);
  authorizationUrl.searchParams.set("scope", options.scope);
  const state = randomUUID();
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("resource", discovered.resource.resource);
  const redirected = await options.openAuthorization(authorizationUrl);
  if (redirected.state !== undefined && redirected.state !== state) throw new Error("authorization response state mismatch");
  if (redirected.iss !== undefined && redirected.iss !== issuer) {
    throw new IssuerMismatch(issuer, redirected.iss);
  }
  if (!redirected.code) throw new Error("authorization response had no code");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: redirected.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    code_verifier: verifier,
    resource: discovered.resource.resource,
  });
  const tokenResponse = await fetchFn(discovered.authorization.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenResponse.ok) throw new Error(`token endpoint ${tokenResponse.status}`);
  const token = (await tokenResponse.json()) as { access_token?: string; iss?: string; scope?: string };
  if (token.iss !== undefined && token.iss !== issuer) throw new IssuerMismatch(issuer, token.iss);
  if (!token.access_token) throw new Error("token response had no access_token");
  options.store.save(issuer, token.access_token, token.scope ?? options.scope);
  return { redeemed: true, accessToken: token.access_token, issuer };
}

/** Official client-credentials grant. The token is stored under the authorization server's issuer. */
export async function clientCredentialsGrant(options: {
  tokenEndpoint: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  resource?: string;
  store: IssuerCredentialStore;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const body = new URLSearchParams({ grant_type: "client_credentials", scope: options.scope });
  if (options.resource) body.set("resource", options.resource);
  const tokenResponse = await fetchFn(options.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64")}`,
    },
    body,
  });
  if (!tokenResponse.ok) throw new Error(`client credentials ${tokenResponse.status}`);
  const token = (await tokenResponse.json()) as { access_token?: string; iss?: string };
  if (token.iss !== undefined && token.iss !== options.issuer) throw new IssuerMismatch(options.issuer, token.iss);
  if (!token.access_token) throw new Error("client credentials response had no access_token");
  options.store.save(options.issuer, token.access_token, options.scope);
  return token.access_token;
}

/**
 * Enterprise-managed identity assertion: exchange an ID token for an ID-JAG at the
 * enterprise IdP, then exchange that assertion for an access token at the MCP authorization server.
 */
export async function identityAssertionGrant(options: {
  idpTokenEndpoint: string;
  tokenEndpoint: string;
  issuer: string;
  idToken: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  resource?: string;
  store: IssuerCredentialStore;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const exchange = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: options.idToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    requested_token_type: "urn:ietf:params:oauth:token-type:id-jag",
    audience: options.issuer,
    scope: options.scope,
  });
  const jagResponse = await fetchFn(options.idpTokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: exchange,
  });
  if (!jagResponse.ok) throw new Error(`identity assertion exchange ${jagResponse.status}`);
  const jag = (await jagResponse.json()) as { access_token?: string };
  if (!jag.access_token) throw new Error("identity provider returned no assertion");
  const redeemed = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jag.access_token,
    scope: options.scope,
    client_id: options.clientId,
  });
  if (options.resource) redeemed.set("resource", options.resource);
  const tokenResponse = await fetchFn(options.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64")}`,
    },
    body: redeemed,
  });
  if (!tokenResponse.ok) throw new Error(`jwt bearer ${tokenResponse.status}`);
  const token = (await tokenResponse.json()) as { access_token?: string; iss?: string };
  if (token.iss !== undefined && token.iss !== options.issuer) throw new IssuerMismatch(options.issuer, token.iss);
  if (!token.access_token) throw new Error("authorization server returned no access token");
  options.store.save(options.issuer, token.access_token, options.scope);
  return token.access_token;
}

export async function dpopProof(token: string, url: string, method = "POST"): Promise<string> {
  const session = await DpopSession.create();
  return session.buildProof({ htm: method, htu: url, accessToken: token });
}

export async function callWithToken(options: {
  url: string;
  token?: string;
  proof?: string;
  tool?: string;
  args?: Record<string, unknown>;
  fetch?: typeof fetch;
}): Promise<{ client: HarnessClient; text: string }> {
  const headers: Record<string, string> = {};
  if (options.token) headers["authorization"] = options.proof ? `DPoP ${options.token}` : `Bearer ${options.token}`;
  if (options.proof) headers["dpop"] = options.proof;
  const client = await connectHttp(options.url, {
    headers,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  try {
    const result = await client.callTool(options.tool ?? "echo", options.args ?? { text: "ok" });
    return { client, text: textOf(result) };
  } catch (error) {
    // A failed call still owns the transport: close it so a step-up retry leaks nothing.
    await client.close();
    throw error;
  }
}

/** Answer an insufficient_scope challenge by authorizing the challenged scope and retrying the call. */
export async function callWithStepUp(options: {
  url: string;
  token: string;
  tool?: string;
  args?: Record<string, unknown>;
  elevate: (scope: string) => Promise<string>;
  fetch?: typeof fetch;
}): Promise<string> {
  const transport = options.fetch ? { fetch: options.fetch } : {};
  try {
    const first = await callWithToken({ url: options.url, token: options.token, ...callShape(options), ...transport });
    await first.client.close();
    return first.text;
  } catch (error) {
    if (!(error instanceof InsufficientScopeError) && !isScopeChallenge(error)) throw error;
    const scope = scopeOf(error);
    const elevated = await options.elevate(scope);
    const second = await callWithToken({ url: options.url, token: elevated, ...callShape(options), ...transport });
    await second.client.close();
    return second.text;
  }
}

function callShape(options: { tool?: string; args?: Record<string, unknown> }): { tool?: string; args?: Record<string, unknown> } {
  return {
    ...(options.tool !== undefined ? { tool: options.tool } : {}),
    ...(options.args !== undefined ? { args: options.args } : {}),
  };
}

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const data = "data" in error ? error.data : undefined;
  return `${error.message} ${data && typeof data === "object" ? JSON.stringify(data) : ""}`;
}

function isScopeChallenge(error: unknown): boolean {
  if (error instanceof InsufficientScopeError) return true;
  return /insufficient_scope|\b403\b/.test(errorDetail(error));
}

function scopeOf(error: unknown): string {
  if (error instanceof InsufficientScopeError && error.requiredScope) return error.requiredScope;
  if (error instanceof Error) {
    const match = /scope="([^"]+)"/.exec(errorDetail(error));
    if (match?.[1]) return match[1];
  }
  return "write";
}

export const CLIENT_CREDENTIALS_EXTENSION = EXTENSIONS.clientCredentials;
