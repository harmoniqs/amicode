// The `amico-git-credential` bin entry point (issue #399). Thin (the
// pasqal_cli.ts split): slurp stdin (the git-credential request), hand it to
// credentialMain(), write the protocol answer. The installation token's ONLY
// carriage is protocol stdout; errors are one token-free stderr line.
import { credentialMain } from "./git_credential.js";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c: string) => (input += c));
process.stdin.on("end", () => {
  credentialMain(input).then(
    ({ stdout, code }) => {
      process.stdout.write(stdout);
      process.exitCode = code;
    },
    (e) => {
      console.error(`amico-git-credential: unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
      process.exitCode = 0; // never block auth — git falls through
    },
  );
});
