import { describe, expect, it } from "vitest";
import { hashedEvaluationModel } from "@harness/testkit";
import { systemOneModels } from "@harness/decision";
import { serveSystemOne, systemOneUrl } from "../src/systemone-server.ts";

const models = systemOneModels([{ id: "hashed-1", model: hashedEvaluationModel() }]);

describe("serveSystemOne options", () => {
  it("S1H1.1 the port must be a whole number from 0 to 65535", async () => {
    for (const port of [-1, 65536, 1.5, Number.NaN]) await expect(serveSystemOne({ models, port })).rejects.toThrow(/port must be a whole number from 0 to 65535/);
  });

  it("S1H1.2 the body limit must be a positive whole number", async () => {
    for (const maxBodyBytes of [0, -5, 2.5, Number.NaN]) await expect(serveSystemOne({ models, port: 0, maxBodyBytes })).rejects.toThrow(/maxBodyBytes must be a positive whole number/);
  });

  it("S1H1.3 an empty token is refused, not treated as no token", async () => {
    await expect(serveSystemOne({ models, port: 0, token: "" })).rejects.toThrow(/token must not be empty/);
  });

  it("S1H1.4 a host that is not loopback needs a token", async () => {
    for (const host of ["0.0.0.0", "192.168.1.5", "example.test", "::"]) await expect(serveSystemOne({ models, port: 0, host })).rejects.toThrow(/without a token: only loopback/);
  });

  it("S1H1.5 an IPv6 address is bracketed in the url", () => {
    expect(systemOneUrl("::1", 8080)).toBe("http://[::1]:8080");
    expect(systemOneUrl("127.0.0.1", 80)).toBe("http://127.0.0.1:80");
    expect(systemOneUrl("localhost", 5)).toBe("http://localhost:5");
  });
});
