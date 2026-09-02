import { MarkdownRenderable, ScrollBoxRenderable, SyntaxStyle, TextRenderable, type CliRenderer } from '@opentui/core';
import type { ChatMessage, ToolCall } from '../../core/model.ts';
import { compactData } from '../format.ts';
import { theme } from '../theme.ts';

export interface ChatWidget {
  readonly root: ScrollBoxRenderable;
  appendMessage(message: ChatMessage): void;
  appendTool(call: ToolCall, ok: boolean, result?: unknown): void;
  appendMarker(text: string): void;
  clear(): void;
}

export function createChatWidget(renderer: CliRenderer, title: string): ChatWidget {
  const syntaxStyle = SyntaxStyle.fromStyles({
    heading: { fg: theme.teal, bold: true },
    strong: { fg: theme.paper, bold: true },
    em: { fg: theme.paperMuted, italic: true },
    code: { fg: theme.warning },
    link: { fg: theme.command, underline: true },
  });
  const root = new ScrollBoxRenderable(renderer, {
    width: '100%', height: '100%', border: true, borderColor: theme.border, title, titleColor: theme.teal,
    stickyScroll: true, stickyStart: 'bottom', scrollY: true, contentOptions: { flexDirection: 'column' }, focusable: true,
    onKeyDown(key) {
      if (key.name === 'end') { root.stickyScroll = true; root.scrollTo(Number.MAX_SAFE_INTEGER); key.preventDefault(); }
      else if (key.name === 'home') { root.stickyScroll = false; root.scrollTo(0); key.preventDefault(); }
      else if (key.name === 'pageup') { root.stickyScroll = false; root.scrollBy(-10); key.preventDefault(); }
      else if (key.name === 'pagedown') { root.scrollBy(10); key.preventDefault(); }
    },
  });
  const children: Array<TextRenderable | MarkdownRenderable> = [];
  const add = (child: TextRenderable | MarkdownRenderable): void => {
    children.push(child);
    root.add(child);
    if (children.length > 2_000) {
      const removed = children.splice(0, children.length - 2_000);
      for (const item of removed) { root.remove(item); item.destroy(); }
    }
  };
  return {
    root,
    appendMessage(message) {
      if (message.role === 'assistant') {
        if (message.content) add(new MarkdownRenderable(renderer, { content: message.content, syntaxStyle, streaming: false, fg: theme.paper, width: '100%' }));
        for (const call of message.toolCalls ?? []) this.appendMarker(`⚙ ${call.name} ${compactData(call.arguments, 120)}`);
      } else {
        const prefix = message.role === 'user' ? 'you › ' : message.role === 'tool' ? 'tool › ' : 'system › ';
        add(new TextRenderable(renderer, { content: `${prefix}${message.content}`, fg: message.role === 'user' ? theme.teal : theme.paperMuted, width: '100%', wrapMode: 'word' }));
      }
    },
    appendTool(call, ok, result) {
      add(new TextRenderable(renderer, { content: `⚙ ${call.name} ${compactData(call.arguments, 120)} ${ok ? '✓' : '✗'}${result === undefined ? '' : ` ${compactData(result, 80)}`}`, fg: ok ? theme.paperMuted : theme.damage, width: '100%', height: 1, truncate: true }));
    },
    appendMarker(text) { add(new TextRenderable(renderer, { content: text, fg: theme.paperMuted, width: '100%', height: 1, truncate: true })); },
    clear() { for (const child of children.splice(0)) { root.remove(child); child.destroy(); } },
  };
}
