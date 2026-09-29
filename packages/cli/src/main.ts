import { runMain } from "citty";
import { createCli, defaultDeps } from "./commands.ts";

runMain(createCli(defaultDeps()));
