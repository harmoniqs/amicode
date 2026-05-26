// Entry point for smoke_callback.mjs — boots CallbackServer in isolation
// with the vscode shim aliased in via esbuild --alias.

import { CallbackServer } from "../src/callback_server.ts";
import * as vscode from "vscode";

const channel = vscode.window.createOutputChannel("smoke");
const srv = new CallbackServer({ channel });
const url = await srv.start();
const port = parseInt(new URL(url).port, 10);
process.stdout.write(`PORT=${port}\n`);

// Keep alive until killed.
setInterval(() => {}, 60_000);
