import { AgentError } from "../protocol-errors";
import type { RuntimeEvent } from "../session/session-events";

/** 单消费者的观察通道；执行方从不等待消费者，也不由退订触发取消。 */
export class RuntimeEventStream implements AsyncIterable<RuntimeEvent> {
  private queue: RuntimeEvent[] = [];
  private offset = 0;
  private claimed = false;
  private ended = false;
  private abandoned = false;
  private pending?: (result: IteratorResult<RuntimeEvent>) => void;

  emit(event: RuntimeEvent): void {
    if (this.ended || this.abandoned) return;
    if (this.pending) {
      const resolve = this.pending;
      this.pending = undefined;
      resolve({ done: false, value: event });
    } else {
      this.queue.push(event);
    }
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.pending) {
      const resolve = this.pending;
      this.pending = undefined;
      resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    if (this.claimed) {
      throw new AgentError("event-stream-consumed", "运行事件流只允许一个消费者。");
    }
    this.claimed = true;
    return {
      next: () => {
        if (this.offset < this.queue.length) {
          const value = this.queue[this.offset++];
          if (this.offset === this.queue.length) {
            this.queue = [];
            this.offset = 0;
          }
          return Promise.resolve({ done: false, value });
        }
        if (this.ended || this.abandoned) {
          return Promise.resolve({ done: true, value: undefined });
        }
        if (this.pending) {
          return Promise.reject(new AgentError("event-stream-busy", "不能并发读取运行事件。"));
        }
        const { promise, resolve } = Promise.withResolvers<IteratorResult<RuntimeEvent>>();
        this.pending = resolve;
        return promise;
      },
      return: () => {
        this.abandoned = true;
        this.queue = [];
        this.offset = 0;
        if (this.pending) {
          const resolve = this.pending;
          this.pending = undefined;
          resolve({ done: true, value: undefined });
        }
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}
