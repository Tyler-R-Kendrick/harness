import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, connectStdio, textOf } from "@harness/mcp";

const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const client = await connectStdio({ command: process.execPath, args: [bin, "stdio"] });
try {
  const discovered = await client.discover();
  const versions = discovered["supportedVersions"];
  const version = Array.isArray(versions) && versions.includes(PROTOCOL_VERSION) ? PROTOCOL_VERSION : "";
  const text = textOf(await client.callTool("echo", { text: "launch" }));
  if (version !== PROTOCOL_VERSION || text !== "launch") {
    console.error(JSON.stringify({ version, text }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ protocolVersion: version, text }));
  }
} finally {
  await client.close();
}
