import { createHash } from 'node:crypto';

const operationPattern = '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$';
export const commandOperationId = new RegExp(operationPattern);
const maxOperations = 65536;
const maxCachedReplies = 128;
const maxReplyBytes = 32768;

function commandError(text) {
  return { isError: true, content: [{ type: 'text', text }] };
}

export function commandSchema(tool) {
  if (tool.name !== 'exec_command') return tool;
  const { inputSchema } = tool;
  return {
    ...tool,
    description: [
      tool.description,
      'Use a fresh operationId for each new command. If the response is lost, repeat only with the same operationId and identical arguments.',
    ].filter(Boolean).join(' '),
    inputSchema: {
      ...inputSchema,
      required: [...(inputSchema.required ?? []), 'operationId'],
      properties: {
        ...inputSchema.properties,
        operationId: {
          type: 'string', pattern: operationPattern,
          description: 'Caller-generated lowercase UUID v4 for this command. Reuse it on transport retries.',
        },
      },
    },
  };
}

export function commandFingerprint(args) {
  const canonical = JSON.stringify(args, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
      : value);
  return createHash('sha256').update(canonical).digest('base64url');
}

export function commandJournal() {
  const operations = new Map();
  const replies = new Map();
  function lookup(id, fingerprint) {
    const operation = operations.get(id);
    if (!operation) return;
    if (operation.fingerprint !== fingerprint) {
      return commandError('This operationId is already bound to different arguments. Use the original arguments to check its result.');
    }
    if (operation.pending) return commandError('Command is in progress. Check again with the same operationId and arguments.');
    const saved = replies.get(id);
    return saved ? JSON.parse(saved) : commandError('Command was already sent and its reply is unavailable. Inspect the original device before starting another operation.');
  }
  return {
    lookup,
    async run(id, fingerprint, dispatch) {
      const duplicate = lookup(id, fingerprint);
      if (duplicate) return duplicate;
      if (operations.size >= maxOperations) {
        return commandError('Command history is full. This command was not dispatched. Restart the Nodrelay adapter and open a new workspace.');
      }
      const operation = { fingerprint, pending: true };
      operations.set(id, operation);
      try {
        const response = await dispatch();
        const saved = JSON.stringify(response);
        if (Buffer.byteLength(saved) <= maxReplyBytes) {
          if (replies.size >= maxCachedReplies) replies.delete(replies.keys().next().value);
          replies.set(id, saved);
        }
        return response;
      } finally {
        operation.pending = false;
      }
    },
  };
}
