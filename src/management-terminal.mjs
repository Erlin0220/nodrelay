import { stdin, stdout } from 'node:process';
import { stripVTControlCharacters, styleText } from 'node:util';
import { cancel, confirm, intro, isCancel, log, note, outro, select, spinner } from '@clack/prompts';

export class InstallationCancelled extends Error {}

// Cloudflare account names are user-editable. Keep them on one line and
// avoid printing a full address when Cloudflare uses it as the account name.
export function terminalLabel(value) {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, email => email[0] + '•••' + email.slice(email.indexOf('@')));
}

export function createManagementTerminal({ input = stdin, output = stdout } = {}) {
  const streams = { input, output };
  const answer = async prompt => {
    const value = await prompt;
    if (isCancel(value)) throw new InstallationCancelled();
    return value;
  };
  return {
    intro(title) { intro(styleText(['bgCyan', 'black', 'bold'], ` ${title} `, { stream: output }), streams); },
    step(number, title) { log.step(styleText('bold', `${number}/4  ${title}`, { stream: output }), streams); },
    info(message) { log.info(message, streams); },
    success(message) { log.success(message, streams); },
    error(message) { log.error(message, streams); },
    note(message, title) { note(message, title, streams); },
    cancel(message = '已退出诺联安装器。') { cancel(message, streams); },
    finish(message) { outro(message, streams); },
    confirm(message, action, initialValue = true) {
      return answer(confirm({
        ...streams, message: `${message}（←/→ 移动 · 回车确认）`,
        active: action, inactive: '取消', initialValue, vertical: false,
      }));
    },
    select(message, options, initialValue) {
      return answer(select({
        ...streams, message: `${message}（↑/↓ 移动 · 回车确认）`,
        options, initialValue, showInstructions: false,
      }));
    },
    async wait(message, completed, run) {
      const controller = new AbortController();
      const progress = spinner({
        output, indicator: 'timer', cancelMessage: '等待已中止',
        onCancel: () => controller.abort(new InstallationCancelled()),
      });
      progress.start(message);
      try {
        const result = await run(controller.signal, message => progress.message(message));
        controller.signal.throwIfAborted();
        progress.stop(completed);
        return result;
      } catch (error) {
        progress.clear();
        controller.signal.throwIfAborted();
        throw error;
      }
    },
  };
}
