const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const modelId = process.argv[2];
const requiredContextWindow = Number(process.argv[3]);
const candidates = Array.isArray(payload.data)
  ? payload.data
  : Array.isArray(payload.models)
    ? payload.models
    : [];
const model = candidates.find((candidate) => candidate?.id === modelId);
if (model !== undefined && (!Number.isSafeInteger(model.max_input_tokens) ||
    model.max_input_tokens < requiredContextWindow)) {
  throw new Error(`gateway model ${modelId} does not provide ${requiredContextWindow} input tokens`);
}
