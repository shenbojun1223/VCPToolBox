import { vi } from "vitest";

interface ElementOptions {
  dataset?: Record<string, string>;
  rect?: Partial<DOMRect>;
}

/** Small DOM fixture: geometry/selectors are explicit; no production reorder logic is mocked. */
class MockHTMLElement {
  dataset: Record<string, string>;
  style: Record<string, string> = {};
  private closestElements = new Map<string, MockHTMLElement | null>();
  private queryResults = new Map<string, MockHTMLElement[]>();
  private captured = new Set<number>();
  private rect: DOMRect;

  constructor(options: ElementOptions = {}) {
    this.dataset = { ...options.dataset };
    const { top = 0, left = 0, width = 100, height = 20 } = options.rect ?? {};
    this.rect = {
      top, left, width, height, x: left, y: top,
      right: left + width, bottom: top + height,
      toJSON: () => ({ top, left, width, height }),
    };
  }
  setClosest(selector: string, element: MockHTMLElement | null): this {
    this.closestElements.set(selector, element);
    return this;
  }
  closest(selector: string): MockHTMLElement | null {
    return this.closestElements.get(selector) ?? null;
  }
  setQuerySelectorAll(selector: string, elements: MockHTMLElement[]): this {
    this.queryResults.set(selector, [...elements]);
    return this;
  }
  querySelectorAll(selector: string): MockHTMLElement[] {
    return [...(this.queryResults.get(selector) ?? [])];
  }
  getBoundingClientRect(): DOMRect { return { ...this.rect }; }
  setPointerCapture = vi.fn((id: number) => { this.captured.add(id); });
  hasPointerCapture = vi.fn((id: number) => this.captured.has(id));
  releasePointerCapture = vi.fn((id: number) => { this.captured.delete(id); });
}

export function createMockHTMLElement(options: ElementOptions = {}): MockHTMLElement {
  return new MockHTMLElement(options);
}

function createEventTargetMock() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    addEventListener: vi.fn((name: string, listener: (event: unknown) => void, _options?: unknown) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
    }),
    removeEventListener: vi.fn((name: string, listener: (event: unknown) => void) => {
      listeners.get(name)?.delete(listener);
    }),
    dispatch(name: string, event: unknown = {}) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(event);
    },
    listenerCount(name: string): number { return listeners.get(name)?.size ?? 0; },
  };
}

export function installPointerDomTestGlobals(
  elementFromPoint: (x: number, y: number) => unknown = () => null
) {
  const windowMock = createEventTargetMock();
  const documentMock = {
    ...createEventTargetMock(),
    visibilityState: "visible",
    elementFromPoint: vi.fn(elementFromPoint),
  };
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  let timestamp = 0;
  const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextId;
    frames.set(id, callback);
    return id;
  });
  const cancelAnimationFrameMock = vi.fn((id: number) => { frames.delete(id); });
  vi.stubGlobal("Element", MockHTMLElement);
  vi.stubGlobal("HTMLElement", MockHTMLElement);
  vi.stubGlobal("window", windowMock);
  vi.stubGlobal("document", documentMock);
  vi.stubGlobal("requestAnimationFrame", requestAnimationFrameMock);
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrameMock);
  return {
    windowMock, documentMock, requestAnimationFrameMock, cancelAnimationFrameMock,
    pendingFrames: () => frames.size,
    // RAF is queued, never synchronous; each call advances exactly one browser frame.
    flushAnimationFrame() {
      const pending = [...frames.keys()];
      timestamp += 16;
      for (const id of pending) {
        const callback = frames.get(id);
        if (!callback) continue;
        frames.delete(id);
        callback(timestamp);
      }
    },
  };
}