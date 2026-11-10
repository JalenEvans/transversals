import { createInterface } from "node:readline";

const mode = process.argv[2];
const input = createInterface({ input: process.stdin });

input.on("line", (line) => {
  const request = JSON.parse(line);

  if (mode === "malformed-details") {
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      status: "error",
      error: {
        code: "AMBIGUOUS_MATCH",
        message: "ambiguous",
        commandIndex: 0,
        details: { candidates: "not-an-array" },
      },
    })}\n`);
    return;
  }

  if (mode === "ok") {
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      status: "ok",
      results: [{ connected: true }],
    })}\n`);
  }
});
