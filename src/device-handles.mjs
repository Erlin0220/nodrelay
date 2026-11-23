import { createHmac, timingSafeEqual } from 'node:crypto';

function proof(secret, ...fields) {
  return createHmac('sha256', secret).update(JSON.stringify(fields)).digest('base64url');
}

function matches(expected, actual) {
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

export function workspaceId(secret, handle) {
  const match = typeof handle === 'string' && /^w([A-Za-z0-9_-]{1,342})\.([A-Za-z0-9_-]{43})$/.exec(handle);
  if (!match || !matches(proof(secret, 'workspace', match[1]), match[2])) return;
  return Buffer.from(match[1], 'base64url').toString('utf8');
}

export function workspaceResult(secret, result) {
  if (result.isError) return result;
  const raw = result.structuredContent?.workspaceId;
  if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw) > 256) {
    throw new Error('Invalid upstream workspace identifier');
  }
  const encoded = Buffer.from(raw).toString('base64url');
  const handle = `w${encoded}.${proof(secret, 'workspace', encoded)}`;
  const replace = value => value.replaceAll(raw, handle);
  const { instruction } = result.structuredContent;
  return {
    ...result,
    content: result.content.map(block => block.type === 'text' ? { ...block, text: replace(block.text) } : block),
    structuredContent: {
      ...result.structuredContent, workspaceId: handle,
      ...(typeof instruction === 'string' && { instruction: replace(instruction) }),
    },
  };
}

export function processId(secret, workspaceId, handle) {
  const match = typeof handle === 'string' && /^p([1-9]\d{0,15})\.([\w-]{43})$/.exec(handle);
  if (!match || typeof workspaceId !== 'string') return;
  const id = Number(match[1]);
  if (Number.isSafeInteger(id) && matches(proof(secret, 'process', workspaceId, id), match[2])) {
    return id;
  }
}

export function processResult(secret, workspaceId, result, expectedId) {
  if (result.isError) return result;
  const structured = result.structuredContent;
  const id = structured?.sessionId;
  if (id === undefined && structured?.running !== true) return result;
  if (!Number.isSafeInteger(id) || id < 1 || (expectedId !== undefined && id !== expectedId)) {
    throw new Error('Invalid upstream process identifier');
  }
  const sessionId = `p${id}.${proof(secret, 'process', workspaceId, id)}`;
  const footer = `Process running with session ID ${id}.`;
  const replaceFooter = text => typeof text === 'string' && text.endsWith(footer)
    ? text.slice(0, -footer.length) + `Process running with session ID ${sessionId}.`
    : text;
  return {
    ...result,
    content: result.content.map(block => block.type === 'text' ? { ...block, text: replaceFooter(block.text) } : block),
    structuredContent: { ...structured, sessionId, result: replaceFooter(structured.result) },
  };
}

export function processSchema(tool) {
  if (!['exec_command', 'write_stdin'].includes(tool.name)) return tool;
  const sessionId = { type: 'string', description: 'Process handle bound to the original device, workspace and connection.' };
  const update = schema => ({ ...schema, properties: { ...schema.properties, sessionId } });
  return {
    ...tool,
    ...(tool.name === 'write_stdin' && { inputSchema: update(tool.inputSchema) }),
    ...(tool.outputSchema && { outputSchema: update(tool.outputSchema) }),
  };
}
